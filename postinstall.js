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

Get started in two commands:

  1. Connect your Google Play Console:
       npx android-vitals-mcp-setup

  2. Install the skill playbooks into every detected AI CLI:
       npx android-vitals-install-skills

Then restart your AI CLI and ask:
  "improve my Android crash rate"

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
