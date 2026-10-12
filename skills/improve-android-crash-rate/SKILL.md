---
name: improve-android-crash-rate
description: >
  Diagnose and remediate Android app crash rate regressions using the
  android-vitals MCP. Auto-activates when the user mentions: Android crash
  rate, crashRate, Play Console crashes, crash-free users, "improve crashes",
  "reduce crashes", or asks why their app is crashing in production. Calls
  get_crash_metrics, interprets thresholds, identifies regressed versionCode /
  apiLevel, and walks through Android-specific code remediations.
---

# Improve Android Crash Rate

Use this skill when the user wants to investigate or reduce their Android app's
production crash rate. It pairs with the `android-vitals-mcp` server, which
must be configured (env vars `GOOGLE_APPLICATION_CREDENTIALS` and
`ANDROID_PACKAGE_NAME`).

## When to use

- "improve / reduce / investigate Android crashes"
- "crash rate", "crashRate", "crash-free users"
- "Play Console says we have a crash problem"
- "users are reporting the app crashes"

Do NOT use for Crashlytics stack-trace triage (`crash-to-vibe`), iOS crashes,
or general error logging questions.

## Step 1 — Diagnose

Call the MCP tool. Default window is 7 days; widen to 28 if the user mentions
a recent regression, narrow to 1–3 if they're verifying a hotfix.

```
get_crash_metrics(days=7)
```

The response is a compact summary. **All rates are percentages.**
- `overall` — app-wide figures. Lead with these.
- `breakdown.groups` — the top groups (one per `versionCode` by default),
  ranked by `avgDailyUsers`; `groupsTotal` says how many exist.

Each entry carries `latest` (most recent day) and `windowAvg` (daily rate
averaged over the window, weighted by users) for:
- `userPerceivedCrashRate` — crashes while the app is in active use
  (showing an activity or running a foreground service). **Play's
  thresholds apply to this metric.**
- `userPerceivedCrashRate7dUserWeighted` / `…28dUserWeighted` — Play's
  rolling averages (in `latest` only).
- `crashRate` — every crash, including background ones.
- `avgDailyUsers` — average daily distinct users (rounded by Google).

Drill down with arguments instead of re-reading raw data:
- `dimensions=["versionCode","apiLevel"]` — OS-specific breakage per build.
- `versionCodes=["<latest>","<previous>"]` — compare specific builds.
- `dimensions=["deviceModel"]` — per-device hotspots (the 8 % bar below).
- `format="raw"` returns every daily row as fractions (0–1). It is large;
  use it only to debug.

If the call fails with auth errors: confirm `GOOGLE_APPLICATION_CREDENTIALS`
points to a real key file and the service account has at least "View app
information (read-only)" on the Play Console. Do **not** mock the data.

## Step 2 — Interpret thresholds

Google Play's bad-behavior thresholds apply to the **user-perceived** crash
rate. Above them, Play may reduce the app's visibility.

| Scope                                  | Bad-behavior threshold |
|----------------------------------------|------------------------|
| Overall (average across all devices)   | `≥ 1.09 %`             |
| Any single phone model                 | `≥ 8 %`                |

Reading the response:
- Quote `overall.latest.userPerceivedCrashRate7dUserWeighted` and
  `…28dUserWeighted` against 1.09 %. Never compare plain `crashRate` to these
  thresholds.
- Compare `breakdown.groups` by `versionCode` — a recent build that's
  noticeably worse than the previous one is the regression candidate.
- `crashRate` well above `userPerceivedCrashRate` ⇒ background crashes
  (services, receivers, WorkManager). Play's threshold ignores them, but
  users still lose work.
- A single dominant `apiLevel` (re-query with
  `dimensions=["versionCode","apiLevel"]`) signals OS-specific breakage.
- Multiply rate × `avgDailyUsers` per group to estimate users affected;
  lead with biggest absolute impact, not highest rate. Groups with few
  users are noisy.
- If `overall` is below 1.09 % and the trend is flat, tell the user the
  metric looks healthy.

### Find the issues behind the rate

Rates say *which build*; error issues say *which code*:

```
search_error_issues(type="CRASH", userPerceivedOnly=true, versionCodes=["<worst>"])
```

Each issue has an `issueId`, `cause` and `location` (read both — the API
can return them the other way round from Google's docs), affected users
and their share, and the first / last `versionCode` it appeared in. An
issue whose first `versionCode` is the regressed build is new in that
build. Then pull stack traces for the top one or two:

```
get_error_reports(issueId="<issueId>", limit=3)
```

`get_error_counts(dimensions=["issueId"], reportType="CRASH")` shows
whether an issue is growing day by day.

## Step 3 — Remediate

Pick the playbook that matches the dominant signal from Step 2 and load the
matching reference:

| Signal | Reference |
|---|---|
| A specific recent `versionCode` regressed | [references/version-regression.md](references/version-regression.md) |
| Crashes concentrated on one `apiLevel` (OS version) | [references/api-level-issues.md](references/api-level-issues.md) |
| Native signal: tombstones / `SIGSEGV` in `get_error_reports` or Crashlytics, a native dependency bump, or API 35 concentration | [references/native-crashes.md](references/native-crashes.md) |
| No clear hotspot — broad triage / general hardening | [references/general-hardening.md](references/general-hardening.md) |

Read **only** the reference that matches the dominant signal. If you've ruled
one playbook out, do not load it.

## Step 4 — Verify the fix

After the user ships a fix:
1. Wait at least 24 h for Play data to stabilise (the MCP already accounts
   for the 2-day API delay).
2. Re-call `get_crash_metrics(days=3, versionCodes=["<new>","<previous>"])`.
3. Confirm the new `versionCode`'s `userPerceivedCrashRate < 1.09 %` and
   that `avgDailyUsers` on the regressed build is decaying.

## Output format

1. **Headline** — one sentence: healthy / watch-list / bad-behavior, quoting
   the overall user-perceived 7d / 28d rate and naming the worst
   `versionCode`.
2. **Evidence** — small table: `versionCode | userPerceivedCrashRate |
   crashRate | avgDailyUsers` for the top 3–5 offending groups.
3. **Top issues** — `issueId | cause / location | users (share) |
   first–last versionCode` for the top 3, with the key stack frame.
4. **Diagnosis** — which reference you loaded and why.
5. **Action items** — 2–4 concrete next steps.
