# Startup Initialization Playbook (ANR)

Load this when an ANR is happening on cold start, or a Crashlytics ANR
exit-info trace shows the main thread blocked inside
`Application.onCreate`, `ContentProvider.onCreate`, or any of their
transitive callers.

## 1. List eager initializers

Run in the project root:

```bash
rg -n 'override fun onCreate\(\)' app/src/main --type kotlin
./gradlew :app:processDebugManifest
rg '<provider ' app/build/intermediates/merged_manifest/debug/AndroidManifest.xml
```

For each line, ask: does this run on every cold start? If yes, it's a
suspect.

Common eager culprits:
- `Firebase.initializeApp(...)` — fast in isolation, but each Firebase
  product (Crashlytics, Performance, Analytics) bolts on more work.
- `WorkManager.initialize(this, configuration)` — if eagerly called.
- Hilt graph build (`@HiltAndroidApp` triggers it). Check that
  `@Singleton` providers don't do disk reads in their constructors.
- Encrypted `SharedPreferences` migrations or first-launch reads.
- Analytics SDKs (Adjust, Branch, AppsFlyer, Sentry, etc.) — their
  init typically reads device IDs and writes to disk.

## 2. Migrate to `androidx.startup`

The `androidx.startup` library funnels every initializer through a
single `InitializationProvider`, eliminating the per-SDK
`ContentProvider` tax (each declared provider runs serially before
`Application.onCreate`).

Migration sketch:

```kotlin
class FirebaseInitializer : Initializer<Unit> {
  override fun create(context: Context) {
    Firebase.initializeApp(context)
  }
  override fun dependencies(): List<Class<out Initializer<*>>> = emptyList()
}
```

In the manifest:

```xml
<provider
    android:name="androidx.startup.InitializationProvider"
    android:authorities="${applicationId}.androidx-startup"
    android:exported="false"
    tools:node="merge">
  <meta-data
      android:name="com.example.FirebaseInitializer"
      android:value="androidx.startup" />
</provider>
```

Use `dependencies()` to express ordering — e.g. an analytics initializer
that depends on Firebase being ready.

## 3. Defer non-critical work

Anything that doesn't have to run before the first frame should defer.
Three deferral patterns in increasing strength:

1. **First-frame deferral** — schedule from
   `Activity.window.decorView.viewTreeObserver.addOnDrawListener { ... }`
   to run after the user sees pixels.
2. **Idle deferral** — use `Looper.myQueue().addIdleHandler { ... }` to
   run when the main looper has no more messages.
3. **Background deferral** — enqueue a `OneTimeWorkRequest` from
   `Application.onCreate`. The work runs on a worker thread soon after,
   without blocking startup.

Concretely, things to defer:
- Analytics session start.
- Non-blocking feature-flag refreshes.
- Cache warmups.
- Pre-fetching for screens the user hasn't navigated to yet.

## 4. Lazy DI

Hilt / Dagger graphs are eager by default. Audit `@Singleton` providers
that touch I/O:

```kotlin
@Provides @Singleton
fun provideUserStore(@ApplicationContext context: Context): UserStore =
  UserStore(context)  // does this read disk in its constructor?
```

If yes, wrap with `dagger.Lazy<UserStore>` (Java) or
`Provider<UserStore>` and resolve only when first needed. This moves
the disk read off the startup critical path.

## 5. Replace `runBlocking` in startup paths

Search for it:
```bash
rg -n 'runBlocking' app/src/main --type kotlin
```

Every `runBlocking` on the main thread is an ANR waiting to happen.
Replacements:

- If the caller is `Application.onCreate` and the work is genuinely
  required before the first activity, restructure: kick off the work
  asynchronously, gate UI on a `StateFlow` instead of blocking.
- If the work is a pre-warm cache, move to a `OneTimeWorkRequest`.
- If the caller has a `LifecycleOwner`, use `lifecycleScope.launch`.

## 6. Verify

After deploying:
- `get_anr_metrics(days=3, versionCodes=["<new>"])` should show the new
  `versionCode`'s `userPerceivedAnrRate < 0.47 %`.
- Macrobenchmark with `StartupMode.COLD` should show TTID improved (or
  at least not regressed).
- Locally, run `adb shell am start -W -S <pkg>/<.LauncherActivity>`
  five times and confirm `TotalTime` is stable and well under 5 s.
