# Image Pipeline Playbook

Load this when jank correlates with screens that show images —
product lists, photo grids, news feeds, profile pictures — or when
the user mentions Coil / Glide / Picasso / Fresco.

## 1. Decode at destination size, not original size

The most common image-pipeline jank cause: decoding a 4096×3072
JPEG into a 200×200 `ImageView`. The decode pegs the main thread
just long enough to drop a frame.

### Coil
```kotlin
// Bad: original size
AsyncImage(model = url, contentDescription = null)

// Good: explicit size, even with Modifier.fillMaxWidth()
AsyncImage(
  model = ImageRequest.Builder(LocalContext.current)
    .data(url)
    .size(Size.ORIGINAL)              // ← footgun in lists
    .build(),
  ...
)

// In a RecyclerView row, prefer:
imageView.load(url) {
  size(width, height)                  // explicit
  crossfade(150)
  precision(Precision.INEXACT)
}
```

### Glide
```kotlin
Glide.with(context)
  .load(url)
  .override(width, height)             // explicit
  .centerCrop()
  .into(imageView)
```

For lists, set the size to the actual `ImageView` dimensions. If
the dimensions are unknown until layout, use
`Target<Drawable>` or Coil's `ViewSizeResolver`.

## 2. Hardware bitmaps

Hardware bitmaps live in GPU memory and skip CPU upload on each
frame. Coil and Glide both support them on API 26+.

Coil enables them by default. Disable explicitly only when you need
to read pixel data (rare).

Glide:
```kotlin
GlideBuilder()
  .setDefaultRequestOptions(RequestOptions().format(DecodeFormat.PREFER_RGB_565))
  // hardware bitmaps are default on API 26+
```

## 3. Animated GIF / WebP loops

A `RecyclerView` row containing a 30-frame animated WebP that loops
forever consumes CPU even when the row is off-screen.

Mitigations:
- Pause animations when the `Lifecycle` is stopped:
  ```kotlin
  Coil.imageLoader(context).bitmapPool.clear()
  ```
  Or use `disallowHardwareConfig()` + `lifecycle = lifecycleOwner`.
- For Compose: `AsyncImage` automatically pauses when the
  composable leaves composition.
- For Glide: use `Glide.with(viewLifecycleOwner)` and make sure the
  Fragment passes its lifecycle.
- Limit loop count (Coil: `repeatCount(0)` shows one cycle then
  stops).

## 4. `RecyclerView` row decoding gotchas

- **Scroll-fling decode storm**: when the user flings, every row
  briefly attaches and starts a load. Mitigate with:
  ```kotlin
  recyclerView.addOnScrollListener(object : RecyclerView.OnScrollListener() {
    override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
      if (newState == RecyclerView.SCROLL_STATE_DRAGGING ||
          newState == RecyclerView.SCROLL_STATE_SETTLING) {
        Glide.with(context).pauseRequests()
      } else {
        Glide.with(context).resumeRequests()
      }
    }
  })
  ```
  Coil has a similar `ImageLoader.shutdown` / `pause` pattern.
- **Image keys without size in cache key** — same URL reloaded for
  different sizes. Both Coil and Glide handle this automatically;
  custom transformations should override `equals` / `hashCode`.
- **Synchronous BitmapFactory in `onBindViewHolder`** — if you see
  `BitmapFactory.decodeFile` / `decodeStream` in row binding, move
  it to a worker dispatcher.

## 5. Format and size at the source

The fastest decode is the one you don't do.

- **Use WebP / AVIF** for assets in the APK — smaller file, faster
  decode than JPEG/PNG.
- **Server-side resizing** — request `_300x300.webp` URLs from the
  CDN instead of decoding the full image. Most CDNs (Cloudinary,
  Imgix, Cloudflare Images) take size params on the URL.
- **Pre-generate thumbnails** for local images via WorkManager once
  on import; show the thumbnail in lists.

## 6. Verify

After shipping:
- `get_slow_rendering_metrics(days=3)` — confirm the new
  `versionCode` improved both 20fps and 30fps rates on the affected
  screen's typical sessions.
- Macrobenchmark the affected screen's scroll flow with
  `FrameTimingMetric`. See
  [frame-profiling.md](frame-profiling.md).
