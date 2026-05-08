# android-vitals-mcp

An MCP (Model Context Protocol) server **plus** auto-installable agent skills for Android Vitals. It lets AI agents:

1. **Fetch** crash, ANR, slow-rendering, and startup-time metrics from the Google Play Developer Reporting API (the MCP tools).
2. **Diagnose and remediate** regressions in those metrics through four guided skills that interpret thresholds and prescribe Android-specific fixes.

## Prerequisites

1. **Google Cloud Project** linked to your Google Play Console.
2. **Service Account JSON key** with the `https://www.googleapis.com/auth/playdeveloperreporting` scope.
3. **Play Console permission**: the Service Account email must be invited to the Google Play Console with at least "View app information (read-only)".
4. **Node.js** ≥ 18.

## Install

```bash
npm install -g android-vitals-mcp
```

Or run directly with `npx` (no install needed). After install you'll see a banner pointing at the two surfaces:

* `npx android-vitals-mcp` — start the MCP server.
* `npx android-vitals-install-skills` — install the four "improve android vitals" skills into every detected AI CLI.

## Configure the MCP server

Register the server in your MCP host (Claude Code's `~/.claude.json`, Gemini CLI's `~/.gemini/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "android-vitals": {
      "command": "npx",
      "args": ["-y", "android-vitals-mcp"],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/absolute/path/to/your-service-account-key.json",
        "ANDROID_PACKAGE_NAME": "com.your.company.app"
      }
    }
  }
}
```

### Environment variables

* `GOOGLE_APPLICATION_CREDENTIALS` — absolute path to your Service Account JSON key.
* `ANDROID_PACKAGE_NAME` — your app's package id, e.g. `com.example.myapp`.

### MCP tools

All tools accept an optional `days` argument (default `7`).

| Tool | Returns |
|---|---|
| `get_crash_metrics` | crash rate, error report count, distinct users affected |
| `get_anr_metrics` | ANR rate, 7-day user-weighted ANR rate, distinct users |
| `get_slow_rendering_metrics` | slow rendering rates at the 20 fps and 30 fps thresholds |
| `get_startup_time_metrics` | slow start rate, dimensioned by `startType` (COLD / WARM / HOT) |

## Install the skills

After the MCP is configured, run the skills installer **once** to drop guided playbooks into every detected AI CLI:

```bash
npx android-vitals-install-skills            # install everywhere detected
npx android-vitals-install-skills --dry-run  # preview changes
npx android-vitals-install-skills --force    # overwrite without .bak files
npx android-vitals-install-skills --cli claude  # only Claude Code
```

The installer writes one `SKILL.md` per skill into each CLI's `skills/` directory it detects (Claude Code, Gemini CLI, Codex, Copilot, Cursor, Cline, Kiro, Antigravity, Amp, OpenCode, and the `~/.agents/skills/` standard). CLIs whose dot-dir doesn't exist are skipped silently.

### Skills installed

Each skill auto-activates on relevant keywords, calls the matching MCP tool, interprets Google Play "core technical quality" thresholds, and walks the agent through Android-specific remediations.

| Skill | Triggers on | Pairs with MCP tool |
|---|---|---|
| `improve-android-crash-rate` | "crash rate", "improve crashes", "crash-free users" | `get_crash_metrics` |
| `improve-android-anr` | "ANR", "app not responding", "main-thread freeze" | `get_anr_metrics` |
| `improve-android-slow-rendering` | "jank", "slow rendering", "dropped frames" | `get_slow_rendering_metrics` |
| `improve-android-startup-time` | "cold start", "TTID", "improve startup" | `get_startup_time_metrics` |

After installing the skills, ask your agent: **"improve my Android crash rate"**.

## Idempotency

Re-running `android-vitals-install-skills` is safe:
* If a `SKILL.md` already exists and is byte-identical → no-op (`= unchanged`).
* If it differs → the existing file is renamed to `SKILL.md.bak` and the new one is written (`↻ updated`). Pass `--force` to skip the backup.
* `--dry-run` reports what *would* change without touching disk.

## Source / issues

[github.com/naufaldiath/android-vital-mcp](https://github.com/naufaldiath/android-vital-mcp) (replace with your actual repo).
