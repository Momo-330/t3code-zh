const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  configuration,
  executionEnvironment,
  completed,
  mergeContext,
} = require("./magpie-repair.cjs");

test("large files with small conflicts fit the context budget and retain deletion stages", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-context-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  const write = (name, text) => fs.writeFileSync(path.join(repo, name), text);
  const surrounding = Array.from({ length: 10000 }, (_, i) => `unchanged line ${i}\n`).join("");
  git("init", "-b", "main");
  git("config", "user.name", "Context test");
  git("config", "user.email", "context@example.invalid");
  git("config", "commit.gpgsign", "false");
  write("large.ts", `${surrounding}base\n`);
  write("deleted.ts", "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  git("checkout", "-b", "upstream");
  write("large.ts", `${surrounding}upstream behavior\n`);
  git("rm", "deleted.ts");
  git("add", ".");
  git("commit", "-m", "upstream");
  git("checkout", "main");
  write("large.ts", `${surrounding}fork localization\n`);
  write("deleted.ts", "fork feature\n");
  git("add", ".");
  git("commit", "-m", "fork");
  assert.equal(spawnSync("git", ["merge", "upstream"], { cwd: repo }).status, 1);
  const context = mergeContext(["large.ts", "deleted.ts"], repo);
  assert.ok(Buffer.byteLength(context) < 4096);
  assert.match(context, /upstream behavior/);
  assert.match(context, /fork localization/);
  const deleted = JSON.parse(context).find((entry) => entry.path === "deleted.ts");
  assert.match(deleted.unmerged, / 2\tdeleted.ts/);
  assert.doesNotMatch(deleted.unmerged, / 3\tdeleted.ts/);
  write("large.ts", "conflict\n".repeat(20000));
  assert.throws(() => mergeContext(["large.ts"], repo), /context budget/);
});

test("Magpie presets use the supplied official endpoints and Flash models", () => {
  for (const [provider, url, model] of [
    ["opencode-go", "https://opencode.ai/zen/go/v1", "deepseek-v4.1-flash"],
    ["deepseek", "https://api.deepseek.com/v1", "deepseek-flash"],
    ["zhipu", "https://open.bigmodel.cn/api/coding/paas/v4", "GLM-5.3-Flash"],
  ]) {
    const config = configuration(provider, "", ["src/app.ts"]);
    const identity = provider === "opencode-go" ? "opencode-go" : "magpie";
    assert.equal(config.model, `${identity}/${model}`);
    assert.deepEqual(config.enabled_providers, [identity]);
    assert.equal(config.provider[identity].options.baseURL, url);
    assert.equal(config.provider[identity].options.apiKey, "{env:MAGPIE_API_KEY}");
  }
  assert.equal(configuration("zhipu", "GLM-5.3", ["app.ts"]).model, "magpie/GLM-5.3");
  assert.throws(() => configuration("qwen-embedding", "", ["app.ts"]));
  assert.throws(() => configuration("__proto__", "", ["app.ts"]));
  assert.throws(() => configuration("deepseek", "{file:/secret}", ["app.ts"]));
});

test("editing permissions cannot expand from conflict paths to unrelated files", () => {
  const config = configuration("deepseek", "", ["src/[id].ts"]);
  assert.deepEqual(config.permission.edit, { "*": "deny", "src/[id].ts": "allow" });
  assert.equal(config.permission["*"], "deny");
  assert.equal(config.formatter, false);
  assert.equal(config.lsp, false);
  assert.equal(config.share, "disabled");
  for (const files of [[], ["*"], ["../outside"], ["/tmp/outside"], ["a?"], ["{file:x}"]]) {
    assert.throws(() => configuration("deepseek", "", files));
  }
});

test("model process receives its key without GitHub credentials or output-file access", () => {
  const config = configuration("opencode-go", "", ["app.ts"]);
  const env = executionEnvironment(config, "/tmp/isolated", {
    MAGPIE_API_KEY: "test-only-key",
    GH_TOKEN: "test-only-github",
    GITHUB_OUTPUT: "/tmp/job-output",
    ACTIONS_RUNTIME_TOKEN: "test-only-actions",
    PATH: "/bin",
  });
  assert.equal(env.MAGPIE_API_KEY, "test-only-key");
  assert.equal(env.PATH, "/bin");
  for (const name of ["GH_TOKEN", "GITHUB_OUTPUT", "ACTIONS_RUNTIME_TOKEN"])
    assert.equal(env[name], undefined);
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
  assert.equal(env.OPENCODE_DISABLE_DEFAULT_PLUGINS, "true");
  assert.equal(env.XDG_CONFIG_HOME, "/tmp/isolated/config");
  assert.ok(!env.OPENCODE_CONFIG_CONTENT.includes("test-only-key"));
  assert.throws(() => executionEnvironment(config, "/tmp/isolated", {}));
});

test("a zero-exit stream containing an API failure or an incomplete turn is rejected", () => {
  const done = JSON.stringify({ type: "step_finish", part: { reason: "stop" } });
  completed(`Startup banner\n${done}\n`);
  assert.throws(
    () => completed(`${done}\n{"type":"error","error":{"secret":"sensitive"}}`),
    (error) => !error.message.includes("sensitive") && error.message.includes("API error"),
  );
  assert.throws(() => completed('{"type":"step_finish","part":{"reason":"tool-calls"}}'));
  assert.throws(() => completed(""));
});
