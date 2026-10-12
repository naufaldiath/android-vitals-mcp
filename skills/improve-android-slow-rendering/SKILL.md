---
name: improve-android-slow-rendering
description: >
  Diagnose and remediate Android slow rendering / jank using the
  android-vitals MCP. Auto-activates when the user mentions: jank, slow
  rendering, dropped frames, "frozen frames", 30fps / 20fps slow frames,
  "scrolling is laggy", or asks why their UI feels janky. Calls
  get_slow_rendering_metrics, identifies regressed versionCode / apiLevel,
  and walks through Compose / View remediations.
---

# Improve Android Slow Rendering

Use this skill when the user wants to investigate or reduce their Android
app's production jank rate. It pairs with the `android-vitals-mcp` server
(env vars `GOOGLE_APPLICATION_CREDENTIALS` and `ANDROID_PACKAGE_NAME`).

## When to use

- "improve / reduce jank", "fix slow rendering"
- "30fps slow frames", "20fps frozen frames", "dropped frames"
- "scrolling feels laggy", "animations stutter"
- "Play Console says we have a slow rendering problem"

Do NOT use for cold-start latency (use
`improve-android-startup-time`) or for main-thread freezes that
trigger ANRs (use `improve-android-anr`).

## Step 1 — Diagnose

```
get_slow_rendering_metrics(days=7)
```

**Games only.** Google Play's Reporting API exposes slow-rendering data
only for apps categorized as games. For any other app the tool returns an
error saying the metric set is "only accessible to games". When that
happens:
- Tell the user production jank data isn't available through the API for
  their app, and that Play Console → Android vitals is the place to look.
- Skip Step 2 and go straight to Step 3, using
  [references/frame-profiling.md](references/frame-profiling.md) to measure
  jank locally first.

When data comes back, the response is a compact summary. **All rates are
percentages.** `overall` holds the app-wide figures; `breakdown.groups` the
top groups (one per `versionCode` by default), ranked by `avgDailyUsers`.
Each entry carries `latest` (most recent day) and `windowAvg` (user-weighted
average over the window) for:
- `slowRenderingRate20Fps` — percentage of users who had slow rendering
  below 20 fps ("frozen" frames).
- `slowRenderingRate30Fps` — percentage of users who had slow rendering
  below 30 fps ("janky" frames).

Drill down with `dimensions=["versionCode","apiLevel"]` or
`versionCodes=["<latest>","<previous>"]`.

## Step 2 — Interpret the data

Google lists slow rendering as an "other" Android vitals metric — not a
core vital — and publishes no bad-behavior threshold for it. Judge it by
trend and by comparison between builds, not against a fixed bar.

Reading the data:
- **30 fps spike without 20 fps spike** ⇒ sustained over-budget work
  in a render pass (layout, overdraw, recomposition).
- **20 fps spike without 30 fps spike** ⇒ rare-but-severe stalls
  (typically main-thread I/O hidden in a render path).
- **Both spike together** ⇒ the same render path is consistently slow
  with occasional pathological frames.
- Older `apiLevel`s have inherently higher rates; only flag if the
  *delta* between API levels widened on a recent build.

## Step 3 — Remediate

| Suspect surface | Reference |
|---|---|
| UI is Jetpack Compose | [references/compose-jank.md](references/compose-jank.md) |
| UI is classic Views / `RecyclerView` | [references/views-jank.md](references/views-jank.md) |
| Image decoding suspected (lists with thumbnails, banners) | [references/image-pipeline.md](references/image-pipeline.md) |
| Confirming a fix, capturing telemetry, or no production data (non-game app) | [references/frame-profiling.md](references/frame-profiling.md) |

Read **only** the reference that matches the suspected surface. If
the app uses both Compose and Views, identify which screen is
janking first (use the profiling reference) and load the matching
reference.

## Step 4 — Verify the fix

1. Wait ~24 h after rollout.
2. Games: re-call
   `get_slow_rendering_metrics(days=3, versionCodes=["<new>","<previous>"])`
   and confirm both rates dropped on the new `versionCode`.
   Other apps: compare local before/after Macrobenchmark numbers instead.
3. Lock in a Macrobenchmark `FrameTimingMetric` baseline so the next
   regression fails CI.

## Output format

1. **Headline** — whether production data was available; if so, the
   jank trend on the worst `versionCode` and whether the dominant problem
   is "janky" or "frozen" frames.
2. **Evidence** — table: `versionCode | apiLevel |
   slowRenderingRate30Fps | slowRenderingRate20Fps`, or the local
   profiling numbers when the API isn't available.
3. **Diagnosis** — which reference you loaded and why.
4. **Action items** — 2–4 concrete steps including at least one CI /
   profiling lock-in.
