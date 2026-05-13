# Baseline Profiles Playbook

Load this when the user doesn't have a Baseline Profile yet or wants
to verify their existing one. **A correctly-installed Baseline
Profile is the single highest-leverage cold-start optimization** —
typically 10–30 % faster startup, and similar improvements on the
first interaction with each major flow.

## What it does

The Android ART runtime AOT-compiles methods listed in the Baseline
Profile when the APK is installed. Without one, those methods are
JIT-compiled on first execution — which is exactly during cold
start.

## 1. Add the gradle plugins

In the project's `build.gradle` (root):

```groovy
plugins {
  id "androidx.baselineprofile" version "1.3.0" apply false
}
```

In `app/build.gradle`:

```groovy
plugins {
  id 'com.android.application'
  id 'androidx.baselineprofile'
}

dependencies {
  implementation "androidx.profileinstaller:profileinstaller:1.4.1"
  baselineProfile project(':macrobenchmark')   // see below
}

baselineProfile {
  // Automatically merge generated profiles into src/main/generated/baselineProfiles/
  // This allows the profiles to be committed to version control.
  saveInSrc = true
  automaticGenerationDuringBuild = false
}
```

## 2. Create the `:macrobenchmark` module

If you don't have one, create a macrobenchmark module. 

**Important:** If testing on Android 16 (API 36) or using AGP 9+, you **must** use `benchmark-macro-junit4` version **`1.4.1`** or higher. Older versions will crash with a `pm dump-profiles` error.

The generator (`macrobenchmark/src/main/java/.../BaselineProfileGenerator.kt`) should look like this:

```kotlin
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
  @get:Rule val rule = BaselineProfileRule()

  @Test fun generate() = rule.collect(
    // Use dynamic package name to support multiple build variants (e.g., dev, staging, prod)
    packageName = InstrumentationRegistry.getInstrumentation().targetContext.packageName,
    includeInStartupProfile = true,
  ) {
    pressHome()
    startActivityAndWait()
    // Critical user journey:
    // - tap login
    // - scroll the home feed
    // - open a detail screen
  }
}
```

The journey should cover the **first 10 seconds** of typical user
interaction. This is what gets AOT-compiled.

## 3. Generate the profile

```bash
./gradlew :app:generateReleaseBaselineProfile
```

If you configured `saveInSrc = true`, the output lands at
`app/src/main/generated/baselineProfiles/baseline-prof.txt` (or the specific flavor's source folder).
It's a list of method signatures — **commit this file**.

## 4. Verify locally using StartupBenchmark

Instead of relying solely on ADB, you should update your `StartupBenchmark.kt` to test both modes side-by-side:

```kotlin
@RunWith(AndroidJUnit4::class)
class StartupBenchmark {
    @get:Rule val benchmarkRule = MacrobenchmarkRule()

    @Test fun startupNoCompilation() = startup(CompilationMode.None())
    @Test fun startupBaselineProfile() = startup(CompilationMode.Partial(baselineProfileMode = BaselineProfileMode.Require))

    private fun startup(compilationMode: CompilationMode) = benchmarkRule.measureRepeated(
        packageName = InstrumentationRegistry.getInstrumentation().targetContext.packageName,
        metrics = listOf(StartupTimingMetric()),
        compilationMode = compilationMode,
        iterations = 5,
        startupMode = StartupMode.COLD
    ) {
        pressHome()
        startActivityAndWait()
    }
}
```

Run the benchmark locally:
```bash
./gradlew :macrobenchmark:connectedReleaseAndroidTest
```
Compare `startupNoCompilation` vs `startupBaselineProfile`. Expect 10–30% improvement on cold start.

## 5. Verify inclusion in the AAB

After `./gradlew :app:bundleRelease`:

```bash
unzip -l app/build/outputs/bundle/release/app-release.aab   | grep baseline-prof
```

Expect to see:
```
BUNDLE-METADATA/com.android.tools.build.profiles/baseline.prof
BUNDLE-METADATA/com.android.tools.build.profiles/baseline.profm
```

If those entries are missing, the profile isn't shipping. Re-check:
- The `androidx.baselineprofile` plugin is applied.
- `androidx.profileinstaller:profileinstaller` is in `app`'s
  `implementation` deps.
- `baselineProfile(project(":baselineprofile"))` is in `app`'s
  `dependencies`.

## 5. Verify on-device installation

The Profile Installer applies the profile asynchronously after
install. Force the AOT compile to verify locally:

```bash
adb install app-release.apk
adb shell cmd package compile -m speed-profile <pkg>
adb shell am start -W -S <pkg>/<.LauncherActivity>
```

Compare `TotalTime` before and after `compile -m speed-profile`.
Expect 10–30 % improvement on cold start.

## 6. CI integration

```kotlin
baselineProfile {
  automaticGenerationDuringBuild = true     // regenerate on every release build
}
```

Or run manually in CI on `main` branch nightly:
```yaml
- run: ./gradlew :app:generateReleaseBaselineProfile
- run: |
    if ! git diff --quiet baseline-prof.txt; then
      git config user.email ci@example.com
      git config user.name CI
      git add baseline-prof.txt
      git commit -m "chore: refresh baseline profile"
      git push
    fi
```

## 7. Startup Profile (additional optimization)

`includeInStartupProfile = true` (in the generator) also produces a
`startup-prof.txt`. This goes through Cloud Profiles distribution
and gives even faster startup on devices that haven't yet AOT-compiled
the regular profile.

## 8. Verify in production

24 h after rollout:
- `get_startup_time_metrics(days=3)` should show
  `slowStartRate(COLD)` improved on the new `versionCode`.
- The improvement is typically larger on **mid-tier and low-end
  devices** (slower ART JIT) — segment by `apiLevel` if you want
  to see the effect cleanly.

## 9. Recurring maintenance

- Regenerate the profile every 1–2 months as the app evolves —
  stale profiles compile dead methods.
- When you add a major new flow (new tab, new feature), update the
  generator's journey to walk it.
- Track CI startup-benchmark trend lines; a regression in the
  benchmark + a regression in `slowStartRate(COLD)` means the
  profile may be stale.
