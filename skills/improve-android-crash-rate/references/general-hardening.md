# General Hardening Playbook

Load this when no single signal dominates: crashes are spread across
versions, API levels, and devices, with no obvious regression. The job
is to tighten the long tail.

## 1. Triage the top 5 Crashlytics issues

If `crash-to-vibe` is available, invoke it. Otherwise:
- Open Crashlytics, sort issues by "Users affected" desc, take the
  top 5.
- For each: capture exception type, top non-framework frame, % of
  affected users, and the typical Android version.
- Group: lifecycle bugs, native, OOM, OS-specific, third-party SDK.

The top 5 typically explain 60–80 % of total crash volume; fixing them
alone moves the metric.

## 2. Audit `Application.onCreate` and `ContentProvider.onCreate`

These run on every cold start. Anything that throws here crashes
100 % of starts.

Checklist:
- `Firebase.initializeApp(...)` — wrap in try/catch only if you have a
  fallback; otherwise let it fail loudly.
- Encrypted SharedPreferences migrations — these throw on devices with
  reset keystores. Catch `GeneralSecurityException` and fall back to a
  reset.
- Hilt / Dagger graph construction — eager `@Provides` constructors
  doing I/O fail unpredictably.
- Custom `WorkManager.Configuration` — must be initialized exactly
  once; double-init throws.
- Old `androidx.work.Configuration.Provider` interface — ensure your
  `Application` implements `androidx.work.Configuration.Provider` (no
  duplicates).

For each declared `<provider>` in the merged manifest, the same rules
apply because their `onCreate` runs *before* `Application.onCreate`.

## 3. Lifecycle null bugs

Common throwing patterns:

```kotlin
// onSaveInstanceState may run after view is detached
override fun onSaveInstanceState(outState: Bundle) {
  outState.putString("query", searchView.query.toString())  // searchView is null
  super.onSaveInstanceState(outState)
}

// Fragment view binding accessed after onDestroyView
private var _binding: FragmentFooBinding? = null
private val binding get() = _binding!!  // throws if accessed late
```

Search the codebase:
```bash
rg -n '!!\.' app/src/main --type kotlin | head -30
rg -n 'requireView\(\)|requireContext\(\)|requireActivity\(\)' app/src/main --type kotlin | head -30
```

Each of these is a potential `IllegalStateException` if the lifecycle
moves past the safe window. Replace with `viewLifecycleOwner` checks
or `view?.let { ... }` blocks.

## 4. LeakCanary integration

Memory leaks → growing heap → eventual OOM → crash. If the user doesn't
already have LeakCanary in debug builds, recommend adding it:

```kotlin
debugImplementation("com.squareup.leakcanary:leakcanary-android:2.14")
```

Have them run a smoke test through the app's main flows in debug; any
leak LeakCanary surfaces will eventually become an OOM in production.
Common leak sources: static `Context` holders, anonymous-class
listeners on long-lived objects, `Handler` references holding
`Activity`.

## 5. Coroutine exception handlers

Unhandled coroutine exceptions surface as crashes on most Android
versions because `CoroutineExceptionHandler` is required at the root
scope.

Checks:
- Every top-level `CoroutineScope` constructed manually has a
  `CoroutineExceptionHandler`. Search:
  ```bash
  rg -n 'CoroutineScope\(' app/src/main --type kotlin
  ```
- `viewModelScope` and `lifecycleScope` already have one — unhandled
  exceptions log but don't crash. But `GlobalScope.launch { ... }` and
  custom scopes do crash.
- `SupervisorJob` is the right parent for scopes where child failures
  should be isolated.

## 6. Cross-reference with Crashlytics

For each top issue, click "View user impact" in Crashlytics and check
the `versionCode` distribution:
- **Concentrated** on one version → load
  [version-regression.md](version-regression.md) for that version.
- **Concentrated** on one API level → load
  [api-level-issues.md](api-level-issues.md).
- **Native frames** in the trace → load
  [native-crashes.md](native-crashes.md).
- **Spread across all** → continue with the hardening checklist above.

## 7. Verify

After 24 h, re-call `get_crash_metrics(days=3)`. The metric won't drop
to zero — long-tail crashes are real — but a successful hardening pass
should see the top 5 issues' "users affected" decrease meaningfully on
the new `versionCode`.
