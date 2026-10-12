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

The response is a compact summary. **All rates are percentages.**
- `overall` — app-wide figures. Lead with these.
- `breakdown.groups` — the top groups (one per `versionCode` by default),
  ranked by `avgDailyUsers`; `groupsTotal` says how many exist.

Each entry carries `latest` (most recent day) and `windowAvg` (daily rate
averaged over the window, weighted by users) for:
- `userPerceivedAnrRate` — ANRs of the "Input dispatching" type, i.e. the
  app ignored user input. **Play's thresholds apply to this metric.**
- `userPerceivedAnrRate7dUserWeighted` / `…28dUserWeighted` — Play's
  rolling averages (in `latest` only).
- `anrRate` — every ANR, including broadcast / service timeouts.
- `avgDailyUsers` — average daily distinct users (rounded by Google).

Drill down with arguments instead of re-reading raw data:
- `dimensions=["versionCode","apiLevel"]` — OS-specific regressions per build.
- `versionCodes=["<latest>","<previous>"]` — compare specific builds.
- `dimensions=["deviceModel"]` — per-device hotspots (the 8 % bar below).
- `format="raw"` returns every daily row as fractions (0–1). It is large;
  use it only to debug.

If the call fails: same diagnosis as crash-rate — verify
`GOOGLE_APPLICATION_CREDENTIALS` and Play Console permissions before
assuming a code problem.

## Step 2 — Interpret thresholds

Google Play's bad-behavior thresholds apply to the **user-perceived** ANR
rate. Above them, Play may reduce the app's visibility.

| Scope                                  | Bad-behavior threshold |
|----------------------------------------|------------------------|
| Overall (average across all devices)   | `≥ 0.47 %`             |
| Any single phone model                 | `≥ 8 %`                |

Reading the response:
- **Quote `overall.latest.userPerceivedAnrRate7dUserWeighted` and
  `…28dUserWeighted` first**, against 0.47 %. Never compare plain
  `anrRate` to these thresholds.
- Compare `breakdown.groups` by `versionCode` to find the build that
  stepped up.
- `anrRate` well above `userPerceivedAnrRate` ⇒ many non-input ANRs
  (`BroadcastReceiver` / `Service` timeouts) — point at
  `receivers-services.md`.
- A spike that clusters on one `apiLevel` (re-query with
  `dimensions=["versionCode","apiLevel"]`) likely reflects a behavior
  change on that OS version.
- If only weekend windows spike, suspect a feature only used heavily
  off-hours (run different `days` windows to confirm).

### Find the ANRs behind the rate

```
search_error_issues(type="ANR", userPerceivedOnly=true, versionCodes=["<worst>"])
```

Each issue has an `issueId`, `cause` and `location` (read both — the API
can return them the other way round from Google's docs: one holds the ANR
type such as "Input dispatching timed out", the other the blocking frame
or activity), affected users and their share, and Google's own insight
annotations when it has them. Pull the ANR dump for the top issues:

```
get_error_reports(issueId="<issueId>", limit=3)
```

The `"main"` thread's stack in the dump shows where it blocked. Dumps are
long; raise `maxChars` if the main thread is cut off.

ANRs are almost always main-thread blocking. The reference you load
depends on *where* the block happens.

## Step 3 — Remediate

| Suspect surface | Reference |
|---|---|
| `Application.onCreate` / `ContentProvider.onCreate` is heavy | [references/startup-init.md](references/startup-init.md) |
| Synchronous I/O on the UI thread (Activity/Fragment lifecycle, prefs, Room) | [references/main-thread-io.md](references/main-thread-io.md) |
| `BroadcastReceiver.onReceive` or `Service` runs too long | [references/receivers-services.md](references/receivers-services.md) |
| Confirming a fix, repro-ing locally, or reading ANR exit-info traces | [references/profiling.md](references/profiling.md) |

Read **only** the reference that matches the suspected surface — the
main-thread stack from `get_error_reports` usually tells you which. If
it doesn't, start with `profiling.md` to read the trace, *then* load
the surface-specific reference.

## Step 4 — Verify the fix

1. Wait ~24 h after rolling out (the MCP already accounts for the 2-day
   API delay).
2. Re-call `get_anr_metrics(days=3, versionCodes=["<new>","<previous>"])`.
3. Expect the new `versionCode`'s `userPerceivedAnrRate` below 0.47 %. The
   7d / 28d averages lag — they only settle once the new build dominates.
4. If you added Macrobenchmark coverage, lock in the result as the new
   baseline so the next regression fails CI.

## Output format

1. **Headline** — overall `userPerceivedAnrRate7dUserWeighted` /
   `…28dUserWeighted` against the 0.47 % bar, plus the worst `versionCode`.
2. **Evidence** — table: `versionCode | apiLevel | userPerceivedAnrRate |
   anrRate | avgDailyUsers`.
3. **Top issues** — `issueId | ANR type | blocking frame | users (share)`
   for the top 3.
4. **Diagnosis** — which reference you loaded and why.
5. **Action items** — 2–4 concrete steps, ideally including one CI /
   profiling lock-in.
