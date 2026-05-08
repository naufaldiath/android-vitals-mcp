# Compose Jank Playbook

Load this when the janking surface is Jetpack Compose. The most
common Compose-specific jank causes are unstable types triggering
recomposition, snapshot reads in hot paths, and animations that
re-layout instead of just re-drawing.

## 1. Generate the Compose Compiler stability report

In `app/build.gradle.kts` (or a top-level Compose config):

```kotlin
composeCompiler {
  reportsDestination = layout.buildDirectory.dir("compose_compiler")
  metricsDestination = layout.buildDirectory.dir("compose_compiler")
}
```

Or via CLI:
```bash
./gradlew :app:assembleRelease \
  -Pandroidx.compose.compiler.plugins.kotlin.reportDestination=$PWD/compose-reports
```

The report writes per-module files including
`<module>-classes.txt`. Search for `unstable class`:

```bash
rg 'unstable class' app/build/compose_compiler/
```

For each unstable class **used as a parameter** to a composable
called inside `LazyColumn` / `Box` body lambdas, you have a
suspect — Compose re-runs that composable every time the parent
recomposes because it can't prove the param is unchanged.

Fixes:
- Mark stable types with `@Stable` or `@Immutable` if they really
  are immutable.
- Replace `List<Foo>` / `Map<K,V>` with `kotlinx.collections.immutable.PersistentList<Foo>` —
  the Compose compiler treats these as stable.
- Replace `data class` ad-hoc `state` holders with `@Stable` ones,
  or unwrap them so each scalar is passed independently.

## 2. Throttle derived state

Hot recomposition often comes from snapshot reads that change every
frame.

```kotlin
// Recomposes on every scroll pixel
val isScrolledDown = listState.firstVisibleItemIndex > 0

// Recomposes only when the boolean flips
val isScrolledDown by remember {
  derivedStateOf { listState.firstVisibleItemIndex > 0 }
}
```

Search for raw snapshot reads:
```bash
rg -n 'firstVisibleItem|currentBackStackEntry|value' app/src/main \
  --type kotlin | grep -i compose
```

Wrap any boolean / ID derived from a fast-changing state in
`remember { derivedStateOf { ... } }`.

## 3. Move animations to the draw phase

`Modifier.padding(animatedDp)` re-runs **measure + layout + draw**
every animation frame. Slow.

`Modifier.offset { IntOffset(animatedPx, 0) }` only re-runs **draw**
because the lambda is a deferred state read. Fast.

Same idea for size, alpha, and graphics-layer transforms — prefer
`Modifier.graphicsLayer { ... }` over property setters when
animating.

## 4. Audit `LazyColumn` / `LazyRow` items

- `key = { it.id }` is mandatory if items can be added/removed —
  without it, Compose recomposes everything on insertion.
- `contentType = { it::class }` lets Compose reuse view-holders for
  heterogeneous lists.
- Don't allocate Modifiers inline inside `items { ... }` — extract
  them to top-level `val`s where possible.
- Don't pass lambdas inline that capture changing state — wrap in
  `remember(stableKey) { { ... } }` or pass stable callbacks.

## 5. Visualize recomposition

Android Studio → Layout Inspector → "Show Recomposition Counts".
Run the app, open the suspect screen, perform the janky interaction.
Composables with unexpectedly high counts (or "skipped" much less
than "compositions") are the recomposition hot spots.

## 6. Less-common but recurring issues

- **`SubcomposeLayout` overuse** — every subcompose pass is a full
  composition; avoid in lists.
- **`movableContentOf` scattered across hierarchy** — useful, but
  causes subtle jank if abused.
- **`CompositionLocalProvider` with new instance every recompose** —
  invalidates everything below it. Provide stable values.
- **`AnimatedContent` with heavy children** — wrap children in
  `remember` so they survive transition.

## 7. Lock in with Macrobenchmark

Use `FrameTimingMetric` on the affected screen. See
[frame-profiling.md](frame-profiling.md) for the CI snippet.
