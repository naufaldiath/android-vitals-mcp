#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { getAiCliTargets, SKILL_NAMES } from "../lib/ai-clis.js";
import { installSkill } from "../lib/install-skill.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const BUNDLED_SKILLS_DIR = path.join(PACKAGE_ROOT, "skills");

function parseArgs(argv) {
  const args = { force: false, dryRun: false, cli: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force" || a === "-f") args.force = true;
    else if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--cli") args.cli = argv[++i];
    else if (a.startsWith("--cli=")) args.cli = a.slice("--cli=".length);
  }
  return args;
}

function printHelp() {
  console.log(`android-vitals-install-skills

Installs the 4 "improve android vitals" skills into every detected AI CLI.

Usage:
  android-vitals-install-skills [options]

Options:
  --dry-run, -n        Preview actions without writing files
  --force, -f          Overwrite existing skills without creating .bak files
  --cli <name>         Limit installation to one CLI (claude, gemini, codex,
                       copilot, cursor, cline, kiro, antigravity, amp,
                       opencode, agents)
  --help, -h           Show this help

Skills installed:
${SKILL_NAMES.map((s) => `  - ${s}`).join("\n")}
`);
}

const STATUS_GLYPH = {
  installed: "✓ installed",
  unchanged: "= unchanged",
  updated: "↻ updated",
  "would-install": "✓ would install",
  "would-skip": "= would skip (unchanged)",
  "would-update": "↻ would update",
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  let targets = getAiCliTargets();
  if (args.cli) {
    targets = targets.filter((t) => t.name === args.cli);
    if (targets.length === 0) {
      console.error(`Unknown --cli value: ${args.cli}`);
      return 2;
    }
  }

  console.log(
    `\nandroid-vitals-mcp: installing ${SKILL_NAMES.length} skill(s)${
      args.dryRun ? " [dry-run]" : ""
    }\n`,
  );

  let hadError = false;
  for (const target of targets) {
    const detected = existsSync(target.parentDir);
    if (!detected && !target.alwaysInstall) {
      console.log(`→ ${target.displayName}: skipped (not detected at ${target.parentDir})`);
      continue;
    }

    console.log(`${target.displayName}  (${target.skillsDir})`);
    for (const skillName of SKILL_NAMES) {
      const srcDir = path.join(BUNDLED_SKILLS_DIR, skillName);
      const destDir = path.join(target.skillsDir, skillName);
      try {
        const { overall, perFile } = await installSkill(srcDir, destDir, {
          force: args.force,
          dryRun: args.dryRun,
        });
        const fileCount = perFile.length;
        const refCount = perFile.filter((f) => f.relPath.startsWith(`references${path.sep}`)).length;
        const summary = refCount > 0 ? `(SKILL.md + ${refCount} reference${refCount === 1 ? "" : "s"})` : `(${fileCount} file${fileCount === 1 ? "" : "s"})`;
        console.log(`  ${STATUS_GLYPH[overall] || overall}  ${skillName} ${summary}`);
      } catch (err) {
        hadError = true;
        console.error(`  ✗ failed       ${skillName}: ${err.message}`);
      }
    }
    console.log("");
  }

  if (args.dryRun) {
    console.log("Dry-run complete. No files were modified.");
  } else {
    console.log("Done. Open your AI CLI and try: \"improve my Android crash rate\".");
  }
  return hadError ? 1 : 0;
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
