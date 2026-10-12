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

The response is a compact summary. **All rates are percentages.**
- `overall` — one entry per `startType` (COLD, WARM, HOT), app-wide.
- `breakdown.groups` — the top `startType` × `versionCode` groups,
  ranked by `avgDailyUsers`; `groupsTotal` says how many exist.

Each entry carries `latest` (most recent day) and `windowAvg` (user-weighted
average over the window) for `slowStartRate` — the percentage of users who
had a slow start — plus Play's rolling `slowStartRate7dUserWeighted` /
`…28dUserWeighted` (in `latest` only) and `avgDailyUsers`.

Narrow the query instead of re-reading raw data:
- `startType="COLD"` — only cold starts (usually what you want).
- `dimensions=["versionCode","apiLevel"]` — OS-specific regressions per build.
- `versionCodes=["<latest>","<previous>"]` — compare specific builds.
- `format="raw"` returns every daily row as fractions (0–1). It is large;
  use it only to debug.

What Android vitals counts as a "slow" start:

| `startType` | "Slow" threshold | What it means |
|---|---|---|
| `COLD` | start ≥ 5 s | Process not running. Expensive. **Users feel this.** |
| `WARM` | start ≥ 2 s | Process alive, activity recreated. |
| `HOT`  | start ≥ 1.5 s | Activity already there, just brought forward. |

**Always read `startType=COLD` first** — that's where users notice.

## Step 2 — Interpret the data

Slow start is an "other" Android vitals metric, not a core vital: Google
publishes no bad-behavior percentage for `slowStartRate`. Judge it by trend
and by comparison between builds.

| `startType` | How to read it |
|---|---|
| COLD | The most actionable target — even single-digit % matters because cold start dominates user perception. |
| WARM / HOT | Watch for any upward trend — these are harder for users to feel but indicate broader regressions. A WARM rate far above COLD often means activities are recreated with heavy `onCreate` work. |

Reading the data:
- Sort COLD groups by `versionCode` desc — find the build where the
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
2. Re-call
   `get_startup_time_metrics(days=3, startType="COLD", versionCodes=["<new>","<previous>"])`.
   Expect a measurable relative decrease (≥ 10 %) for a meaningful fix.
3. If you added Macrobenchmark coverage, lock in the new TTID
   baseline so the next regression fails CI.

## Output format

1. **Headline** — COLD `slowStartRate` for the latest `versionCode`
   and whether it improved vs the previous build.
2. **Evidence** — table filtered to `startType=COLD`:
   `versionCode | apiLevel | slowStartRate | avgDailyUsers`. (Mention
   WARM / HOT only if they're the dominant signal.)
3. **Diagnosis** — which reference you loaded and why.
4. **Action items** — 2–4 concrete steps; if no Baseline Profile is
   in place, recommend adding one as item 1.
