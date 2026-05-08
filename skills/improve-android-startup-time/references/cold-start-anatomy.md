# Cold-Start Anatomy

Load this for first-time startup-time investigations. It explains
where cold-start time goes so you can decide which other reference
to load next.

## The four phases

A cold start runs serially through:

```
1. Process fork from zygote        ~50–150 ms (system-controlled)
2. ContentProvider.onCreate × N    serial, all declared providers
3. Application.onCreate            single call, your code
4. First activity onCreate → first frame drawn   user-perceived
```

Vitals' `slowStartRate(COLD)` measures end-to-end (1+2+3+4). You
optimize 2, 3, and 4. Phase 1 is fixed.

## Where time typically goes

For a moderately-sized commercial app on a mid-tier device:

| Phase | Typical time | Where the time goes |
|---|---|---|
| Process fork | 50–150 ms | OS controls this. You can't reduce it. |
| `ContentProvider.onCreate` ×N | 100–500 ms | Each declared provider runs in series. Firebase, WorkManager, Profile-Installer, Lifecycle, etc. |
| `Application.onCreate` | 200–1500 ms | DI graph build, eager SDK init, encrypted-prefs migrations, analytics start. |
| First activity → first frame | 200–1000 ms | Layout inflation, theme application, splash exit animation, first data load if blocking. |

Total budget for "fast" cold start: **< 1 second** on a Pixel 4a-ish
device. Vitals' "slow" threshold is **5 seconds**.

## Decide which reference to load

Run a single Macrobenchmark or `am start -W` capture (see
[startup-profiling.md](startup-profiling.md)) and look at the
breakdown. Then:

| Dominant phase | Load |
|---|---|
| `ContentProvider.onCreate` × N (lots of `<provider>` entries in the manifest) | [contentprovider-audit.md](contentprovider-audit.md) |
| `Application.onCreate` (your code) | See "Application.onCreate is heavy" below — it overlaps with [../../improve-android-anr/references/startup-init.md](../../improve-android-anr/references/startup-init.md) |
| First activity → first frame | See "First activity slow" below |
| You haven't installed a Baseline Profile yet | [baseline-profiles.md](baseline-profiles.md) is the highest-leverage fix regardless of the phase split |

## Application.onCreate is heavy

Typical offenders, in order of frequency:
- **Hilt graph construction** with `@Singleton` providers that do disk
  reads in their constructors.
- **Encrypted `SharedPreferences` migration** on first launch.
- **Analytics SDK init** (Adjust, Branch, Sentry, Firebase
  Analytics start session).
- **Crashlytics + Performance Monitoring** setup chains.
- **Synchronous feature-flag init** (Firebase Remote Config
  `fetchAndActivate()`).

Move all non-critical work behind:
- `androidx.startup.Initializer` with deferrable dependencies, OR
- A `OneTimeWorkRequest` enqueued from `onCreate`, OR
- The first user-visible frame: hook
  `Activity.window.decorView.viewTreeObserver.addOnDrawListener`.

Convert `inject {}` / `lazy {}` chains into properly lazy graphs;
audit `@Singleton` providers that touch I/O in their constructors.

For details, this overlaps with the ANR startup reference at
[../../improve-android-anr/references/startup-init.md](../../improve-android-anr/references/startup-init.md).

## First activity slow

- **Deep layout hierarchy** in the launcher activity. Replace nested
  `LinearLayout` chains with `ConstraintLayout`.
- **`ViewStub` for off-critical-path content**.
- **Splash screen blocking work**. Android 12+ `SplashScreen` API
  must not do blocking work in the splash exit animation
  (`setOnExitAnimationListener`).
- **`runBlocking` / `Thread.sleep` in the launch path** — never.
- **Synchronous data load before first frame** — use a placeholder
  state while loading.

## Baseline Profile is the universal win

Even after fixing phases 2–4, an installed Baseline Profile shaves
a further 10–30 % off cold start by AOT-compiling the launch path.
If the user doesn't have one, recommend it as priority 1 — see
[baseline-profiles.md](baseline-profiles.md).
