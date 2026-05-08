---
name: improve-android-anr
description: >
  Diagnose and remediate Android ANR (Application Not Responding) regressions
  using the android-vitals MCP. Auto-activates when the user mentions: ANR,
  ANR rate, "app not responding", "input dispatcher timeout", main-thread
  freeze, "improve ANR", or asks why their app is freezing. Calls
  get_anr_metrics, interprets thresholds, identifies regressed versionCode /
  apiLevel, and walks through main-thread / lifecycle remediations.
---

# Improve Android ANR Rate

Use this skill when the user wants to investigate or reduce their Android
app's production ANR rate. It pairs with the `android-vitals-mcp` server
(env vars `GOOGLE_APPLICATION_CREDENTIALS` and `ANDROID_PACKAGE_NAME`).

## When to use

- "improve / reduce / investigate ANR(s)"
- "anr rate", "anrRate", "user-perceived ANR"
- "app not responding", "input dispatcher timeout", "main-thread freeze"
- "Play Console says we have an ANR problem"

Do NOT use for general perf complaints (use
`improve-android-slow-rendering` or `improve-android-startup-time`) or
for crashes that surface as ANRs (start with
`improve-android-crash-rate`).

## Step 1 — Diagnose

```
get_anr_metrics(days=7)
```

Each row is dimensioned by `apiLevel` and `versionCode`, with metrics:
- `anrRate` — daily user-perceived ANR rate.
- `anrRate7dUserWeighted` — 7-day user-weighted view (the metric Play
  Console actually shows).
- `distinctUsers`.

If the call fails: same diagnosis as crash-rate — verify
`GOOGLE_APPLICATION_CREDENTIALS` and Play Console permissions before
assuming a code problem.

## Step 2 — Interpret thresholds

Google Play "core technical quality" thresholds for **user-perceived ANR
rate**:

| Threshold     | Meaning                                       |
|---------------|-----------------------------------------------|
| `< 0.47 %`    | Healthy.                                      |
| `≥ 0.47 %`    | "Bad behavior" — Play may reduce visibility.  |
| `≥ 8 %`       | Core technical-quality bar failure.           |

Reading the response:
- **Quote `anrRate7dUserWeighted` first** — that's the metric Play uses
  for visibility decisions.
- Sort rows by `versionCode` desc to find the build that stepped up.
- A spike that clusters on one `apiLevel` likely reflects a behavior
  change on that OS version.
- If only weekend windows spike, suspect a feature only used heavily
  off-hours (run different `days` windows to confirm).

ANRs are almost always main-thread blocking. The reference you load
depends on *where* the block happens.

## Step 3 — Remediate

| Suspect surface | Reference |
|---|---|
| `Application.onCreate` / `ContentProvider.onCreate` is heavy | [references/startup-init.md](references/startup-init.md) |
| Synchronous I/O on the UI thread (Activity/Fragment lifecycle, prefs, Room) | [references/main-thread-io.md](references/main-thread-io.md) |
| `BroadcastReceiver.onReceive` or `Service` runs too long | [references/receivers-services.md](references/receivers-services.md) |
| Confirming a fix, repro-ing locally, or reading ANR exit-info traces | [references/profiling.md](references/profiling.md) |

Read **only** the reference that matches the suspected surface. If the
ANR exit-info trace is available, start with `profiling.md` to read
the trace, *then* load the surface-specific reference.

## Step 4 — Verify the fix

1. Wait ~24 h after rolling out (the MCP already accounts for the 2-day
   API delay).
2. Re-call `get_anr_metrics(days=3)`. Filter mentally to the fixed
   `versionCode`.
3. Expect both `anrRate` and `anrRate7dUserWeighted` below 0.47 %.
4. If you added Macrobenchmark coverage, lock in the result as the new
   baseline so the next regression fails CI.

## Output format

1. **Headline** — `anrRate7dUserWeighted` against the 0.47 % bar plus
   the worst `versionCode`.
2. **Evidence** — table: `versionCode | apiLevel | anrRate |
   anrRate7dUserWeighted | users`.
3. **Diagnosis** — which reference you loaded and why.
4. **Action items** — 2–4 concrete steps, ideally including one CI /
   profiling lock-in.
