import os from "node:os";
import path from "node:path";

// Canonical list of AI CLI skills directories. Mirrors the targets used by
// crash-to-vibe so a single skill payload reaches every supported tool.
//
// `parentDir` is the dot-dir whose existence signals the CLI is installed.
// We skip writing to a CLI when its parent dir does not exist — except for
// `alwaysInstall` entries (Claude Code) which we always create.
export function getAiCliTargets() {
  const home = os.homedir();
  return [
    {
      name: "claude",
      displayName: "Claude Code",
      parentDir: path.join(home, ".claude"),
      skillsDir: path.join(home, ".claude", "skills"),
      alwaysInstall: true,
    },
    {
      name: "gemini",
      displayName: "Gemini CLI",
      parentDir: path.join(home, ".gemini"),
      skillsDir: path.join(home, ".gemini", "skills"),
    },
    {
      name: "codex",
      displayName: "OpenAI Codex CLI",
      parentDir: path.join(home, ".codex"),
      skillsDir: path.join(home, ".codex", "skills"),
    },
    {
      name: "copilot",
      displayName: "GitHub Copilot CLI",
      parentDir: path.join(home, ".copilot"),
      skillsDir: path.join(home, ".copilot", "skills"),
    },
    {
      name: "cursor",
      displayName: "Cursor",
      parentDir: path.join(home, ".cursor"),
      skillsDir: path.join(home, ".cursor", "skills"),
    },
    {
      name: "cline",
      displayName: "Cline",
      parentDir: path.join(home, ".cline"),
      skillsDir: path.join(home, ".cline", "skills"),
    },
    {
      name: "kiro",
      displayName: "Kiro (AWS)",
      parentDir: path.join(home, ".kiro"),
      skillsDir: path.join(home, ".kiro", "skills"),
    },
    {
      name: "antigravity",
      displayName: "Antigravity",
      parentDir: path.join(home, ".antigravity"),
      skillsDir: path.join(home, ".antigravity", "skills"),
    },
    {
      name: "amp",
      displayName: "Amp (Sourcegraph)",
      parentDir: path.join(home, ".config", "amp"),
      skillsDir: path.join(home, ".config", "amp", "skills"),
    },
    {
      name: "opencode",
      displayName: "OpenCode",
      parentDir: path.join(home, ".config", "opencode"),
      skillsDir: path.join(home, ".config", "opencode", "skills"),
    },
    {
      name: "agents",
      displayName: "Agent Skills standard",
      parentDir: path.join(home, ".agents"),
      skillsDir: path.join(home, ".agents", "skills"),
      alwaysInstall: true,
    },
  ];
}

export const SKILL_NAMES = [
  "improve-android-crash-rate",
  "improve-android-anr",
  "improve-android-slow-rendering",
  "improve-android-startup-time",
];
