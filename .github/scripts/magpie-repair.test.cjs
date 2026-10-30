const assert = require("node:assert/strict");
const test = require("node:test");
const { configuration, executionEnvironment, completed } = require("./magpie-repair.cjs");

test("Magpie presets use the supplied official endpoints and Flash models", () => {
  for (const [provider, url, model] of [
    ["opencode-go", "https://opencode.ai/zen/go/v1", "deepseek-v4.1-flash"],
    ["deepseek", "https://api.deepseek.com/v1", "deepseek-flash"],
    ["zhipu", "https://open.bigmodel.cn/api/coding/paas/v4", "GLM-5.3-Flash"],
  ]) {
    const config = configuration(provider, "", ["src/app.ts"]);
    assert.equal(config.model, `magpie/${model}`);
    assert.equal(config.provider.magpie.options.baseURL, url);
    assert.equal(config.provider.magpie.options.apiKey, "{env:MAGPIE_API_KEY}");
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
