const assert = require("node:assert/strict");
const test = require("node:test");
const { sourceBranch, sourceRuns, validate } = require("./validate-source.cjs");

const source = "a".repeat(40);
const other = "b".repeat(40);
const repository = "acme/app";
const run = (overrides = {}) => ({
  id: 12,
  head_sha: source,
  head_branch: sourceBranch(source),
  event: "workflow_dispatch",
  head_repository: { full_name: repository },
  created_at: "2026-11-01T00:00:00Z",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/acme/app/actions/runs/12",
  ...overrides,
});

function fixture({
  initial = [],
  discovered = [run()],
  progress = [],
  check = "success",
  ref = source,
} = {}) {
  const outputs = {};
  const calls = [];
  let lists = 0;
  const actions = {
    listWorkflowRuns: async (input) => {
      assert.equal(input.head_sha, source);
      assert.equal(input.branch, undefined);
      return { data: { workflow_runs: lists++ === 0 ? initial : discovered } };
    },
    createWorkflowDispatch: async (input) => calls.push(["dispatch", input.ref]),
    getWorkflowRun: async () => ({ data: progress.shift() }),
    listJobsForWorkflowRun: () => {},
  };
  const options = {
    source,
    context: {
      repo: { owner: "acme", repo: "app" },
      payload: { repository: { default_branch: "main" } },
    },
    github: {
      rest: {
        actions,
        git: {
          getRef: async () => ({ data: { object: { sha: ref } } }),
          createRef: async (input) => {
            calls.push(["branch", input.sha]);
            return { data: { object: { sha: source } } };
          },
          deleteRef: async (input) => calls.push(["delete", input.ref]),
        },
      },
      paginate: async () => [{ name: "Check", status: "completed", conclusion: check }],
    },
    core: {
      info: () => {},
      warning: (message) => calls.push(["warning", message]),
      setOutput: (key, value) => {
        outputs[key] = value;
      },
      summary: { addRaw: () => {}, write: async () => {} },
    },
    wait: async () => {},
    discoveryPolls: 2,
    completionPolls: 2,
  };
  return { options, outputs, calls };
}

test("selects only exact-source trusted CI and never substitutes an older success for a failure", () => {
  const runs = sourceRuns(
    [
      run({ head_sha: other }),
      run({ event: "pull_request" }),
      run({ head_branch: "feature" }),
      run({ head_repository: { full_name: "elsewhere/app" } }),
      run({ id: 1, created_at: "2026-10-31T00:00:00Z" }),
      run({ conclusion: "failure" }),
    ],
    { source, branch: "main", repository },
  );
  assert.deepEqual(
    runs.map((item) => item.id),
    [12, 1],
  );
  assert.equal(runs[0].conclusion, "failure");
  assert.throws(() => sourceBranch("main"), /immutable/);
});

test("reuses exact-source main CI without dispatching or deleting main", async () => {
  const f = fixture({ initial: [run({ head_branch: "main", event: "push" })] });
  await validate(f.options);
  assert.equal(f.outputs.source, source);
  assert.equal(f.outputs.validated, "true");
  assert.deepEqual(f.calls, []);
});

test("dispatches and waits for the pinned source when only stale CI exists", async () => {
  const f = fixture({
    initial: [run({ head_sha: other })],
    discovered: [run({ status: "queued", conclusion: null })],
    progress: [run({ status: "in_progress", conclusion: null }), run()],
  });
  f.options.github.rest.git.getRef = async () => {
    if (f.calls.some(([kind]) => kind === "branch")) return { data: { object: { sha: source } } };
    throw Object.assign(new Error("not found"), { status: 404 });
  };
  await validate(f.options);
  assert.deepEqual(f.calls, [
    ["branch", source],
    ["dispatch", sourceBranch(source)],
    ["delete", `heads/${sourceBranch(source)}`],
  ]);
  assert.equal(f.outputs["ci-run"], "12");
});

test("failure, missing Check gate and changed CI identity cannot authorize a release", async () => {
  for (const settings of [
    { initial: [run({ conclusion: "failure" })] },
    { initial: [run({ conclusion: "cancelled" })] },
    { initial: [run({ conclusion: "skipped" })] },
    { initial: [run()], check: "failure" },
    {
      initial: [run({ status: "in_progress", conclusion: null })],
      progress: [run({ head_sha: other })],
    },
    { discovered: [] },
    { ref: other },
  ]) {
    const f = fixture(settings);
    await assert.rejects(validate(f.options));
    assert.equal(f.outputs.validated, undefined);
    assert.ok(!f.calls.some(([kind]) => kind === "delete"));
  }
});

test("an already running exact-source CI is awaited and has a bounded wait", async () => {
  const f = fixture({
    initial: [run({ head_branch: "main", event: "push", status: "queued", conclusion: null })],
    progress: [run({ head_branch: "main", event: "push" })],
  });
  await validate(f.options);
  assert.ok(!f.calls.some(([kind]) => kind === "dispatch"));
  const stuck = fixture({
    initial: [run({ status: "queued", conclusion: null })],
    progress: [
      run({ status: "queued", conclusion: null }),
      run({ status: "in_progress", conclusion: null }),
    ],
  });
  await assert.rejects(validate(stuck.options), /wait limit/);
  assert.equal(stuck.outputs.validated, undefined);
});

test("cleanup errors retain the temporary branch without invalidating successful CI", async () => {
  const f = fixture({ initial: [run()] });
  f.options.github.rest.git.deleteRef = async () => {
    throw Object.assign(new Error("unavailable"), { status: 503 });
  };
  await validate(f.options);
  assert.equal(f.outputs.validated, "true");
  assert.ok(f.calls.some(([kind]) => kind === "warning"));
});
