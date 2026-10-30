const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function commit(cwd, ref) {
  const sha = git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid commit identity");
  return sha;
}

function index(cwd) {
  return git(cwd, ["ls-files", "--stage", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      const [mode, oid, stage] = record.slice(0, tab).split(" ");
      return { path: record.slice(tab + 1), stage: Number(stage), value: `${mode} ${oid}` };
    });
}

function protectedPath(file) {
  return (
    file.startsWith(".github/") ||
    file.startsWith(".codex/") ||
    file.startsWith(".agents/") ||
    file === ".mcp.json" ||
    file.startsWith("scripts/") ||
    path.posix.basename(file) === "AGENTS.md" ||
    path.posix.basename(file).startsWith(".git")
  );
}

function prepare(cwd, directory, target, syncScript) {
  const relative = path.relative(cwd, directory);
  if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    throw new Error("Repair state must stay outside the agent's writable checkout");
  }
  if (git(cwd, ["status", "--porcelain"]).trim()) throw new Error("Checkout is not clean");
  fs.mkdirSync(directory, { recursive: true });
  const base = commit(cwd, "HEAD");
  const upstream = commit(cwd, target);
  const result = spawnSync("bash", [syncScript, upstream, "--prepare-repair"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: path.join(directory, "prepare-output") },
  });
  if (result.status !== 0) throw new Error(result.stderr || "Cannot prepare upstream merge");
  const entries = index(cwd);
  const conflicts = [
    ...new Set(entries.filter((entry) => entry.stage !== 0).map((entry) => entry.path)),
  ];
  if (!conflicts.length) {
    output("conflicted", "false");
    return null;
  }
  if (conflicts.length > 30 || conflicts.some(protectedPath)) {
    throw new Error("Conflict touches automation/policy files or exceeds the 30-file repair limit");
  }
  for (const entry of entries.filter((item) => item.stage !== 0)) {
    const [mode, oid] = entry.value.split(" ");
    if (
      !["100644", "100755"].includes(mode) ||
      Number(git(cwd, ["cat-file", "-s", oid])) > 2 * 1024 * 1024
    ) {
      throw new Error("Automatic repair requires regular text conflicts smaller than 2 MiB");
    }
    if (git(cwd, ["cat-file", "blob", oid], { encoding: null }).includes(0)) {
      throw new Error("Automatic repair requires text conflicts, not binary data");
    }
  }
  const manifest = {
    base,
    upstream,
    conflicts,
    entries: entries.filter((entry) => entry.stage === 0),
  };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, "conflicts.json"), JSON.stringify(conflicts, null, 2));
  output("base", base);
  output("upstream", upstream);
  output("conflicted", "true");
  return manifest;
}

function exportResolution(cwd, directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  if (commit(cwd, "HEAD") !== manifest.base || commit(cwd, "MERGE_HEAD") !== manifest.upstream) {
    throw new Error("Agent changed the pinned merge history");
  }
  if (manifest.conflicts.some(protectedPath)) throw new Error("Protected repair path");
  git(cwd, ["add", "--all"]);
  git(cwd, ["diff", "--cached", "--check", "--", ...manifest.conflicts]);
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry.value]));
  const actual = new Map(index(cwd).map((entry) => [entry.path, entry.value]));
  const allowed = new Set(manifest.conflicts);
  for (const file of new Set([...expected.keys(), ...actual.keys()])) {
    if (!allowed.has(file) && expected.get(file) !== actual.get(file)) {
      throw new Error(`Agent modified a non-conflicting file: ${file}`);
    }
  }
  if (
    git(cwd, ["diff", "--cached", "--name-only", manifest.base, "--", ".github/workflows"]).trim()
  ) {
    throw new Error("Repair changes the fork's workflows");
  }
  const patch = git(cwd, [
    "diff",
    "--cached",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    manifest.base,
  ]);
  manifest.tree = git(cwd, ["write-tree"]).trim();
  fs.writeFileSync(path.join(directory, "resolution.patch"), patch);
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

function materialize(cwd, directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  if (commit(cwd, "HEAD") !== manifest.base) throw new Error("Candidate base changed");
  commit(cwd, manifest.upstream);
  git(cwd, ["apply", "--cached", path.join(directory, "resolution.patch")]);
  const tree = git(cwd, ["write-tree"]).trim();
  if (tree !== manifest.tree)
    throw new Error("Candidate tree does not match the checked repair artifact");
  const sha = git(cwd, ["commit-tree", tree, "-p", manifest.base, "-p", manifest.upstream], {
    input: "chore: sync upstream with Codex conflict resolution\n",
  }).trim();
  output("commit", sha);
  return sha;
}

function promote(cwd, base, candidate) {
  git(cwd, ["fetch", "--no-tags", "origin", "main"]);
  if (commit(cwd, "FETCH_HEAD") !== base) {
    output("promoted", "false");
    return false;
  }
  git(cwd, ["fetch", "--no-tags", "origin", candidate]);
  const parents = git(cwd, ["rev-list", "--parents", "-n", "1", candidate]).trim().split(" ");
  if (parents.length !== 3 || parents[1] !== base)
    throw new Error("Candidate is not the expected merge");
  git(cwd, ["push", "origin", `${candidate}:refs/heads/main`]);
  output("promoted", "true");
  return true;
}

module.exports = { prepare, exportResolution, materialize, promote };

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "prepare") prepare(process.cwd(), ...args);
    else if (command === "export") exportResolution(process.cwd(), ...args);
    else if (command === "materialize")
      process.stdout.write(`${materialize(process.cwd(), ...args)}\n`);
    else if (command === "promote") promote(process.cwd(), ...args);
    else throw new Error("Unknown repair controller command");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
