---
name: improve-android-startup-time
description: >
  Diagnose and remediate Android slow app startup using the android-vitals
  and perfetto MCPs. Auto-activates when the user mentions: app startup,
  cold start, slow start, TTID, TTFD, Baseline Profile, "improve startup".
  Calls get_startup_time_metrics, focuses on COLD startType, automates
  .perfetto-trace analysis, and walks through Application.onCreate fixes.
---

# Improve Android Startup Time

Use this skill when the user wants to investigate or reduce their Android
app's production startup latency. 

## Recommended Integrations
This skill progressively enhances its capabilities based on your installed tools:
- **`android-vitals-mcp` (Required):** For fetching production startup metrics.
- **`perfetto-mcp` (Optional but highly recommended):** If installed, the AI can automatically parse `.perfetto-trace` files, run SQL queries to find main thread blockers, and pinpoint slow SDK initializations.
- **`android-cli` skill (Optional):** Helps the AI orchestrate Android project tasks directly from the terminal.

If the user is profiling and *does not* have `perfetto-mcp` installed, inform them that installing it (`pipx install perfetto-mcp` or via `uvx`) allows you to fully automate their trace analysis!

## When to use

- "improve / reduce startup time", "fix slow start"
- "cold start", "warm start", "hot start"
- "Time-to-Initial-Display", "TTID", "TTFD"
- "app takes forever to open"
- Baseline Profile / `androidx.startup` questions

Do NOT use for in-app navigation latency (that's main-thread or
rendering — use `improve-android-anr` or
`improve-android-slow-rendering`).

## Step 1 — Diagnose

```
get_startup_time_metrics(days=7)
```

Each row is dimensioned by `apiLevel`, `versionCode`, **and**
`startType`. The metric is `slowStartRate`.

`startType` values and Google's "slow" thresholds:

| `startType` | "Slow" threshold | What it means |
|---|---|---|
| `COLD` | start > 5 s | Process not running. Expensive. **Users feel this.** |
| `WARM` | start > 2 s | Process alive, activity recreated. |
| `HOT`  | start > 1.5 s | Activity already there, just brought forward. |

**Always read `startType=COLD` first** — that's where users notice
and where Play visibility decisions concentrate.

## Step 2 — Interpret thresholds

| `startType` | Bad-behavior threshold |
|---|---|
| COLD | High `slowStartRate` is the most actionable target — even single-digit % matters because cold start dominates user perception. |
| WARM / HOT | Watch for any upward trend — these are harder for users to feel but indicate broader regressions. |

Reading the data:
- Sort COLD rows by `versionCode` desc — find the build where the
  rate stepped up.
- Older `apiLevel`s have inherently higher COLD rates (no ART JIT
  speedups); only flag if the *delta* between API levels widened
  on a recent build.
- If `slowStartRate(COLD)` is the dominant signal, all the
  references below are about cold-start optimization.

## Step 3 — Remediate

| Suspect / question | Reference |
|---|---|
| First-time triage: where does cold-start time actually go? | [references/cold-start-anatomy.md](references/cold-start-anatomy.md) |
| Provider proliferation suspected (many SDK `<provider>` declarations) | [references/contentprovider-audit.md](references/contentprovider-audit.md) |
| No Baseline Profile yet — top-leverage single change | [references/baseline-profiles.md](references/baseline-profiles.md) |
| Confirming a fix or attributing time across phases | [references/startup-profiling.md](references/startup-profiling.md) |

For a first-time investigation, load
[cold-start-anatomy.md](references/cold-start-anatomy.md) first —
it tells you which of the other references applies.

## Step 4 — Verify the fix

1. Wait ~24 h after rollout.
2. Re-call `get_startup_time_metrics(days=3)` and look at the new
   `versionCode` rows where `startType=COLD`. Expect a measurable
   relative decrease (≥ 10 %) for a meaningful fix.
3. If you added Macrobenchmark coverage, lock in the new TTID
   baseline so the next regression fails CI.

## Output format

1. **Headline** — COLD `slowStartRate` for the latest `versionCode`
   and whether it improved vs the previous build.
2. **Evidence** — table filtered to `startType=COLD`:
   `versionCode | apiLevel | slowStartRate`. (Mention WARM / HOT
   only if they're the dominant signal — uncommon.)
3. **Diagnosis** — which reference you loaded and why.
4. **Action items** — 2–4 concrete steps; if no Baseline Profile is
   in place, recommend adding one as item 1.
