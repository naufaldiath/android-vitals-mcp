# Main-Thread I/O Playbook (ANR)

Load this when ANRs reflect synchronous I/O on the UI thread —
typically inside `Activity.onCreate`, `Fragment.onResume`,
`onSaveInstanceState`, or `RecyclerView.onBindViewHolder`. The ANR
exit-info trace will show the main thread inside `read`, `write`,
`fsync`, `socketRead0`, or a JDBC / SQLite call.

## 1. Find the offending sites

```bash
rg -n 'SharedPreferences\b|getSharedPreferences\(' app/src/main --type kotlin
rg -n 'openFileInput|openFileOutput|readText|writeText|inputStream' app/src/main --type kotlin
rg -n 'Room\.databaseBuilder|allowMainThreadQueries|\.executeQuery\(' app/src/main --type kotlin
rg -n 'HttpURLConnection|OkHttpClient.*\.execute\(' app/src/main --type kotlin
```

For each hit:
- If the surrounding function is `suspend`, it's probably fine.
- If the surrounding function runs on the main thread (lifecycle
  callbacks, click listeners, `LiveData.observe` callbacks), it's a
  potential ANR.

## 2. Wrap with `Dispatchers.IO`

```kotlin
// Before
val token = sharedPreferences.getString("token", null)

// After
val token = withContext(Dispatchers.IO) {
  sharedPreferences.getString("token", null)
}
```

For Room: convert DAOs to `suspend` functions or `Flow`-returning
queries. The Room compiler picks the right dispatcher automatically.

For OkHttp / Retrofit: use suspending `Call`s (`suspend fun`) or wrap
the synchronous form in `withContext(Dispatchers.IO)`.

## 3. Adopt `androidx.datastore` for new code

`SharedPreferences.getAll()` is synchronous and reads the entire prefs
file from disk — a recurring ANR source on cold start.

`androidx.datastore.preferences` exposes a suspending /
`Flow<Preferences>` API that's safe to call from the main thread (the
read happens on a background dispatcher).

Migration is incremental: keep `SharedPreferences` for legacy
read-only access while writing new state to DataStore. The
[official migration helper](https://developer.android.com/topic/libraries/architecture/datastore#sharedpreferences-datastore)
copies values automatically on first launch.

## 4. Enable StrictMode in debug builds

```kotlin
if (BuildConfig.DEBUG) {
  StrictMode.setThreadPolicy(
    StrictMode.ThreadPolicy.Builder()
      .detectDiskReads()
      .detectDiskWrites()
      .detectNetwork()
      .penaltyLog()
      .build()
  )
}
```

StrictMode logs main-thread violations to logcat with full stack
traces. New regressions will show up as red flags during local
development before reaching production.

For aggressive teams: `.penaltyDeath()` makes violations crash debug
builds — fastest possible feedback.

## 5. Activity / Fragment lifecycle slowness

Specific patterns that ANR:

- `onCreate` inflating layouts for screens that aren't on the critical
  path. Use `<ViewStub>` and inflate lazily.
- `onResume` reading the entire `SharedPreferences` to restore state.
  Restore only what's needed for the visible content; defer the rest
  to `lifecycleScope.launchWhenStarted`.
- `onSaveInstanceState` serializing large objects. Use
  `onSaveInstanceState` only for primitives; persist large state via
  `ViewModel` + `SavedStateHandle`.
- `RecyclerView.onBindViewHolder` decoding bitmaps inline. Move to
  Coil/Glide and pre-size with `onCreateViewHolder`.

## 6. Verify

Before shipping:
- Run debug build with StrictMode enabled. Walk through the screens
  the ANR was reported on. Logcat must be clean of
  `StrictMode policy violation` lines.
- Macrobenchmark with `FrameTimingMetric` on the affected flow — the
  fix should reduce p99 frame time even if the median is unchanged.

After 24 h, re-check `get_anr_metrics(days=3)`. The fixed
`versionCode` should be back below the 0.47 % bar.
