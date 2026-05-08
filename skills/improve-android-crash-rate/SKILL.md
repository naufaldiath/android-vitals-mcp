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

Each row is dimensioned by `apiLevel` and `versionCode` and carries
`crashRate`, `errorReportCount`, and `distinctUsers`.

If the call fails with auth errors: confirm `GOOGLE_APPLICATION_CREDENTIALS`
points to a real key file and the service account has at least "View app
information (read-only)" on the Play Console. Do **not** mock the data.

## Step 2 — Interpret thresholds

Google Play "core technical quality" thresholds for **user-perceived crash
rate**:

| Threshold     | Meaning                                       |
|---------------|-----------------------------------------------|
| `< 1.09 %`    | Healthy. No Play visibility impact.           |
| `≥ 1.09 %`    | "Bad behavior" — Play may reduce visibility.  |
| `≥ 8 %`       | Core technical-quality bar failure.           |

Reading the response:
- Sort rows by `versionCode` desc — a recent build that's noticeably worse
  than the previous one is the regression candidate.
- A single dominant `apiLevel` (very old or brand-new) signals OS-specific
  breakage.
- Multiply `crashRate × distinctUsers` per row to estimate users affected;
  lead with biggest absolute impact, not highest rate.
- If everything is below 1.09 % and trend is flat, tell the user the metric
  looks healthy.

## Step 3 — Remediate

Pick the playbook that matches the dominant signal from Step 2 and load the
matching reference:

| Signal | Reference |
|---|---|
| A specific recent `versionCode` regressed | [references/version-regression.md](references/version-regression.md) |
| Crashes concentrated on one `apiLevel` (OS version) | [references/api-level-issues.md](references/api-level-issues.md) |
| `errorReportCount ≫ distinctUsers` or NDK signal | [references/native-crashes.md](references/native-crashes.md) |
| No clear hotspot — broad triage / general hardening | [references/general-hardening.md](references/general-hardening.md) |

Read **only** the reference that matches the dominant signal. If you've ruled
one playbook out, do not load it.

## Step 4 — Verify the fix

After the user ships a fix:
1. Wait at least 24 h for Play data to stabilise (the MCP already accounts
   for the 2-day API delay).
2. Re-call `get_crash_metrics(days=3)` and look at the new `versionCode`.
3. Confirm `crashRate < 1.09 %` and that affected `distinctUsers` on the new
   build is near zero.

## Output format

1. **Headline** — one sentence: healthy / watch-list / bad-behavior, naming
   the worst `versionCode`.
2. **Evidence** — small table: `versionCode | apiLevel | crashRate | users`
   for the top 3–5 offending rows.
3. **Diagnosis** — which reference you loaded and why.
4. **Action items** — 2–4 concrete next steps.
