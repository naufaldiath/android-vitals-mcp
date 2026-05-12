# Startup Profiling

Load this when you need to attribute cold-start time across phases,
confirm a fix locally, or wire CI to catch regressions.

## 1. `am start -W` — quick CLI check

```bash
adb shell am force-stop <pkg>          # ensure cold start
adb shell am start -W -S <pkg>/<.LauncherActivity>
```

Output:
```
Status: ok
LaunchState: COLD
Activity: com.example/.MainActivity
TotalTime: 873
WaitTime: 891
```

- `TotalTime` is end-to-end cold-start latency.
- Repeat 5 times, take the median.
- `< 1000` is fast; `> 5000` is what Vitals counts as "slow".

This is the fastest A/B test: capture before, ship a candidate fix,
capture after, compare.

## 2. Macrobenchmark with `StartupTimingMetric`

Add (or extend) the Macrobenchmark module:

```kotlin
@RunWith(AndroidJUnit4::class)
class StartupBenchmark {
  @get:Rule val rule = MacrobenchmarkRule()

  @Test fun startupCold() = rule.measureRepeated(
    packageName = "com.example",
    metrics = listOf(
      StartupTimingMetric(),
      // Optional, requires Trace.beginSection in app code:
      TraceSectionMetric("HiltGraph"),
    ),
    iterations = 10,
    startupMode = StartupMode.COLD,
    compilationMode = CompilationMode.Partial(
      baselineProfileMode = BaselineProfileMode.Require,
    ),
  ) {
    pressHome()
    startActivityAndWait()
  }
}
```

Outputs:
- `timeToInitialDisplayMs` (TTID) — first frame.
- `timeToFullDisplayMs` (TTFD) — first usable frame, when
  `Activity.reportFullyDrawn()` is called.

Lock in CI gates against the median + p95.

## 3. Mark "fully displayed"

Without `reportFullyDrawn()`, TTFD == TTID. To get a true
"first usable frame" metric:

```kotlin
class FeedActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      val items by viewModel.items.collectAsState()
      LaunchedEffect(items.isNotEmpty()) {
        if (items.isNotEmpty()) reportFullyDrawn()
      }
      ...
    }
  }
}
```

TTFD is the metric users actually feel — TTID can be cheated by
showing an empty skeleton.

## 4. `androidx.benchmark.simpleperf` system traces

For phase-by-phase attribution:

```kotlin
@Test fun startupCold() = rule.measureRepeated(
  packageName = "com.example",
  metrics = listOf(StartupTimingMetric()),
  iterations = 5,
  startupMode = StartupMode.COLD,
  experimentalConfig = MacrobenchmarkConfig(
    traceAppTagEnabled = true,
    perfettoSdkTracingEnabled = true,
  ),
) {
  pressHome()
  startActivityAndWait()
}
```

The captured `.perfetto-trace` lands under
`app/build/outputs/connected_android_test_additional_output/…`.

## 5. Read the trace in Perfetto

### Automated Analysis (Requires `perfetto-mcp`)
If the user provides a path to a `.perfetto-trace` file and `perfetto-mcp` is available, **do not tell them to use ui.perfetto.dev**. Analyze it for them:

1. Use the `execute_sql_query` tool (or similar) to run the standard startup metric:
   ```sql
   SELECT * FROM android_startup;
   ```
2. Extract the breakdown (e.g., `to_first_application_oncreate`, `application_oncreate_delta`, `to_initial_display`) and tell the user which phase took the longest.
3. If `application_oncreate_delta` is the bottleneck, use `main_thread_hotspot_slices` or query the `slice` table to find exactly which methods (e.g., `Firebase.initializeApp`) blocked the main thread.

### Manual Analysis (Fallback)
If `perfetto-mcp` is not installed, briefly recommend installing it so you can automate this step in the future. Meanwhile, guide them to do it manually:

1. Open <https://ui.perfetto.dev/> → Open trace file → load the captured trace.
2. Use the **Metrics** panel and run:
```
android_startup
```

Returns a structured breakdown like:
```
{
  to_post_fork: 87 ms
  to_first_application_oncreate: 312 ms       ← phase 2 chain
  application_oncreate_delta: 421 ms          ← phase 3
  to_first_activity_oncreate: 58 ms
  to_initial_display: 142 ms                  ← phase 4
}
```

This tells you exactly which reference to load:

| Dominant phase | Reference |
|---|---|
| `to_first_application_oncreate` (phase 2) | [contentprovider-audit.md](contentprovider-audit.md) |
| `application_oncreate_delta` (phase 3) | [cold-start-anatomy.md](cold-start-anatomy.md) "Application.onCreate is heavy" + [../../improve-android-anr/references/startup-init.md](../../improve-android-anr/references/startup-init.md) |
| `to_initial_display` (phase 4) | [cold-start-anatomy.md](cold-start-anatomy.md) "First activity slow" |

## 6. CI — low-end device gate

Cold start is most painful on low-end devices. Run Macrobenchmark
on:
- Pixel 4a / Pixel 5 (representative mid-tier).
- A low-end device (Galaxy A12 / Moto G4 / similar) if you have
  one in your device farm.

Emulators give noisy startup numbers; do not rely on them.

Gate criteria:
- `timeToInitialDisplayMs` p99 regression `> 10 %` fails the build.
- `timeToFullDisplayMs` median regression `> 15 %` fails the build.
- The regression must reproduce across 3 runs — single-run flakes
  are common on cold start.

## 7. Continuous tracking

Wire your benchmark module to publish to Firebase Test Lab or your
internal benchmark dashboard. Track median + p95 over time. A
regression in the benchmark line + a regression in
`slowStartRate(COLD)` from the MCP is the two-source confirmation
that something real broke.

## 8. Verify the fix

After deploying:
- Local benchmark: 10 % or better improvement on
  `timeToInitialDisplayMs` for a meaningful fix.
- 24 h post-rollout: re-call
  `get_startup_time_metrics(days=3)` — expect a measurable drop
  in `slowStartRate(COLD)` on the new `versionCode`.
