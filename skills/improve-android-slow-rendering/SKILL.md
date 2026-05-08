---
name: improve-android-slow-rendering
description: >
  Diagnose and remediate Android slow rendering / jank using the
  android-vitals MCP. Auto-activates when the user mentions: jank, slow
  rendering, dropped frames, "frozen frames", 30fps / 20fps slow frames,
  "scrolling is laggy", or asks why their UI feels janky. Calls
  get_slow_rendering_metrics, interprets thresholds, identifies regressed
  versionCode / apiLevel, and walks through Compose / View remediations.
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

Each row is dimensioned by `apiLevel` and `versionCode`, with metrics:
- `slowRenderingRate20Fps` — fraction of sessions where > 0.1 % of
  frames rendered slower than 50 ms (20 fps). These are "frozen"
  frames.
- `slowRenderingRate30Fps` — fraction of sessions where > 0.1 % of
  frames rendered slower than 33 ms (30 fps). These are "janky"
  frames.

## Step 2 — Interpret thresholds

Google Play "core technical quality" thresholds:

| Metric                                            | Bad-behavior threshold |
|---------------------------------------------------|------------------------|
| `slowRenderingRate30Fps` (janky frames)           | `≥ 25 %`               |
| `slowRenderingRate20Fps` (frozen frames)          | `≥ 5 %`                |

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
| Confirming a fix or capturing telemetry | [references/frame-profiling.md](references/frame-profiling.md) |

Read **only** the reference that matches the suspected surface. If
the app uses both Compose and Views, identify which screen is
janking first (use the profiling reference) and load the matching
reference.

## Step 4 — Verify the fix

1. Wait ~24 h after rollout.
2. Re-call `get_slow_rendering_metrics(days=3)`.
3. Confirm both `slowRenderingRate30Fps < 25 %` and
   `slowRenderingRate20Fps < 5 %` for the new `versionCode`.
4. Lock in a Macrobenchmark `FrameTimingMetric` baseline so the next
   regression fails CI.

## Output format

1. **Headline** — state of jank vs the 5 % / 25 % bars on the worst
   `versionCode`, plus whether the dominant problem is "janky" or
   "frozen" frames.
2. **Evidence** — table: `versionCode | apiLevel |
   slowRenderingRate30Fps | slowRenderingRate20Fps`.
3. **Diagnosis** — which reference you loaded and why.
4. **Action items** — 2–4 concrete steps including at least one CI /
   profiling lock-in.
