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
index.js                    # MCP server (unchanged from 1.0.x)
bin/install-skills.js       # Skills installer CLI (#!/usr/bin/env node)
postinstall.js              # Post-install banner only — no FS writes
lib/ai-clis.js              # Canonical list of AI-CLI skills directories
lib/install-skill.js        # Idempotent SKILL.md copier (installed/unchanged/updated)
skills/<skill-name>/SKILL.md # 4 bundled skill payloads
```

### MCP server (`index.js`)

1. Authenticates via `google.auth.GoogleAuth` using the service account key file.
2. Registers two handlers on the `Server` instance:
   - `ListToolsRequestSchema` — returns the 4 tool definitions
   - `CallToolRequestSchema` — dispatches to the correct `reporting.vitals.*` API call
3. Starts a `StdioServerTransport`.

**`getTimeRange(days)`** — builds UTC-aligned start/end times. It subtracts 2 days from today before computing the range to account for Google Play's data freshness delay.

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

All tools accept an optional `days` argument (default: `7`) and return raw JSON from the API.

| Tool | API endpoint | Metrics |
|---|---|---|
| `get_crash_metrics` | `crashRateMetricSet` | `crashRate`, `errorReportCount`, `distinctUsers` |
| `get_anr_metrics` | `anrRateMetricSet` | `anrRate`, `anrRate7dUserWeighted`, `distinctUsers` |
| `get_slow_rendering_metrics` | `slowRenderingRateMetricSet` | `slowRenderingRate20Fps`, `slowRenderingRate30Fps` |
| `get_startup_time_metrics` | `slowStartRateMetricSet` | `slowStartRate` (also dimensions on `startType`) |

All tools dimension by `apiLevel` and `versionCode`; startup additionally dimensions by `startType`.

## Service Account Key

The `service-key/` directory is where the Google Service Account JSON key should be placed. Do not commit key files to version control.
