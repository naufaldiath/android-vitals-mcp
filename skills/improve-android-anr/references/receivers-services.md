# Broadcast Receivers & Services Playbook (ANR)

Load this when ANRs come from `BroadcastReceiver.onReceive` or a
`Service` callback. The Android system gives:

| Component | Time budget on main thread |
|---|---|
| `BroadcastReceiver.onReceive` | 10 s |
| `Service.onStartCommand` (foreground or background) | 20 s |
| `JobService.onStartJob` | runs on main; should return immediately |

Exceeding the budget crashes as an ANR. The fix is almost always
"defer the work to a background scheduler."

## 1. Identify the receiver / service

In the merged manifest:
```bash
./gradlew :app:processDebugManifest
rg '<receiver |<service ' app/build/intermediates/merged_manifest/debug/AndroidManifest.xml
```

Match the manifest entries to the ANR exit-info trace. The trace will
show the main thread inside the receiver / service callback.

## 2. Migrate broadcast work to WorkManager

The pattern: `onReceive` should validate the broadcast and enqueue
work, nothing more.

```kotlin
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    val request = OneTimeWorkRequestBuilder<RescheduleAlarmsWorker>().build()
    WorkManager.getInstance(context).enqueueUniqueWork(
      "reschedule-alarms", ExistingWorkPolicy.REPLACE, request
    )
  }
}
```

The `Worker` class does the actual work on a background thread. If
the work needs to keep the device awake (e.g. sync), use
`CoroutineWorker` and respect `isStopped` cancellation.

## 3. Migrate `Service` work

Two cases:

### A) The work doesn't need a long-running service
Use `WorkManager` with constraints. This is the right answer for
sync, cleanup, periodic tasks, etc.

### B) The work needs a foreground service (audio playback,
location tracking, ongoing call)
- Keep the `Service`, but make `onStartCommand` return immediately.
- Move the actual work into a coroutine launched in
  `lifecycleScope` (use `LifecycleService`) or a worker thread.
- For Android 14 (API 34) and above: declare an explicit
  `foregroundServiceType` in the manifest, and the corresponding
  permission. Wrong type ⇒ `MissingForegroundServiceTypeException`.
- For Android 14: foreground services started from background are
  restricted; review the
  [allowed start reasons](https://developer.android.com/about/versions/14/changes/fgs-types-required).

## 4. JobScheduler fallback

If the user is on `minSdk < 23` and can't use WorkManager (very
unusual today), `JobScheduler` is the next best thing for system-event
deferral. WorkManager wraps it on API ≥ 23 — most teams should just
use WorkManager.

## 5. Common foot-guns

- **Synchronous Firebase calls in `onReceive`** — `getInstance().get()`
  blocks. Use `addOnCompleteListener` or convert to coroutines via
  `await()` and run inside a Worker.
- **Retrofit `.execute()` in `onReceive`** — synchronous network call.
  Use suspending Retrofit + `CoroutineWorker`.
- **Database writes in `onReceive`** — Room blocks on the main thread
  unless the DAO is `suspend`. Move to a Worker.
- **`Service.onCreate` doing eager init** — same anti-pattern as
  `Application.onCreate`. See
  [startup-init.md](startup-init.md).

## 6. Verify

- Reproduce locally: send the broadcast manually with `adb shell am
  broadcast -a <action>` and check logcat for ANR lines.
- After shipping, `get_anr_metrics(days=3, versionCodes=["<fixed>"])`
  should show the fixed `versionCode`'s `anrRate` dropping. Receiver and
  service timeouts count toward `anrRate`, not `userPerceivedAnrRate`
  (which only covers "Input dispatching" ANRs), so watch both.
- If the receiver is invoked rarely (e.g. boot), forcibly trigger the
  flow on test devices before relying on production data — Vitals
  data might take days to surface a fix on a low-volume receiver.
