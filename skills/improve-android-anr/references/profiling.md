# ANR Profiling & Trace Reading

Load this when:
- The user wants to reproduce an ANR locally before changing code.
- A Crashlytics ANR exit-info trace is available and you need to read
  it to decide which reference to load next.
- The user is locking in a fix in CI and needs the right metric.

## 1. Read the ANR exit-info trace

Android 11 (API 30) and later attach a per-thread stack snapshot to
every ANR. Crashlytics surfaces them under "ANRs → Issue → Stack
trace → ApplicationExitInfo".

Reading order:
1. Find the **main** thread (named `main` or with TID matching the
   process). Its top frame is where the block happened.
2. Read down the stack. The first non-framework frame is the user
   code that triggered the block — this is the line to fix.
3. Look for telltale frames:
   - `nativePollOnce` at the top + a non-framework frame below ⇒ the
     UI is idle waiting; the actual blocker is one of the worker
     threads. Read those next.
   - `Object.wait` / `LockSupport.park` ⇒ deadlock or contended lock.
   - `read` / `write` / `fsync` ⇒ disk I/O (load
     [main-thread-io.md](main-thread-io.md)).
   - `recv` / `socketRead0` ⇒ network (load
     [main-thread-io.md](main-thread-io.md)).
   - Frames inside `Application` / `ContentProvider.onCreate` ⇒
     startup init (load [startup-init.md](startup-init.md)).
   - Frames inside `BroadcastReceiver.onReceive` /
     `Service.onStartCommand` ⇒ load
     [receivers-services.md](receivers-services.md).

## 2. Reproduce locally

For startup-suspect ANRs:
```bash
adb shell am start -W -S <pkg>/<.LauncherActivity>
adb shell am start -P <pkg>           # method tracing for cold path
```

`am start -W` prints `WaitTime`, `ThisTime`, `TotalTime`. If
`TotalTime > 5000`, you've reproduced.

For specific-flow ANRs, drive the flow with `adb shell input tap …`
and watch logcat for `ANR in <pkg>` lines.

## 3. Macrobenchmark for CI

Add a Macrobenchmark module if the project doesn't have one:

```kotlin
@RunWith(AndroidJUnit4::class)
class StartupBenchmark {
  @get:Rule val rule = MacrobenchmarkRule()

  @Test fun startupCompilationFull() = rule.measureRepeated(
    packageName = "com.example",
    metrics = listOf(StartupTimingMetric()),
    iterations = 10,
    startupMode = StartupMode.COLD,
    compilationMode = CompilationMode.Full(),
  ) {
    pressHome()
    startActivityAndWait()
  }
}
```

For ANR fixes specifically:
- Use `FrameTimingMetric` if the issue surfaces during interaction
  (jank-adjacent ANRs).
- Use `TraceSectionMetric("CustomSlice")` to measure a known critical
  path the user has wrapped in `Trace.beginSection(...)`.

Wire CI to fail if the p99 regresses by > 10 %.

## 4. Perfetto / system trace

For ANRs whose cause is unclear from the exit-info trace:

```bash
adb shell perfetto -o /data/misc/perfetto-traces/trace.pftrace -t 30s \
  --buffer 64mb sched freq idle am wm gfx view binder_driver
adb pull /data/misc/perfetto-traces/trace.pftrace
```

Open `trace.pftrace` at <https://ui.perfetto.dev/>. Find the
process row, look at the "main" thread row. A long red bar (running)
with the user's package name overlaid is your blocker — its time
range tells you what was running, and a click reveals the function.

The `android_startup` and `android_anr` SQL metrics in Perfetto's
metrics panel attribute time across phases automatically.

## 5. StrictMode for prevention

In debug builds (already covered in
[main-thread-io.md](main-thread-io.md)) — enabling
`detectDiskReads()` / `detectDiskWrites()` / `detectNetwork()` with
`penaltyLog()` (or `penaltyDeath()` for the bold) catches new
violations during development.

For production, you cannot use StrictMode penalties, but you can ship
the ANR exit-info pipeline (Crashlytics has it on by default with
`firebase-crashlytics:19+`). Make sure symbol upload is enabled — see
[../../improve-android-crash-rate/references/native-crashes.md](../../improve-android-crash-rate/references/native-crashes.md).
