# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Node.js npm package that ships **two surfaces**:

1. An MCP (Model Context Protocol) server (`index.js`) that exposes 4 tools fetching Android Vitals from the Google Play Developer Reporting API.
2. A skills installer (`bin/install-skills.js`) that copies 4 bundled `SKILL.md` files into every detected AI CLI's `skills/` directory (Claude Code, Gemini CLI, Codex, Copilot, Cursor, Cline, Kiro, Antigravity, Amp, OpenCode, `~/.agents/skills/`).

## Commands

```bash
npm install                                  # Install dependencies
npm start                                    # Run the MCP server (node index.js)
node bin/install-skills.js --dry-run         # Preview what the installer would write
node bin/install-skills.js                   # Install skills into all detected AI CLIs
node bin/install-skills.js --cli claude      # Limit to one CLI
npm pack --dry-run                           # Inspect the published tarball
```

The MCP server communicates over stdio and is not meant to be run interactively — hosts launch it via `npx -y android-vitals-mcp`.

## Required Environment Variables

```
GOOGLE_APPLICATION_CREDENTIALS   # Absolute path to Google Service Account JSON key
ANDROID_PACKAGE_NAME             # App ID, e.g. com.example.myapp
```

The service account must have `playdeveloperreporting` API scope and "View app information (read-only)" in Google Play Console.

## Architecture

The package is ESM (`"type": "module"`). Runtime entrypoints:

```
index.js                    # MCP server: 13 tools over the Reporting API's REST endpoints
bin/install-skills.js       # Skills installer CLI (#!/usr/bin/env node)
postinstall.js              # Post-install banner only — no FS writes
lib/ai-clis.js              # Canonical list of AI-CLI skills directories
lib/install-skill.js        # Idempotent SKILL.md copier (installed/unchanged/updated)
skills/<skill-name>/SKILL.md # 4 bundled skill payloads
```

### MCP server (`index.js`)

1. Authenticates via `google.auth.GoogleAuth` using the service account key file, and calls the REST endpoints through `apiRequest` (googleapis 144 has no methods for the LMK and memory metric sets). Read-only POSTs are retried on 408 / 429 / 5xx.
2. Registers two handlers on the `Server` instance:
   - `ListToolsRequestSchema` — returns the metric-set tools (`TOOLS`, built from `METRIC_SETS`) and the endpoint tools (`ENDPOINT_TOOLS`)
   - `CallToolRequestSchema` — validates arguments, builds the AIP-160 `filter`, queries the API (following `nextPageToken` for metric sets), and returns a summary
3. Starts a `StdioServerTransport`.

**`getTimeRange(days)`** — builds UTC-aligned start/end times. It subtracts 2 days from today before computing the range to account for Google Play's data freshness delay.

**Summary output** — each metric set runs two queries: one with no breakdown (the `overall` headline — summing per-group rows would double-count users) and one with the requested `dimensions` (`breakdown`, capped by `limit`). Values follow the set's `kind` (`KINDS`): `rate` → percent, ranked by average daily `distinctUsers`; `memory` → as returned (KiB); `count` → summed into `windowTotal` and ranked by it. A tool with several metric sets returns one entry per set under `sections`. `format: "raw"` skips summarizing and returns the API rows.

**Input validation** — `versionCodes` / `apiLevels` must be integers, `startType` / `reportType` / `type` come from fixed lists, and `issueId` is letters and digits only, because they are interpolated into the AIP-160 filter string. Dimensions are whitelisted per metric set.

### Skills installer (`bin/install-skills.js`)

1. Resolves the bundled `skills/` directory via `import.meta.url`.
2. For each entry in `lib/ai-clis.js`: if `parentDir` exists (or `alwaysInstall` is true), iterate the 4 skills and call `installSkill()` from `lib/install-skill.js`.
3. `installSkill()` is idempotent: it returns `installed` for new files, `unchanged` for byte-equal copies, or `updated` (with a `.bak` backup unless `--force`) for diffs. `--dry-run` returns `would-*` statuses without writing.
4. Prints a per-CLI summary; exits 0 unless a hard write failed.

### `postinstall.js`

Banner-only. Skipped on `CI`. Writes to `/dev/tty` first, falls back to stderr. **Never touches the filesystem outside its own stdout** — keeps the package safe for `npm install --ignore-scripts` users.

## Versioning

* Patch (`1.1.x`): bug fixes inside any of the four SKILL bodies, installer fixes.
* Minor (`1.x.0`): new skills, new MCP tools, new CLI targets in `lib/ai-clis.js`.
* Major: breaking changes to the MCP tool surface or the installed skill names.

## Exposed Tools

Metric-set tools accept optional `days` (default `7`), `dimensions` (default `["versionCode"]`), `versionCodes`, `apiLevels`, `limit` (default `10`) and `format` (`summary` | `raw`); startup also accepts `startType`, error counts `reportType`. See `TOOLS` / `METRIC_SETS` in `index.js`.

| Tool | API endpoint | Metrics |
|---|---|---|
| `get_crash_metrics` | `crashRateMetricSet` | `userPerceivedCrashRate` (+ `7dUserWeighted`, `28dUserWeighted`), `crashRate`, `distinctUsers` |
| `get_anr_metrics` | `anrRateMetricSet` | `userPerceivedAnrRate` (+ `7dUserWeighted`, `28dUserWeighted`), `anrRate`, `distinctUsers` |
| `get_slow_rendering_metrics` | `slowRenderingRateMetricSet` | `slowRenderingRate20Fps`, `slowRenderingRate30Fps`, `distinctUsers` |
| `get_startup_time_metrics` | `slowStartRateMetricSet` | `slowStartRate` (+ `7dUserWeighted`, `28dUserWeighted`), `distinctUsers` |
| `get_lmk_metrics` | `lmkRateMetricSet` | `userPerceivedLmkRate` (+ `7dUserWeighted`, `28dUserWeighted`), `distinctUsers` |
| `get_memory_metrics` | `anonRssAndSwapMemoryUsageMetricSet`, `bitmapMemoryUsageMetricSet` | `…P50` – `…P99`, `distinctUsers` |
| `get_battery_metrics` | `excessiveWakeupRateMetricSet`, `stuckBackgroundWakelockRateMetricSet` | `excessiveWakeupRate`, `stuckBgWakelockRate` (+ `7dUserWeighted`, `28dUserWeighted`), `distinctUsers` |
| `get_error_counts` | `errorCountMetricSet` | `errorReportCount`, `distinctUsers` |

Endpoint tools (`ENDPOINT_TOOLS`):

| Tool | API endpoint |
|---|---|
| `search_error_issues` | `errorIssues:search` |
| `get_error_reports` | `errorReports:search` |
| `list_anomalies` | `anomalies` |
| `get_data_freshness` | `GET` on each metric set (`freshnessInfo`) |
| `list_releases` | `apps/{app}:fetchReleaseFilterOptions` |

API constraints worth knowing:
- `crashRateMetricSet` has no `errorReportCount`; requesting it fails the whole query.
- `slowStartRateMetricSet` rejects any query without the `startType` dimension, so startup always includes it.
- `slowRenderingRateMetricSet` returns "only accessible to games" for non-game apps; the server turns that into an explanatory error.
- Google Play's bad-behavior thresholds (1.09 % crash, 0.47 % ANR overall; 8 % per phone model) apply to the `userPerceived*` metrics, not the plain rates.
- `errorCountMetricSet` requires the `reportType` dimension; its filter accepts `CRASH` and `ANR` (`NON_FATAL` is rejected). It has no `countryCode` / `deviceBrand` breakdown but adds `issueId`.
- Error issue / report search only accepts UTC intervals (`America/Los_Angeles` returns 400) and, without an interval, uses a much shorter default window than you'd expect — always send one.
- Memory values are undocumented but read as KiB they match Play Console within ~1%; the Console's anon RSS + swap figure tracks `appState = APP_STATE_FOREGROUND`, while the overall here includes cached and background processes.
- Anomaly values for rate metrics come back as percentages, unlike metric-set queries (fractions).
- `ErrorIssue.cause` / `location` can arrive swapped relative to Google's field docs (cause holding the frame, location the exception / ANR type).

## Service Account Key

The `service-key/` directory is where the Google Service Account JSON key should be placed. Do not commit key files to version control.
