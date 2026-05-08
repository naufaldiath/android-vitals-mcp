# API-Level / OS Version Issues Playbook

Load this when crashes concentrate on one `apiLevel` (Android version)
rather than one `versionCode`. The signal: a single API level dominates
`crashRate × distinctUsers` while other API levels look healthy on the
same `versionCode`.

## 1. Identify which OS version

Quote the dominant `apiLevel` and its mapped Android release back to the
user. Common cliffs:

| `apiLevel` | Android release |
|---|---|
| 24 | 7.0 Nougat |
| 26 | 8.0 Oreo |
| 28 | 9 Pie |
| 30 | 11 |
| 31 | 12 |
| 33 | 13 |
| 34 | 14 |
| 35 | 15 |
| 36 | 16 (preview) |

## 2. Newest API level dominates

Modern OS releases ship behavior changes that break apps even when
`compileSdk` is unchanged. Walk through the official
"Behavior changes: Apps targeting Android <N>" doc for the dominant API
level. The recurring offenders:

### API 34 (Android 14)
- **Foreground services** require an explicit type on `<service
  android:foregroundServiceType="…">`. Missing or wrong type ⇒
  `MissingForegroundServiceTypeException` on start.
- `RECEIVER_EXPORTED` / `RECEIVER_NOT_EXPORTED` is mandatory on
  registered runtime broadcast receivers ⇒ `SecurityException`.
- `BluetoothLeScanner` requires `BLUETOOTH_SCAN` runtime permission.

### API 33 (Android 13)
- `POST_NOTIFICATIONS` runtime permission.
- Photo Picker is preferred over `READ_EXTERNAL_STORAGE`. Granular
  media perms (`READ_MEDIA_IMAGES`, etc.) split the storage permission.

### API 35 (Android 15)
- **Edge-to-edge by default** if `targetSdk = 35` — apps that read
  insets incorrectly crash on layout pass.
- **16 KB page-size requirement** for native libraries shipping with the
  app — see [native-crashes.md](native-crashes.md).
- Predictive back gesture is opt-out instead of opt-in.

For each suspect, point the user at the relevant migration doc and ask
them to grep their code for the affected APIs.

## 3. Older API level dominates (≤ 28)

Old OEMs and old Android versions have edge cases your `targetSdk = 35`
build forgot about:

- **Null returns from system services** that are non-null on modern
  Android. Examples: `Context.getSystemService(...)` returning null on
  some Samsung builds, `WindowManager.defaultDisplay` null in headless
  contexts.
- **`VectorDrawable` rasterization differences** — drawables that render
  fine on API 30+ may throw `Resources$NotFoundException` on API ≤ 24
  if `app:srcCompat` is missing or AAPT2 stripped a tint attribute.
- **`AppCompat` theme requirements** — Activities extending `AppCompatActivity`
  must use `Theme.AppCompat.*` themes; older OEMs are stricter than
  newer Android about this.
- **Multidex** issues if `minSdk < 21` and the dex method count is high.

## 4. Confirm the hypothesis

Before recommending a fix, ask the user (or check):
1. Does the stack trace match an API-level-specific code path? Look for
   `Build.VERSION.SDK_INT` checks near the throwing frame.
2. Does the crash happen on a single OEM (which would suggest an OEM
   bug, not pure API-level)? Crashlytics breaks crashes down by device
   manufacturer — quote that back.
3. Does the same `versionCode` work fine on adjacent API levels? If yes,
   it's API-level-specific; if no, also load
   [version-regression.md](version-regression.md).

## 5. Fix patterns

- Wrap newly-introduced API calls in `if (Build.VERSION.SDK_INT >= …)`
  and provide a fallback for older OS.
- Use `androidx` compatibility wrappers (`PendingIntentCompat`,
  `ContextCompat`, `ActivityCompat`) instead of raw API-level branching.
- For `targetSdk` migrations, read the changelog from your previous
  `targetSdk` to the new one cumulatively, not just the latest delta.
- Bump `compileSdk` and `targetSdk` together; mismatched versions hide
  behavior changes.

## 6. Verify

After shipping the fix, re-check `get_crash_metrics(days=3)` and confirm
the dominant `apiLevel`'s `crashRate` has dropped on the new
`versionCode`. The other API levels should be unchanged — if they
regressed, you broke a fallback path.
