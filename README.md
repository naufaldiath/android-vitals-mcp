# android-vitals-mcp

Android Vitals for AI agents. Connect your Google Play Console and get four guided skills that automatically fetch crash, ANR, slow-rendering, and startup metrics, interpret thresholds, and walk through Android-specific remediations.

## Prerequisites

1. **Google Cloud Project** linked to your Google Play Console.
2. **Service Account JSON key** with the `https://www.googleapis.com/auth/playdeveloperreporting` scope.
3. **Play Console permission**: the Service Account email must be invited to Google Play Console with at least "View app information (read-only)".
4. **Node.js** ≥ 18.

## Quick start

**Step 1 — connect your Play Console:**

```bash
npx android-vitals-mcp setup
```

Prompts for your Service Account key path and Android package name, then writes the MCP server config into every detected AI CLI (`~/.claude.json`, `~/.gemini/settings.json`, `~/.cursor/mcp.json`, `~/.kiro/settings/mcp.json`).

Options:
```bash
npx android-vitals-mcp setup --dry-run        # preview without writing
npx android-vitals-mcp setup --cli claude     # limit to one CLI
```

**Step 2 — install the skill playbooks:**

```bash
npx android-vitals-install-skills
```

Drops four `SKILL.md` playbooks into every detected AI CLI's `skills/` directory (Claude Code, Gemini CLI, Codex, Copilot, Cursor, Cline, Kiro, Antigravity, Amp, OpenCode, and `~/.agents/skills/`).

Options:
```bash
npx android-vitals-install-skills --dry-run        # preview changes
npx android-vitals-install-skills --force          # overwrite without .bak files
npx android-vitals-install-skills --cli claude     # only Claude Code
```

**Step 3 — restart your AI CLI**, then ask:

> "improve my Android crash rate"

---

## What you get

### Skills

Each skill auto-activates on relevant keywords, fetches live metrics from Google Play, compares them with Google Play's bad-behavior thresholds where Google publishes one (user-perceived crash and ANR rate), and walks your agent through Android-specific remediations.

| Skill | Triggers on | Metrics fetched |
|---|---|---|
| `improve-android-crash-rate` | "crash rate", "improve crashes", "crash-free users" | user-perceived crash rate (daily, 7-day, 28-day), crash rate, distinct users |
| `improve-android-anr` | "ANR", "app not responding", "main-thread freeze" | user-perceived ANR rate (daily, 7-day, 28-day), ANR rate, distinct users |
| `improve-android-slow-rendering` | "jank", "slow rendering", "dropped frames" | slow rendering rates at 20 fps and 30 fps (games only) |
| `improve-android-startup-time` | "cold start", "TTID", "improve startup" | slow start rate by `startType` (COLD / WARM / HOT) |

### Available MCP tools

The skills above call these automatically.

**Metric sets.** Each returns a compact summary: app-wide figures (`overall`) plus the top groups (`breakdown`, one per `versionCode` by default). Rates are percentages.

| Tool | Returns |
|---|---|
| `get_crash_metrics` | user-perceived crash rate (daily / 7d / 28d), crash rate, distinct users |
| `get_anr_metrics` | user-perceived ANR rate (daily / 7d / 28d), ANR rate, distinct users |
| `get_slow_rendering_metrics` | slow rendering rates at 20 fps and 30 fps, distinct users. **Google Play exposes this only for games**; other apps get an explanatory error. |
| `get_startup_time_metrics` | slow start rate (daily / 7d / 28d) per `startType`, distinct users |
| `get_lmk_metrics` | user-perceived low memory kill rate (daily / 7d / 28d), distinct users |
| `get_memory_metrics` | anon RSS + swap and bitmap memory P50–P99 in KiB, distinct users; also breaks down by `appState` / `processName` |
| `get_battery_metrics` | excessive wakeup rate and stuck background wake lock rate (daily / 7d / 28d) |
| `get_error_counts` | crash and ANR report counts summed over the window; `dimensions: ["issueId"]` counts per error issue |

Optional arguments (metric-set tools):

| Argument | Default | Purpose |
|---|---|---|
| `days` | `7` | Window length, ending 2 days ago (Play data lags). |
| `dimensions` | `["versionCode"]` | Breakdown, e.g. `["versionCode", "apiLevel"]` or `["deviceModel"]`; `[]` for overall figures only. |
| `versionCodes` | — | Only these builds, e.g. `["123", "124"]`. |
| `apiLevels` | — | Only these Android API levels, e.g. `["34", "35"]`. |
| `limit` | `10` | Maximum groups in `breakdown`, ranked by average daily users. |
| `format` | `"summary"` | `"raw"` returns every daily API row as fractions (0–1) — large; for debugging. |
| `startType` | — | `get_startup_time_metrics` only: `COLD`, `WARM` or `HOT`. |
| `reportType` | — | `get_error_counts` only: `CRASH` or `ANR`. |

**Errors and metadata.** Error search covers complete UTC days ending today, so it is fresher than the metric sets.

| Tool | Returns | Arguments |
|---|---|---|
| `search_error_issues` | crash / ANR clusters ranked by affected users or reports: cause, location, user share, first / last version and API level, Play's insights, Console link | `days`, `type`, `userPerceivedOnly`, `versionCodes`, `apiLevels`, `orderBy`, `limit`, `includeSampleReport` |
| `get_error_reports` | individual reports: stack trace or ANR dump (cut to `maxChars`), device, API level, app version, VCS info | `issueId`, `days`, `type`, `userPerceivedOnly`, `versionCodes`, `apiLevels`, `limit`, `maxChars` |
| `list_anomalies` | anomalies Google Play detected in the app's vitals | `days` (default `90`), `limit` |
| `get_data_freshness` | the latest date each metric set has data for | — |
| `list_releases` | releases serving on each track, with their versionCodes | — |

Some Android vitals are only in Play Console — Google's Reporting API (revision 2026-10-08) has no endpoint for them: Android UI toolkit rendering for non-game apps, excessive partial wake locks, background Wi-Fi scans and network usage, permission denials, DAU / MAU, user loss rate, DEX code optimization, and peer comparisons.

---

## Idempotency

Both commands are safe to re-run:

- `android-vitals-mcp setup`: overwrites only the `"android-vitals"` key under `mcpServers`; all other config in the file is preserved.
- `android-vitals-install-skills`: no-op if the skill is already byte-identical (`= unchanged`); otherwise renames the old file to `.bak` before writing (`↻ updated`). Pass `--force` to skip the backup.
