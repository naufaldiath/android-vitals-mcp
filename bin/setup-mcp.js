#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";

const home = os.homedir();

// AI CLIs that support MCP server config, with the file path they use
const MCP_TARGETS = [
  {
    name: "claude",
    displayName: "Claude Code",
    parentDir: path.join(home, ".claude"),
    configFile: path.join(home, ".claude.json"),
    alwaysInstall: true,
  },
  {
    name: "gemini",
    displayName: "Gemini CLI",
    parentDir: path.join(home, ".gemini"),
    configFile: path.join(home, ".gemini", "settings.json"),
  },
  {
    name: "cursor",
    displayName: "Cursor",
    parentDir: path.join(home, ".cursor"),
    configFile: path.join(home, ".cursor", "mcp.json"),
  },
  {
    name: "kiro",
    displayName: "Kiro (AWS)",
    parentDir: path.join(home, ".kiro"),
    configFile: path.join(home, ".kiro", "settings", "mcp.json"),
  },
];

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function readJson(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function writeJson(filePath, data, dryRun) {
  if (!dryRun) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
}

function parseArgs(argv) {
  const args = { dryRun: false, help: false, cli: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--cli") args.cli = argv[++i];
    else if (a.startsWith("--cli=")) args.cli = a.slice("--cli=".length);
  }
  return args;
}

function printHelp() {
  console.log(`android-vitals-mcp-setup

Registers the android-vitals MCP server in every detected AI CLI config file.
Prompts for your Google Service Account key path and Android package name,
then writes the "android-vitals" entry under mcpServers in each config.

Usage:
  android-vitals-mcp-setup [options]

Options:
  --dry-run, -n        Preview changes without writing files
  --cli <name>         Limit to one CLI (claude, gemini, cursor, kiro)
  --help, -h           Show this help

Supported AI CLIs and their config files:
  claude   → ~/.claude.json
  gemini   → ~/.gemini/settings.json
  cursor   → ~/.cursor/mcp.json
  kiro     → ~/.kiro/settings/mcp.json
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return 0;
  }

  let targets = MCP_TARGETS;
  if (args.cli) {
    targets = targets.filter((t) => t.name === args.cli);
    if (targets.length === 0) {
      console.error(`Unknown --cli value: "${args.cli}". Valid options: ${MCP_TARGETS.map((t) => t.name).join(", ")}`);
      return 2;
    }
  }

  console.log(`\nandroid-vitals-mcp setup${args.dryRun ? " [dry-run]" : ""}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Prompt for credentials
  let credPath = (await prompt(rl, "Path to Google Service Account JSON key file:\n> ")).trim();

  if (credPath.startsWith("~/")) {
    credPath = path.join(home, credPath.slice(2));
  }
  if (!credPath) {
    console.error("\nError: path is required.");
    rl.close();
    return 1;
  }
  if (!existsSync(credPath)) {
    console.warn(`\nWarning: no file found at "${credPath}" — registering anyway, but the server will fail to authenticate until the file exists.\n`);
  }

  let packageName = (await prompt(rl, "\nAndroid package name (e.g. com.example.myapp):\n> ")).trim();
  rl.close();

  if (!packageName) {
    console.error("\nError: package name is required.");
    return 1;
  }

  const mcpEntry = {
    command: "npx",
    args: ["-y", "android-vitals-mcp"],
    env: {
      GOOGLE_APPLICATION_CREDENTIALS: credPath,
      ANDROID_PACKAGE_NAME: packageName,
    },
  };

  console.log("\nRegistering MCP server...\n");

  let registered = 0;
  for (const target of targets) {
    const detected = existsSync(target.parentDir);
    if (!detected && !target.alwaysInstall) {
      console.log(`  - ${target.displayName.padEnd(18)} skipped (not installed at ${target.parentDir})`);
      continue;
    }

    const config = readJson(target.configFile);
    const existed = !!(config.mcpServers?.["android-vitals"]);

    config.mcpServers = { ...config.mcpServers, "android-vitals": mcpEntry };
    writeJson(target.configFile, config, args.dryRun);
    registered++;

    const verb = args.dryRun
      ? (existed ? "would update" : "would register")
      : (existed ? "updated" : "registered");
    console.log(`  ✓ ${target.displayName.padEnd(18)} ${verb.padEnd(16)} ${target.configFile}`);
  }

  console.log("");
  if (args.dryRun) {
    console.log("Dry-run complete. No files were written.");
  } else if (registered > 0) {
    console.log("Done! Restart your AI CLI to load the android-vitals MCP server.");
    console.log("\nTip: also run  npx android-vitals-install-skills  to install the guided skill playbooks.");
  } else {
    console.log("No supported AI CLIs detected. Run with --help to see supported tools.");
  }

  return 0;
}

main().then(
  (code) => { process.exitCode = code ?? 0; },
  (err) => {
    console.error(err.message);
    process.exitCode = 1;
  },
);
