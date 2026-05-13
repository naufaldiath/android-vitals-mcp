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

Each skill auto-activates on relevant keywords, fetches live metrics from Google Play, interprets Google's "core technical quality" thresholds, and walks your agent through Android-specific remediations.

| Skill | Triggers on | Metrics fetched |
|---|---|---|
| `improve-android-crash-rate` | "crash rate", "improve crashes", "crash-free users" | crash rate, error report count, distinct users |
| `improve-android-anr` | "ANR", "app not responding", "main-thread freeze" | ANR rate, 7-day user-weighted ANR rate |
| `improve-android-slow-rendering` | "jank", "slow rendering", "dropped frames" | slow rendering rates at 20 fps and 30 fps |
| `improve-android-startup-time` | "cold start", "TTID", "improve startup" | slow start rate by `startType` (COLD / WARM / HOT) |

### Available MCP tools

All tools accept an optional `days` argument (default `7`) and are called automatically by the skills above.

| Tool | Returns |
|---|---|
| `get_crash_metrics` | crash rate, error report count, distinct users affected |
| `get_anr_metrics` | ANR rate, 7-day user-weighted ANR rate, distinct users |
| `get_slow_rendering_metrics` | slow rendering rates at the 20 fps and 30 fps thresholds |
| `get_startup_time_metrics` | slow start rate, dimensioned by `startType` |

---

## Idempotency

Both commands are safe to re-run:

- `android-vitals-mcp setup`: overwrites only the `"android-vitals"` key under `mcpServers`; all other config in the file is preserved.
- `android-vitals-install-skills`: no-op if the skill is already byte-identical (`= unchanged`); otherwise renames the old file to `.bak` before writing (`↻ updated`). Pass `--force` to skip the backup.
