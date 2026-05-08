# Classic Views Jank Playbook

Load this when the janking surface is the legacy View system —
typically a `RecyclerView`, `ScrollView`, or a deep view hierarchy
with a custom `onDraw`.

## 1. Run Layout Inspector

Android Studio → View → Tool Windows → Layout Inspector. Connect to
the affected build, open the janky screen.

What to look at:
- **Hierarchy depth**. Anything > 7–8 levels deep, especially inside
  a `RecyclerView` row, is suspect. The deeper the hierarchy, the
  more measure / layout passes per frame.
- **`Linear​Layout` weight nesting**. Weights cause a double-measure
  pass. Migrate to `ConstraintLayout`.
- **Overdraw**. Enable Developer Options → "Debug GPU overdraw" and
  open the screen. Red areas overdraw 4× — the goal is mostly green
  / blue.

## 2. Migrate to `ConstraintLayout`

Replace nested `Linear​Layout` / `Frame​Layout` chains with a single
`ConstraintLayout`. This typically halves both depth and measure
time on lists.

Pattern:
```xml
<!-- Before: 5 nested LinearLayouts -->
<LinearLayout orientation="vertical">
  <LinearLayout orientation="horizontal" weight="1">
    <ImageView ... />
    <TextView weight="1" ... />
  </LinearLayout>
  ...
</LinearLayout>

<!-- After: one ConstraintLayout, all siblings -->
<androidx.constraintlayout.widget.ConstraintLayout>
  <ImageView app:layout_constraintStart_toStartOf="parent" ... />
  <TextView app:layout_constraintStart_toEndOf="@id/image" ... />
  ...
</androidx.constraintlayout.widget.ConstraintLayout>
```

## 3. Audit `RecyclerView.Adapter`

Rules:
- `setHasFixedSize(true)` if the list bounds are stable. Tells the
  RV it can skip some layout passes.
- Use `ListAdapter` (which uses `DiffUtil` automatically) instead of
  `notifyDataSetChanged()`. The latter recreates every visible
  row.
- `onCreateViewHolder` may allocate / inflate freely — runs once
  per view-type.
- `onBindViewHolder` runs every time a row scrolls into view. It
  must not:
  - Allocate (especially `Bitmap`, `Paint`, `Path`).
  - Decode images synchronously — use Coil/Glide async loaders.
  - Parse JSON — pre-parse in the data layer.
  - Touch `SharedPreferences` — see [main-thread-io](../../improve-android-anr/references/main-thread-io.md).
- Pre-cache view types with `RecyclerView.RecycledViewPool` if the
  same row types are used across screens.

## 4. Audit custom `onDraw()`

For any custom `View` overriding `onDraw`:

```bash
rg -n 'override fun onDraw' app/src/main --type kotlin
```

Per call, check that you do NOT:
- `Path()` / `Paint()` / `Bitmap.createBitmap` allocations — pre-allocate
  in the constructor, mutate in `onDraw`.
- `Bitmap.createScaledBitmap` — pre-scale once or use a `Matrix`.
- `Layout.Builder` for text — use `StaticLayout` cached.
- `Resources.getColor(...)` / `getString(...)` lookups — cache once.

Pre-allocation pattern:
```kotlin
private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
  color = ContextCompat.getColor(context, R.color.foo)
}
private val rect = RectF()

override fun onDraw(canvas: Canvas) {
  rect.set(0f, 0f, width.toFloat(), height.toFloat())
  canvas.drawRoundRect(rect, 8f, 8f, paint)
}
```

## 5. Audit `View.invalidate()` callers

If `invalidate()` is called from a `Handler` / coroutine on a tight
loop, the View redraws faster than the screen refresh — wasted work
and frame drops.

Replace with `postInvalidateOnAnimation()` or a `ValueAnimator`
that drives the property; the framework throttles redraws to vsync.

## 6. Splash screen overdraw

After Android 12 splash screen is dismissed, the activity's window
background is often kept. Set a flat color or `null`:

```kotlin
window.setBackgroundDrawable(null)
```

Reduces overdraw by one full screen layer.

## 7. Lock in with Macrobenchmark

Use `FrameTimingMetric` on the affected screen with a representative
scroll flow. See [frame-profiling.md](frame-profiling.md).
