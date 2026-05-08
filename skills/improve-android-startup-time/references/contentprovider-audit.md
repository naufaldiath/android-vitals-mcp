# ContentProvider Audit Playbook

Load this when cold start time is dominated by phase 2 — multiple
declared `<provider>` entries running serially before
`Application.onCreate`. Each Firebase / WorkManager / Profile-Installer
/ analytics SDK ships its own provider; on a moderately-sized app
this can be 8–15 providers.

## 1. List the providers

The merged manifest is the ground truth (it includes providers from
every dependency, not just your `app/src/main/AndroidManifest.xml`):

```bash
./gradlew :app:processDebugManifest
rg '<provider ' app/build/intermediates/merged_manifest/debug/AndroidManifest.xml
```

Also list per-AAR providers:
```bash
find ~/.gradle/caches -name AndroidManifest.xml -path '*/aars/*' \
  -exec rg -l '<provider ' {} \;
```

For each provider in the merged manifest, identify its source
library — usually clear from the `android:name` package prefix.

## 2. Time each provider

Add temporary trace markers to time them:

```kotlin
class TimedInitializationProvider : ContentProvider() {
  override fun onCreate(): Boolean {
    Trace.beginSection("MyProvider.onCreate")
    try {
      // … existing init …
    } finally {
      Trace.endSection()
    }
    return true
  }
}
```

For dependency-shipped providers you can't edit, capture a system
trace (see [startup-profiling.md](startup-profiling.md)) and
correlate provider class names against time spent.

## 3. Migrate to `androidx.startup.Initializer`

The `androidx.startup` library funnels every initializer through a
single `androidx.startup.InitializationProvider`, eliminating the
per-SDK provider tax. This alone often saves 200–400 ms on cold
start for app with many SDKs.

Add the dependency:
```kotlin
implementation("androidx.startup:startup-runtime:1.2.0")
```

For each library that supports `androidx.startup` natively:
- WorkManager (since 2.6) — drop its provider, add an
  `androidx.work.WorkManagerInitializer` meta-data entry.
- Profile Installer — already uses `androidx.startup`.
- Firebase libraries — partial support; check their
  release notes.

For libraries that don't support `androidx.startup`, write your own
initializer:

```kotlin
class FirebaseInitializer : Initializer<Unit> {
  override fun create(context: Context) {
    Firebase.initializeApp(context)
  }
  override fun dependencies(): List<Class<out Initializer<*>>> = emptyList()
}
```

Then suppress the original provider in the manifest:
```xml
<provider
    android:name="com.google.firebase.provider.FirebaseInitProvider"
    android:authorities="${applicationId}.firebaseinitprovider"
    tools:node="remove" />
```

…and register your initializer:
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

## 4. Order with `dependencies()`

If initializers must run in a specific order, declare it:

```kotlin
class AnalyticsInitializer : Initializer<Unit> {
  override fun create(context: Context) { /* needs Firebase ready */ }
  override fun dependencies() = listOf(FirebaseInitializer::class.java)
}
```

The `androidx.startup` runtime topologically sorts initializers and
runs each exactly once.

## 5. Lazy initialization

Some initializers don't need to run on cold start at all — they just
need to run before some specific user action. For those:

```kotlin
// Before: registered in androidx.startup, runs on cold start
// After: lazily initialize on first use
class AnalyticsManager private constructor(context: Context) { ... }

object Analytics {
  private var instance: AnalyticsManager? = null
  fun get(context: Context): AnalyticsManager =
    instance ?: synchronized(this) {
      instance ?: AnalyticsManager(context).also { instance = it }
    }
}
```

The init cost moves from cold start to the first call site.

## 6. Suppress unused providers

Sometimes a dependency declares a provider you don't actually
need. Suppress it:

```xml
<provider
    android:name="com.somelib.UnusedProvider"
    android:authorities="${applicationId}.somelibprovider"
    tools:node="remove" />
```

Verify in the merged manifest that it's actually gone.

## 7. Verify

After the migration:
- Re-run a Macrobenchmark cold-start capture (see
  [startup-profiling.md](startup-profiling.md)). Phase 2 (provider
  serial chain) should be visibly shorter.
- The total provider count in the merged manifest should drop —
  ideally to just `androidx.startup.InitializationProvider` plus a
  small number of unavoidable ones (e.g. `FileProvider`).
- 24 h after rollout, re-call `get_startup_time_metrics(days=3)`
  and confirm `slowStartRate(COLD)` improved on the new
  `versionCode`.
