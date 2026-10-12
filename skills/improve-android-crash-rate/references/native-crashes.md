# Native (NDK) Crashes Playbook

Load this when the data suggests native code is involved:
- Crashlytics shows the same native frame or tombstone recurring for
  the same users (deterministic native bug),
- crashes spike right after a native dependency bump,
- crashes concentrate on Android 15 (API 35) — likely 16 KB page-size,
- the user explicitly mentions C/C++/Rust, JNI, or "tombstone".

## 1. Surface the native stack

In Crashlytics, native crashes are filed under "Crashlytics → Crashes →
Native" (a separate tab from JVM crashes). Each issue has:
- A native stack starting from the crashing frame (e.g.
  `libfoo.so:0x14a32`), ideally **symbolicated** if you uploaded
  symbol files.
- A "tombstone" snippet from `/data/tombstones/` on the device.

If frames look like raw addresses (e.g. `libfoo.so+0x14a32`), symbol
upload is broken — go to step 5.

## 2. Recently bumped C++ / Rust / native deps

Native dependencies that ship `.so` files inside an `.aar` or directly
in `app/src/main/jniLibs/`:

```bash
unzip -l app-release.aab | grep '\.so$' | head -40
```

Ask the user to diff:
```bash
git diff <prev>..<head> -- '**/*.gradle*' '**/CMakeLists.txt' \
  'app/src/main/jniLibs/' '**/build.gradle.kts'
```

Common offenders:
- SQLCipher / SQLite native bindings.
- Custom Rust libs via `cargo-ndk`.
- ML libs (TensorFlow Lite, ONNX runtime, MediaPipe).
- Crypto libs (libsodium, OpenSSL forks).
- Image / video codecs.

## 3. JNI signature mismatches

Symptoms: `NoSuchMethodError`, `UnsatisfiedLinkError`, or a SIGSEGV
inside `dvm_DoCallMethod` / ART method dispatch.

Checks:
- The Kotlin / Java signature must exactly match the C++ JNI export.
  Even nullable annotations matter: `String` vs `String?` changes the
  generated signature.
- `extern "C"` is required around `JNIEXPORT` declarations or C++ name
  mangling silently breaks the binding.
- `RegisterNatives` callers must list every native method by exact
  signature.

If the user uses `kotlinx-cinterop` or `kapt`-generated native bindings,
check that the generated headers match their current call sites
(`./gradlew :app:cinteropNativeMain` or equivalent).

## 4. Android 15 (API 35) 16 KB page sizes

Android 15 supports devices with 16 KB memory pages. Native libs
compiled with the default 4 KB-aligned segments crash on those devices.

Verification (run in the user's project root):
```bash
# Per-ABI check across all .so files in the AAB
for so in $(unzip -l app-release.aab | awk '/\.so$/ {print $4}'); do
  unzip -p app-release.aab "$so" | objdump -p - 2>/dev/null \
    | awk -v f="$so" '/LOAD/ && $NF !~ /0x4000$/ {print f, $0}'
done
```

If any line prints, the lib is not 16 KB-page-aligned. Fix:
- Update the NDK to **r27** or newer.
- Set `-Wl,-z,max-page-size=16384` in the linker flags
  (`android.defaultConfig.externalNativeBuild.ndk.ldFlags`).
- Verify dependencies that ship prebuilt `.so` files have updated AARs;
  many libs released 16 KB-aligned versions in 2024-2025.

## 5. Symbol upload (`uploadCrashlyticsSymbolFile`)

If native frames are unsymbolicated, the user can't actually debug
them. Verify:

```bash
./gradlew :app:assembleRelease :app:uploadCrashlyticsSymbolFileRelease --info
```

Common breakage:
- The `firebase-crashlytics-ndk` plugin isn't applied.
- `nativeSymbolUploadEnabled = true` is missing from
  `firebaseCrashlytics { ... }` in the `app/build.gradle.kts`.
- The symbol upload runs but uploads from a stale build because the
  user ran `assembleRelease` after `uploadCrashlyticsSymbolFile`.
- CI doesn't have the Firebase service-account JSON injected.

After fixing, re-run a test crash on the regressed build and confirm
Crashlytics now shows function names instead of hex offsets.

## 6. After the fix

- Wait 24 h, re-call `get_crash_metrics(days=3)`.
- The native crash issue in Crashlytics should mark itself "resolved"
  on the new `versionCode` (set this manually after a quiet 48 h if
  Crashlytics doesn't auto-close).
- Lock in: add an R27+ NDK requirement in CI so older NDKs don't ship
  4 KB-aligned binaries again.
