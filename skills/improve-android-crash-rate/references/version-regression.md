# Version Regression Playbook

Load this when a specific recent `versionCode` is responsible for the spike
in `userPerceivedCrashRate` — typically the latest one or two builds shipped to
production, with a noticeably worse rate than the build before them.

## 1. Pull stack traces for the regressed build

You need actual stack traces before changing code.

- If `crash-to-vibe` is available in this environment, suggest invoking it
  filtered to the regressed `versionCode`.
- Otherwise direct the user to **Firebase Crashlytics → Issues**, filtered
  by app version. Sort by "Users affected" desc.
- Capture the top 3 issues. Quote the exception type and top non-framework
  frame back to the user — e.g. `java.lang.NullPointerException at
  com.example.feature.checkout.CheckoutViewModel.onPay(CheckoutViewModel.kt:42)`.

## 2. Diff the regressed build against the previous green one

```bash
# Find the tag / commit for each versionCode
git log --grep="versionCode <N>" --oneline   # adjust to your repo's convention
# Or: rev-parse the release tags
git diff v1.2.3..v1.2.4 -- app/             # narrow to the app module
```

Where to look in the diff, ranked by likelihood:

1. **Dependency version bumps** in `gradle/libs.versions.toml` or
   `app/build.gradle.kts`. A minor bump in Firebase / Crashlytics / Hilt /
   Retrofit / OkHttp can introduce real behavior changes — check release
   notes for the bumped versions. Compose BOM and Kotlin version bumps are
   especially high-risk.
2. **ProGuard / R8 keep rule changes** in `app/proguard-rules.pro`. A
   removed `-keep class …` is the classic cause of "works in debug, crashes
   in release" `NoSuchMethodError` / `ClassNotFoundException`. Cross-check
   `app/build/outputs/mapping/release/missing_rules.txt` if it exists.
3. **New work in `Application.onCreate` / `ContentProvider.onCreate`**.
   Anything that throws there crashes 100 % of cold starts.
4. **Manifest changes** — added permissions (especially
   `FOREGROUND_SERVICE_*` types on API 34+), new exported components, or
   `applicationId` suffix changes for staged rollout.
5. **Native library updates** — see also
   [native-crashes.md](native-crashes.md).

## 3. Decide rollout strategy

Once you know the cause, the user has three options. Recommend by severity:

| Severity | Recommended action |
|---|---|
| `userPerceivedCrashRate ≥ 8 %` on the build (severe — Play's per-phone-model bar) | **Halt the staged rollout** in Play Console immediately, then roll forward with a hotfix `versionCode`. |
| `userPerceivedCrashRate ≥ 1.09 %` (Play's overall bad-behavior bar) | **Pause the staged rollout** at its current percentage, ship a hotfix in the next 48 h. |
| `userPerceivedCrashRate < 1.09 %` but trending up | Let the rollout continue, fix in the next regular release. Watch the next data refresh closely. |

A "hotfix `versionCode`" means: bump only the patch + `versionCode`, ship a
release with the minimal diff that reverts or fixes the crash. Avoid
bundling unrelated work — that's how regressions get reintroduced.

## 4. After shipping the hotfix

- Re-call `get_crash_metrics(days=3, versionCodes=["<hotfix>","<regressed>"])`
  24 h after the hotfix is live.
- Confirm the new `versionCode`'s `userPerceivedCrashRate < 1.09 %`.
- Confirm `avgDailyUsers` on the regressed build is decaying (Play migrates
  users to the latest available version).
- Document the root cause in your release notes / postmortem so the
  dependency or rule change isn't reintroduced silently.

## 5. Prevent recurrence

- Lock dependency versions with `versionCatalogUpdate.keep` in your version
  catalog so dep bumps go through review.
- Add an R8 smoke test to CI: `./gradlew :app:assembleRelease` followed by
  an `am instrument` of a smoke-test APK against the release build — this
  catches missing keep-rules before they ship.
- Wire the staged rollout halt into a runbook so the next on-call doesn't
  hesitate.
