// @effect-diagnostics nodeBuiltinImport:off
// Exercise real Git repositories and the standalone shell entry point synchronously.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

const script = NodeURL.fileURLToPath(new URL("./sync-upstream.sh", import.meta.url));

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sync-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (path: string, content: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, path), content);
  };
  git("init", "-b", "main");
  git("config", "user.name", "Sync test");
  git("config", "user.email", "sync-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  write(".github/workflows/keep.yml", "fork workflow\n");
  write(".github/workflows/removed.yml", "base workflow\n");
  write("app.txt", "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-b", "upstream/main");
  write(".github/workflows/removed.yml", "upstream workflow\n");
  write(".github/workflows/new.yml", "new upstream workflow\n");
  write("app.txt", "upstream\n");
  git("add", ".");
  git("commit", "-m", "upstream");
  const upstream = git("rev-parse", "HEAD");
  git("checkout", "main");
  git("rm", ".github/workflows/removed.yml");
  git("commit", "-m", "fork removes upstream workflow");
  const output = NodePath.join(NodeOS.tmpdir(), `${root.split("/").pop()}-output`);
  const summary = `${output}-summary`;
  return {
    root,
    git,
    write,
    base,
    upstream,
    output,
    summary,
    run: () =>
      NodeChildProcess.spawnSync("bash", [script, "upstream/main"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
      }),
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.rmSync(output, { force: true });
      NodeFS.rmSync(summary, { force: true });
    },
  };
}

it("merges upstream code while retaining exactly the fork workflows, including deletions", () => {
  using f = fixture();
  const before = f.git("rev-parse", "HEAD");
  const result = f.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(NodeFS.readFileSync(NodePath.join(f.root, "app.txt"), "utf8")).toBe("upstream\n");
  expect(f.git("diff", before, "HEAD", "--", ".github/workflows")).toBe("");
  expect(f.git("rev-parse", "HEAD^2")).toBe(f.upstream);
  expect(f.git("status", "--porcelain")).toBe("");
  expect(NodeFS.readFileSync(f.output, "utf8")).toContain("changed=true");
  expect(f.run().status).toBe(0);
  expect(NodeFS.readFileSync(f.output, "utf8")).toContain("changed=false");
});

it("aborts real code conflicts, preserves fork work and names the files in the summary", () => {
  using f = fixture();
  f.write("app.txt", "fork feature\n");
  f.git("add", "app.txt");
  f.git("commit", "-m", "custom feature");
  const before = f.git("rev-parse", "HEAD");
  const result = f.run();
  expect(result.status).toBe(1);
  expect(f.git("rev-parse", "HEAD")).toBe(before);
  expect(f.git("status", "--porcelain")).toBe("");
  expect(NodeFS.readFileSync(NodePath.join(f.root, "app.txt"), "utf8")).toBe("fork feature\n");
  expect(NodeFS.readFileSync(f.summary, "utf8")).toContain("app.txt");
});

it("keeps fork workflows even when upstream could otherwise fast-forward", () => {
  using f = fixture();
  f.git("checkout", "-B", "main", f.base);
  expect(f.run().status).toBe(0);
  expect(f.git("diff", f.base, "HEAD", "--", ".github/workflows")).toBe("");
  expect(f.git("rev-parse", "HEAD^2")).toBe(f.upstream);
});

it("refuses to start a merge with existing local changes", () => {
  using f = fixture();
  f.write("app.txt", "uncommitted work\n");
  const before = f.git("rev-parse", "HEAD");
  expect(f.run().status).toBe(1);
  expect(f.git("rev-parse", "HEAD")).toBe(before);
  expect(NodeFS.readFileSync(NodePath.join(f.root, "app.txt"), "utf8")).toBe("uncommitted work\n");
});
