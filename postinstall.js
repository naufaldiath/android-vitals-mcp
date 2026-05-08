#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Skip in CI / non-interactive installs.
if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) {
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

const title = `android-vitals-mcp v${pkg.version} installed!`;
const innerWidth = 58;
const lpad = Math.max(0, Math.floor((innerWidth - title.length) / 2));
const rpad = Math.max(0, innerWidth - title.length - lpad);
const banner = `║${" ".repeat(lpad)}${title}${" ".repeat(rpad)}║`;

const msg = `
╔══════════════════════════════════════════════════════════╗
${banner}
╚══════════════════════════════════════════════════════════╝

Two surfaces ship with this package:

  1. MCP server:
       npx android-vitals-mcp

  2. "Improve Android Vitals" skills (Claude Code, Gemini,
     Codex, Copilot, Cursor, Cline, Kiro, …):
       npx android-vitals-install-skills

The skills installer is opt-in — run it once to drop four
skills into every detected AI CLI's skills directory:

  - improve-android-crash-rate
  - improve-android-anr
  - improve-android-slow-rendering
  - improve-android-startup-time

Then ask your agent: "improve my Android crash rate".

`;

// Try TTY first (most reliable), fall back to stderr. Wait for flush.
try {
  const tty = fs.openSync("/dev/tty", "w");
  fs.writeSync(tty, msg);
  fs.closeSync(tty);
  process.exit(0);
} catch {
  process.stderr.write(msg, () => process.exit(0));
}
