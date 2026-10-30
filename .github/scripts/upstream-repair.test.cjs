const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { prepare, exportResolution, materialize, promote } = require("./upstream-repair.cjs");

const syncScript = path.resolve(__dirname, "../../scripts/sync-upstream.sh");

function fixture(t, conflictFile = "app.txt") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-repair-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  const git = (cwd, ...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), value);
  };
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Repair test");
  git(repo, "config", "user.email", "repair@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  write(conflictFile, "base code\n");
  write("kept.txt", "fork data\n");
  write(".github/workflows/removed.yml", "base workflow\n");
  write(".github/workflows/keep.yml", "fork workflow\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const common = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-b", "upstream");
  write(conflictFile, "upstream code\n");
  write("new-upstream.txt", "new upstream functionality\n");
  write(".github/workflows/removed.yml", "upstream workflow\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "upstream changes");
  const upstream = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "main");
  write(conflictFile, "custom fork code\n");
  git(repo, "rm", ".github/workflows/removed.yml");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "fork changes");
  const base = git(repo, "rev-parse", "HEAD");
  const clone = () => {
    const destination = path.join(root, `candidate-${fs.readdirSync(root).length}`);
    git(root, "clone", "--quiet", "--shared", repo, destination);
    git(destination, "checkout", "--detach", base);
    git(destination, "config", "user.name", "Repair test");
    git(destination, "config", "user.email", "repair@example.invalid");
    return destination;
  };
  const start = () => prepare(repo, state, upstream, syncScript);
  const resolve = () => {
    write(conflictFile, "upstream functionality with custom fork support\n");
    return exportResolution(repo, state);
  };
  return { root, repo, state, git, write, common, base, upstream, clone, start, resolve };
}

test("prepares real conflicts without committing or losing the fork's workflow deletions", (t) => {
  const f = fixture(t);
  const result = f.start();
  assert.deepEqual(result.conflicts, ["app.txt"]);
  assert.equal(result.base, f.base);
  assert.equal(result.upstream, f.upstream);
  assert.equal(f.git(f.repo, "rev-parse", "HEAD"), f.base);
  assert.equal(fs.existsSync(path.join(f.repo, ".github/workflows/removed.yml")), false);
});

test("exports a scoped repair and reconstructs an exact merge with both parents", (t) => {
  const f = fixture(t);
  f.start();
  const result = f.resolve();
  const destination = f.clone();
  const candidate = materialize(destination, f.state);
  assert.equal(f.git(destination, "rev-parse", `${candidate}^{tree}`), result.tree);
  assert.equal(f.git(destination, "rev-parse", `${candidate}^1`), f.base);
  assert.equal(f.git(destination, "rev-parse", `${candidate}^2`), f.upstream);
  assert.equal(
    f.git(destination, "show", `${candidate}:app.txt`),
    "upstream functionality with custom fork support",
  );
  assert.equal(
    f.git(destination, "show", `${candidate}:new-upstream.txt`),
    "new upstream functionality",
  );
  assert.equal(f.git(destination, "show", `${candidate}:kept.txt`), "fork data");
  assert.equal(f.git(destination, "diff", f.base, candidate, "--", ".github/workflows"), "");
});

test("rejects unresolved markers even when the agent says it is done", (t) => {
  const f = fixture(t);
  f.start();
  assert.throws(() => exportResolution(f.repo, f.state));
});

test("preserves an upstream deletion when it is the chosen conflict resolution", (t) => {
  const f = fixture(t);
  f.git(f.repo, "checkout", "upstream");
  f.git(f.repo, "rm", "app.txt");
  f.git(f.repo, "commit", "-m", "upstream removes obsolete code");
  const upstream = f.git(f.repo, "rev-parse", "HEAD");
  f.git(f.repo, "checkout", "main");
  prepare(f.repo, f.state, upstream, syncScript);
  fs.rmSync(path.join(f.repo, "app.txt"));
  exportResolution(f.repo, f.state);
  const destination = f.clone();
  const candidate = materialize(destination, f.state);
  assert.equal(f.git(destination, "ls-tree", candidate, "--", "app.txt"), "");
  assert.equal(f.git(destination, "rev-parse", `${candidate}^2`), upstream);
});

test("rejects binary conflicts instead of silently accepting the working copy", (t) => {
  const f = fixture(t);
  f.git(f.repo, "checkout", "upstream");
  f.write("app.txt", Buffer.from([0, 1, 2]));
  f.git(f.repo, "add", "app.txt");
  f.git(f.repo, "commit", "-m", "binary upstream");
  const upstream = f.git(f.repo, "rev-parse", "HEAD");
  f.git(f.repo, "checkout", "main");
  f.write("app.txt", Buffer.from([0, 3, 4]));
  f.git(f.repo, "add", "app.txt");
  f.git(f.repo, "commit", "-m", "binary fork");
  assert.throws(() => prepare(f.repo, f.state, upstream, syncScript), /text conflicts/);
});

test("rejects edits to automatically merged source outside the conflict set", (t) => {
  const f = fixture(t);
  f.start();
  f.write("new-upstream.txt", "discard upstream functionality\n");
  assert.throws(f.resolve, /non-conflicting file/);
});

test("rejects new files and workflow edits outside the original conflict set", (t) => {
  const f = fixture(t);
  f.start();
  f.write("extra.txt", "unrequested code\n");
  assert.throws(f.resolve, /non-conflicting file/);
  fs.rmSync(path.join(f.repo, "extra.txt"));
  f.git(f.repo, "reset", "--", "extra.txt");
  f.write(".github/workflows/keep.yml", "alter CI\n");
  assert.throws(f.resolve, /non-conflicting file/);
});

test("does not hand policy conflicts to an unattended agent", (t) => {
  const f = fixture(t, "AGENTS.md");
  assert.throws(f.start, /automation\/policy/);
});

test("rejects agent-created commits instead of silently changing ancestry", (t) => {
  const f = fixture(t);
  f.start();
  f.resolve();
  f.git(f.repo, "commit", "-m", "agent commit");
  assert.throws(() => exportResolution(f.repo, f.state), /pinned merge history/);
});

test("requires repair state to stay outside the editable repository", (t) => {
  const f = fixture(t);
  assert.throws(
    () => prepare(f.repo, path.join(f.repo, "state"), f.upstream, syncScript),
    /outside/,
  );
});

test("does not touch a checkout that contains user changes", (t) => {
  const f = fixture(t);
  f.write("kept.txt", "uncommitted user work\n");
  assert.throws(f.start, /not clean/);
  assert.equal(f.git(f.repo, "rev-parse", "HEAD"), f.base);
  assert.equal(fs.readFileSync(path.join(f.repo, "kept.txt"), "utf8"), "uncommitted user work\n");
});

test("leaves clean merges to the normal sync instead of paying for AI", (t) => {
  const f = fixture(t);
  f.git(f.repo, "checkout", "--detach", f.common);
  assert.equal(f.start(), null);
  assert.equal(f.git(f.repo, "rev-parse", "HEAD"), f.common);
  assert.equal(f.git(f.repo, "status", "--porcelain"), "");
});

test("does not start an agent when upstream is already present", (t) => {
  const f = fixture(t);
  f.git(f.repo, "checkout", "--detach", f.upstream);
  assert.equal(f.start(), null);
  assert.equal(f.git(f.repo, "status", "--porcelain"), "");
});

test("rejects an altered artifact tree before it can be published", (t) => {
  const f = fixture(t);
  f.start();
  const manifest = f.resolve();
  manifest.tree = "0".repeat(40);
  fs.writeFileSync(path.join(f.state, "manifest.json"), JSON.stringify(manifest));
  const destination = f.clone();
  assert.throws(() => materialize(destination, f.state), /does not match/);
  assert.equal(f.git(destination, "rev-parse", "HEAD"), f.base);
});

test("promotes a tested candidate without force, and retains upstream ancestry", (t) => {
  const f = fixture(t);
  f.start();
  f.resolve();
  const destination = f.clone();
  const candidate = materialize(destination, f.state);
  const remote = path.join(f.root, "remote.git");
  f.git(f.root, "clone", "--bare", f.repo, remote);
  f.git(destination, "remote", "set-url", "origin", remote);
  f.git(destination, "push", "origin", `${candidate}:refs/heads/candidate`);
  assert.equal(promote(destination, f.base, candidate), true);
  assert.equal(f.git(remote, "rev-parse", "refs/heads/main"), candidate);
});

test("refuses to overwrite main when it advanced during candidate testing", (t) => {
  const f = fixture(t);
  f.start();
  f.resolve();
  const destination = f.clone();
  const candidate = materialize(destination, f.state);
  const remote = path.join(f.root, "remote.git");
  f.git(f.root, "clone", "--bare", f.repo, remote);
  f.git(destination, "remote", "set-url", "origin", remote);
  f.git(destination, "push", "origin", `${candidate}:refs/heads/candidate`);
  const advanced = f.git(
    f.repo,
    "commit-tree",
    `${f.base}^{tree}`,
    "-p",
    f.base,
    "-m",
    "concurrent main change",
  );
  f.git(f.repo, "push", remote, `${advanced}:refs/heads/main`);
  assert.equal(promote(destination, f.base, candidate), false);
  assert.equal(f.git(remote, "rev-parse", "refs/heads/main"), advanced);
});
