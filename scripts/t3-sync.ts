#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// Pulls upstream into this fork and reports which UI strings need a translation.
//
// The build-time transform (apps/web/vite/localizeI18n.ts) handles the wrapping,
// so syncing is: merge, find strings the dictionary lacks, translate those.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeChildProcess from "node:child_process";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

function run(command: string, args: ReadonlyArray<string>): void {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status ?? "unknown"}`);
  }
}

async function readDictionaryKeys() {
  const source = await NodeFSP.readFile(
    NodePath.join(repoRoot, "apps/web/src/i18n/zh-CN.ts"),
    "utf8",
  );
  const keys = new Set<string>();
  for (const match of source.matchAll(/^\s{2}(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$]*)):/gm)) {
    keys.add(match[1] === undefined ? match[2] : JSON.parse(`"${match[1]}"`));
  }
  return keys;
}

const step = (message: string) => NodeProcess.stdout.write(`\n▸ ${message}\n`);

if (!NodeProcess.argv.includes("--report-only")) {
  step("Fetching upstream");
  run("git", ["fetch", "upstream", "main", "--tags"]);
  run("bash", ["scripts/sync-upstream.sh", "upstream/main"]);
}

step("Checking which UI strings still need a translation");
const keys = await readDictionaryKeys();

const { localizeModule } = await import(
  new URL("../apps/web/vite/localizeI18n.ts", import.meta.url).href
).catch(() => ({ localizeModule: null }));

if (localizeModule === null) {
  NodeProcess.stdout.write(
    "Could not load the transform to check coverage. Run the build to see missing keys.\n",
  );
  NodeProcess.exit(0);
}

const sourceRoot = NodePath.join(repoRoot, "apps/web/src");
const missing = new Set<string>();

async function walk(directory: string): Promise<void> {
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "i18n") continue;
    const full = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (!/\.[jt]sx$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
    const source = await NodeFSP.readFile(full, "utf8");
    const output = localizeModule(source, full.replaceAll("\\", "/"), "../i18n");
    if (output === null) continue;
    for (const match of output.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)) {
      const key = JSON.parse(`"${match[1]}"`);
      if (!keys.has(key)) missing.add(key);
    }
  }
}

await walk(sourceRoot);

if (missing.size === 0) {
  NodeProcess.stdout.write("Every string on screen has a translation.\n");
} else {
  const sorted = [...missing].sort((left, right) => left.localeCompare(right));
  NodeProcess.stdout.write(
    `${sorted.length} string${sorted.length === 1 ? "" : "s"} need a translation in apps/web/src/i18n/zh-CN.ts:\n\n`,
  );
  for (const key of sorted) NodeProcess.stdout.write(`  ${JSON.stringify(key)},\n`);
}

step("Next");
NodeProcess.stdout.write(
  [
    "  Translate the strings above, then:",
    "    git add -A && git commit -m 'chore(i18n): sync translations'",
    "    git push origin main",
    "",
    "  Build the Chinese desktop app:",
    "    $env:T3CODE_WEB_LOCALE='zh-CN'; npm run dist:desktop:win",
    "",
  ].join("\n"),
);
