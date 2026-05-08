import { mkdir, readFile, writeFile, rename, access, readdir, stat } from "node:fs/promises";
import path from "node:path";

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function* walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

// Per-file copy with the 4-state idempotency machine. Returns one of:
// "installed" | "unchanged" | "updated" | "would-install" | "would-skip" | "would-update".
async function copyFile(srcFile, destFile, { force, dryRun }) {
  const srcContent = await readFile(srcFile, "utf8");
  const destExists = await exists(destFile);

  if (!destExists) {
    if (dryRun) return "would-install";
    await mkdir(path.dirname(destFile), { recursive: true });
    await writeFile(destFile, srcContent, "utf8");
    return "installed";
  }

  const destContent = await readFile(destFile, "utf8");
  if (destContent === srcContent) {
    return dryRun ? "would-skip" : "unchanged";
  }

  if (dryRun) return "would-update";

  if (!force) {
    await rename(destFile, `${destFile}.bak`);
  }
  await mkdir(path.dirname(destFile), { recursive: true });
  await writeFile(destFile, srcContent, "utf8");
  return "updated";
}

const SEVERITY = {
  unchanged: 0,
  "would-skip": 0,
  installed: 1,
  "would-install": 1,
  updated: 2,
  "would-update": 2,
};

function rollUp(perFile) {
  let worst = "unchanged";
  for (const { status } of perFile) {
    if ((SEVERITY[status] ?? 0) > (SEVERITY[worst] ?? 0)) worst = status;
  }
  return worst;
}

// Mirrors every file under srcDir into destDir. Each file goes through the
// per-file idempotency machine independently. Returns:
//   { overall: "installed"|"unchanged"|"updated"|"would-*",
//     perFile: [{ relPath, status }, ...] }
export async function installSkill(srcDir, destDir, { force = false, dryRun = false } = {}) {
  if (!(await exists(srcDir))) {
    throw new Error(`Source skill directory does not exist: ${srcDir}`);
  }
  const srcStat = await stat(srcDir);
  if (!srcStat.isDirectory()) {
    throw new Error(`Source skill path is not a directory: ${srcDir}`);
  }

  const perFile = [];
  for await (const srcFile of walkFiles(srcDir)) {
    const relPath = path.relative(srcDir, srcFile);
    const destFile = path.join(destDir, relPath);
    const status = await copyFile(srcFile, destFile, { force, dryRun });
    perFile.push({ relPath, status });
  }

  return { overall: rollUp(perFile), perFile };
}
