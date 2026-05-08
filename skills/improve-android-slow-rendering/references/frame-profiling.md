# Frame Profiling

Load this when:
- The user wants to confirm a jank fix locally before shipping.
- The user wants telemetry to catch regressions before they hit
  production.
- You need to attribute frame time to a specific stage (measure,
  layout, draw, GPU).

## 1. `dumpsys gfxinfo` — quick CLI check

```bash
adb shell dumpsys gfxinfo <pkg> reset      # zero counters
# … exercise the affected screen on the device …
adb shell dumpsys gfxinfo <pkg> framestats
```

Look at:
- **Janky frames** percentage — if > 25 % matches your Vitals signal.
- **Profile data in ms** histogram — bumps in the higher buckets
  (16ms+, 33ms+) indicate slow draw passes.
- **HWUI** counters — high "Sync & upload time" suggests bitmap
  upload pressure (load
  [image-pipeline.md](image-pipeline.md)).

This is the fastest A/B test: capture before, ship a candidate fix,
capture after, compare.

## 2. Macrobenchmark with `FrameTimingMetric`

Add a Macrobenchmark module if the project doesn't have one:

```kotlin
@RunWith(AndroidJUnit4::class)
class FeedScrollBenchmark {
  @get:Rule val rule = MacrobenchmarkRule()

  @Test fun feedScroll() = rule.measureRepeated(
    packageName = "com.example",
    metrics = listOf(
      FrameTimingMetric(),
    ),
    iterations = 10,
    startupMode = StartupMode.WARM,
  ) {
    startActivityAndWait()
    val list = device.findObject(By.res("com.example", "feed_list"))
    list.fling(Direction.DOWN)
    device.waitForIdle()
  }
}
```

`FrameTimingMetric` reports `frameDurationCpuMs` and
`frameOverrunMs` percentiles (50, 95, 99). Lock in CI gates:
- `frameDurationCpuMs P99 < 16` (60 fps) — strong target.
- `frameDurationCpuMs P99 < 33` (30 fps) — minimum.
- `frameOverrunMs P99 ≤ 0` — frames don't miss vsync.

## 3. `Choreographer` instrumentation for production telemetry

For ongoing production monitoring of critical screens:

```kotlin
class FrameTracker {
  private val callback = object : Choreographer.FrameCallback {
    private var last = 0L
    override fun doFrame(frameTimeNanos: Long) {
      if (last != 0L) {
        val deltaMs = (frameTimeNanos - last) / 1_000_000
        if (deltaMs > 33) reportSlowFrame(deltaMs)
      }
      last = frameTimeNanos
      Choreographer.getInstance().postFrameCallback(this)
    }
  }
  fun start() = Choreographer.getInstance().postFrameCallback(callback)
  fun stop() = Choreographer.getInstance().removeFrameCallback(callback)
}
```

Hook to the `Lifecycle` of the screen you care about, send
`reportSlowFrame` to Firebase Performance / your analytics. This
gives per-screen jank attribution that Play Console doesn't.

## 4. Perfetto / system trace

For a frame budget overrun whose cause is unclear:

```bash
adb shell perfetto -o /data/misc/perfetto-traces/trace.pftrace -t 30s \
  --buffer 64mb sched freq idle am wm gfx view binder_driver
adb pull /data/misc/perfetto-traces/trace.pftrace
```

Open at <https://ui.perfetto.dev/>. Find the process row, expand
to see the main thread + render thread. Slow frames show as red bars
in the "Frames" track. Click into one to see what was running on
each thread during the budget.

The `android_jank_cuj` SQL metric (Critical User Journey) is the
official Google tooling for measuring jank on a named flow — wrap
the flow with `Trace.beginAsyncSection("MyJourney", 0)` /
`Trace.endAsyncSection("MyJourney", 0)` and the metric reports
end-to-end jank for it.

## 5. Compose-specific profiling

Layout Inspector's "Recomposition counts" overlay (covered in
[compose-jank.md](compose-jank.md)). For deeper attribution:

- `androidx.compose.runtime:runtime-tracing` — emits trace sections
  per composable, visible in Perfetto.
- Compose Compiler reports — see
  [compose-jank.md](compose-jank.md).

## 6. CI integration

Wire your Macrobenchmark module to CI:
- Run on at least one **low-end physical device** (Pixel 2 / 4a /
  similar). Emulators give noisy results.
- Run on `main` branch nightly for trend tracking.
- Run on PRs as required check, with a tolerance band — `± 10 %` is
  reasonable to absorb device noise without missing real
  regressions.

After shipping a fix:
- Compare local before/after Macrobenchmark numbers — expect a
  measurable p99 improvement.
- 24 h post-rollout, re-call `get_slow_rendering_metrics(days=3)`
  and confirm the new `versionCode`'s 20fps + 30fps rates dropped.
