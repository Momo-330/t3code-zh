const assert = require("node:assert/strict");
const test = require("node:test");
const { assess, check } = require("./check-sync-health.cjs");

const now = Date.parse("2026-10-30T03:00:00Z");
const minute = 60 * 1000;
const source = "1".repeat(40);
const ago = (minutes) => new Date(now - minutes * minute).toISOString();
const run = (minutes, overrides = {}) => ({
  head_branch: "main",
  head_sha: source,
  head_repository: { full_name: "acme/app" },
  event: "push",
  status: "completed",
  conclusion: "success",
  created_at: ago(minutes),
  updated_at: ago(Math.max(0, minutes - 1)),
  run_started_at: ago(minutes),
  html_url: "https://github.com/acme/app/actions/runs/1",
  ...overrides,
});

function fixture() {
  const workflow = (minutes) => ({
    state: "active",
    html_url: "https://github.com/acme/app/actions",
    runs: [run(minutes)],
  });
  return {
    branch: "main",
    sha: source,
    repository: "acme/app",
    releaseCommit: source,
    upstream: {
      sha: "a".repeat(40),
      ahead: 0,
      html_url: "https://github.com/pingdotgg/t3code/commits/main",
    },
    sync: workflow(30),
    ci: workflow(10),
    repair: { ...workflow(120), runs: [run(120, { event: "workflow_run" })] },
    release: workflow(120),
    releasesUrl: "https://github.com/acme/app/releases",
    releases: [
      {
        tag_name: "zh-v0.1.5-zh.1",
        draft: false,
        published_at: ago(40),
        html_url: "https://github.com/acme/app/releases/tag/zh-v0.1.5-zh.1",
        assets: [
          { name: "T3-Code.exe", state: "uploaded", size: 100 },
          { name: "latest.yml", state: "uploaded", size: 200 },
        ],
      },
    ],
  };
}

test("accepts healthy sync, CI and uploaded Windows update assets", () => {
  const report = assess(fixture(), now);
  assert.equal(report.ok, true);
  assert.deepEqual(report.issues, []);
});

test("detects overdue upstream commits despite recent successful CI and health activity", () => {
  const state = fixture();
  state.sync.runs = [run(180)];
  state.upstream = {
    sha: "a".repeat(40),
    ahead: 8,
    oldestPendingAt: ago(10),
    html_url: "https://github.com/upstream/app/commits/main",
  };
  const report = assess(state, now);
  assert.equal(report.upToDate, false);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((item) => /上游.*8.*2 小时/.test(item.message)));
});

test("detects a due unpublished main before the old twelve-hour release alarm", () => {
  const state = fixture();
  state.releaseCommit = "2".repeat(40);
  state.releases[0].published_at = ago(300);
  const report = assess(state, now);
  assert.equal(report.ok, false);
  assert.equal(report.releaseDue, true);
  assert.ok(report.issues.some((item) => /发布.*到期/.test(item.message)));
});

test("uses the latest sync execution when an old workflow is rerun", () => {
  const state = fixture();
  state.sync.runs = [run(600, { run_started_at: ago(2), updated_at: ago(1) })];
  assert.equal(assess(state, now).ok, true);
  state.sync.runs[0].conclusion = "failure";
  state.sync.runs.push(run(30));
  assert.equal(assess(state, now).ok, false);
});

test("requires CI for the current main SHA and accepts its pinned validation branch", () => {
  const state = fixture();
  state.ci.runs[0].head_sha = "2".repeat(40);
  assert.equal(assess(state, now).ok, false);
  state.ci.runs.push(
    run(5, {
      event: "workflow_dispatch",
      head_branch: `automation/source-ci/${source}`,
    }),
  );
  assert.equal(assess(state, now).ok, true);
  state.ci.runs[1].head_repository.full_name = "other/app";
  assert.equal(assess(state, now).ok, false);
});

test("ignores failures and abandoned queues superseded by a newer successful run", () => {
  const state = fixture();
  state.sync.runs.push(run(60, { conclusion: "failure" }));
  state.ci.runs.unshift(run(1440, { status: "queued", conclusion: null }));
  assert.equal(assess(state, now).ok, true);
});

test("reports a new sync conflict even though an older sync succeeded", () => {
  const state = fixture();
  state.sync.runs.push(run(5, { conclusion: "failure" }));
  const report = assess(state, now);
  assert.equal(report.ok, false);
  assert.match(report.issues[0].message, /同步.*failure/);
});

test("tracks automatic repairs and only clears old failures after a successful sync", () => {
  const state = fixture();
  state.repair.runs = [run(2, { event: "workflow_run", conclusion: "failure" })];
  assert.match(assess(state, now).issues[0].message, /修复.*failure/);
  state.repair.runs.push(run(1, { event: "push" }));
  assert.equal(assess(state, now).ok, false);
  state.repair.runs.push(run(1, { event: "workflow_run", conclusion: "skipped" }));
  assert.match(assess(state, now).issues[0].message, /修复.*failure/);
  state.repair.runs = [run(120, { event: "workflow_run", conclusion: "failure" })];
  state.repair.runs.push(run(1, { event: "workflow_run", conclusion: "skipped" }));
  assert.equal(assess(state, now).ok, true);
  state.repair.runs = [run(1, { event: "workflow_run", conclusion: "skipped" })];
  assert.equal(assess(state, now).ok, true);
  state.repair.runs = [run(91, { event: "workflow_run", status: "in_progress", conclusion: null })];
  assert.match(assess(state, now).issues[0].message, /修复.*超过 90 分钟/);
});

test("allows a fresh retry after failure while its result is still pending", () => {
  const state = fixture();
  state.ci.runs = [
    run(15, { conclusion: "failure" }),
    run(2, { status: "in_progress", conclusion: null }),
  ];
  assert.equal(assess(state, now).ok, true);
});

test("distinguishes legitimate Windows build time from an overlong running workflow", () => {
  const state = fixture();
  state.sync.runs = [run(120, { status: "in_progress", conclusion: null })];
  assert.equal(assess(state, now).ok, true);
  state.sync.runs = [run(181, { status: "in_progress", conclusion: null })];
  const report = assess(state, now);
  assert.equal(report.ok, false);
  assert.match(report.issues[0].message, /180 分钟/);
});

test("flags long queues using creation time rather than a later status update", () => {
  const state = fixture();
  state.ci.runs = [run(91, { status: "queued", conclusion: null, updated_at: ago(1) })];
  assert.match(assess(state, now).issues[0].message, /等待执行.*90 分钟/);
  state.ci.runs = [run(89, { status: "queued", conclusion: null })];
  assert.equal(assess(state, now).ok, true);
  state.sync.runs = [
    run(600, { run_attempt: 2, status: "queued", conclusion: null, run_started_at: ago(2) }),
  ];
  assert.equal(assess(state, now).ok, true);
});

test("detects disabled schedules and a six-hour absence of sync attempts", () => {
  const state = fixture();
  state.sync.state = "disabled_inactivity";
  state.sync.runs = [run(361)];
  const report = assess(state, now);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((item) => item.message.includes("disabled_inactivity")));
  assert.ok(report.issues.some((item) => item.message.includes("6 小时")));
});

test("does not mistake a pull request or another branch for a recovered main sync", () => {
  const state = fixture();
  state.sync.runs = [
    run(30, { conclusion: "failure" }),
    run(2, { event: "pull_request" }),
    run(1, { head_branch: "feature" }),
  ];
  assert.equal(assess(state, now).ok, false);
});

test("reports a missing sync history and a twelve-hour absence of successful sync", () => {
  const state = fixture();
  state.sync.runs = [];
  assert.match(assess(state, now).issues[0].message, /没有.*运行记录/);
  state.sync.runs = [run(2, { status: "in_progress", conclusion: null }), run(800)];
  assert.ok(assess(state, now).issues.some((item) => item.message.includes("12 小时没有成功")));
});

test("an old failed manual release is resolved by a newer published release", () => {
  const state = fixture();
  state.release.runs = [run(90, { conclusion: "failure" })];
  assert.equal(assess(state, now).ok, true);
  state.release.runs = [run(2, { conclusion: "failure" })];
  assert.equal(assess(state, now).ok, false);
});

test("checks Windows releases triggered by Chinese version tags", () => {
  const state = fixture();
  state.release.runs = [
    run(2, { head_branch: "zh-v0.1.5-zh.2", event: "push", conclusion: "failure" }),
  ];
  assert.equal(assess(state, now).ok, false);
  state.release.runs = [
    run(2, { head_branch: "feature", event: "workflow_dispatch", conclusion: "failure" }),
  ];
  assert.equal(assess(state, now).ok, true);
});

test("does not require a separate manual release run when the sync pipeline published successfully", () => {
  const state = fixture();
  state.release.runs = [];
  assert.equal(assess(state, now).ok, true);
});

test("requires a published Chinese release rather than a draft or upstream release", () => {
  const state = fixture();
  state.releases[0].draft = true;
  state.releases.push({ ...state.releases[0], draft: false, tag_name: "v0.1.5" });
  assert.equal(assess(state, now).ok, false);
});

test("rejects incomplete Windows releases and incomplete uploads", () => {
  const state = fixture();
  state.releases[0].assets[1].size = 0;
  let report = assess(state, now);
  assert.equal(report.ok, false);
  assert.match(report.issues[0].message, /latest.yml/);
  state.releases[0].assets[1].size = 200;
  state.releases[0].assets[0].state = "new";
  report = assess(state, now);
  assert.match(report.issues[0].message, /Windows 安装包/);
});

test("does not mark quiet repositories broken just because their release is old", () => {
  const state = fixture();
  state.releases[0].published_at = ago(1440);
  assert.equal(assess(state, now).issues.length, 0);
  assert.equal(assess(state, now).releasePending, false);
});

test("fails when GitHub timestamps cannot be evaluated", () => {
  const state = fixture();
  state.sync.runs[0].created_at = "unknown";
  state.sync.runs[0].status = "queued";
  assert.throws(() => assess(state, now), /无效的时间/);
});

function apiFixture(snapshot = fixture()) {
  const messages = [];
  const summary = [];
  const labels = {
    "sync-zh.yml": "sync",
    "ci.yml": "ci",
    "release-zh-windows.yml": "release",
    "repair-upstream.yml": "repair",
  };
  return {
    messages,
    summary,
    options: {
      now,
      context: {
        repo: { owner: "acme", repo: "app" },
        payload: { repository: { default_branch: "main" } },
      },
      github: {
        rest: {
          actions: {
            getWorkflow: async ({ workflow_id }) => ({ data: snapshot[labels[workflow_id]] }),
            listWorkflowRuns: async ({ workflow_id, branch, head_sha }) => {
              assert.equal(
                branch,
                ["release-zh-windows.yml", "ci.yml"].includes(workflow_id) ? undefined : "main",
              );
              assert.equal(head_sha, workflow_id === "ci.yml" ? snapshot.sha : undefined);
              return { data: { workflow_runs: snapshot[labels[workflow_id]].runs } };
            },
          },
          repos: {
            listReleases: () => {},
            getCommit: async ({ owner, ref }) => ({
              data: {
                sha:
                  owner === "pingdotgg"
                    ? snapshot.upstream.sha
                    : ref === "main"
                      ? snapshot.sha
                      : snapshot.releaseCommit,
              },
            }),
            compareCommitsWithBasehead: async ({ basehead, per_page }) => {
              assert.equal(basehead, `${snapshot.sha}...${snapshot.upstream.sha}`);
              assert.equal(per_page, 1);
              return {
                data: {
                  status: "diverged",
                  ahead_by: snapshot.upstream.ahead,
                  html_url: snapshot.upstream.html_url,
                  commits: snapshot.upstream.ahead
                    ? [{ commit: { committer: { date: snapshot.upstream.oldestPendingAt } } }]
                    : [],
                },
              };
            },
          },
        },
        paginate: async () => snapshot.releases,
      },
      core: {
        summary: {
          addHeading: (text) => summary.push(text),
          addRaw: (text) => summary.push(text),
          write: async () => {},
        },
        error: (text) => messages.push(["error", text]),
        warning: (text) => messages.push(["warning", text]),
        setOutput: (key, value) => messages.push([key, value]),
        setFailed: (text) => messages.push(["failed", text]),
      },
    },
  };
}

test("reads workflow metadata and publishes a dated summary without requiring AI or write APIs", async () => {
  const { options, messages, summary } = apiFixture();
  const report = await check(options);
  assert.equal(report.ok, true);
  assert.ok(messages.some(([key, value]) => key === "healthy" && value === "true"));
  assert.ok(summary.join("").includes("北京时间"));
  assert.ok(!messages.some(([key]) => key === "failed"));
});

test("marks the inspection failed when the latest CI is broken", async () => {
  const state = fixture();
  state.ci.runs = [run(2, { conclusion: "failure" })];
  const { options, messages } = apiFixture(state);
  await check(options);
  assert.ok(messages.some(([key]) => key === "failed"));
});

test("reports current CI in progress without labelling the source healthy", async () => {
  const state = fixture();
  state.ci.runs = [run(2, { status: "in_progress", conclusion: null })];
  const { options, messages, summary } = apiFixture(state);
  const report = await check(options);
  assert.equal(report.ok, true);
  assert.equal(report.validated, false);
  assert.ok(messages.some(([key, value]) => key === "healthy" && value === "false"));
  assert.match(summary.join(""), /待 CI/);
});

test("fresh sync plus just-merged old commits is pending, not overdue", async () => {
  const state = fixture();
  state.upstream.ahead = 2;
  state.upstream.oldestPendingAt = ago(1440);
  const { options, messages, summary } = apiFixture(state);
  const report = await check(options);
  assert.equal(report.ok, true);
  assert.equal(report.upToDate, false);
  assert.ok(messages.some(([key, value]) => key === "healthy" && value === "false"));
  assert.match(summary.join(""), /待同步上游/);
});

test("distinguishes pending publication cooldown and active recovery from overdue idle work", async () => {
  const state = fixture();
  state.releaseCommit = "2".repeat(40);
  const { options, messages, summary } = apiFixture(state);
  let report = await check(options);
  assert.equal(report.ok, true);
  assert.equal(report.releaseDue, false);
  assert.ok(messages.some(([key, value]) => key === "healthy" && value === "false"));
  assert.match(summary.join(""), /待发布/);
  state.releases[0].published_at = ago(300);
  state.upstream.ahead = 8;
  state.upstream.oldestPendingAt = ago(180);
  state.sync.runs = [run(5, { status: "in_progress", conclusion: null })];
  report = assess(state, now);
  assert.equal(report.ok, true);
  assert.equal(report.releaseDue, true);
  state.sync.runs[0].status = "completed";
  state.sync.runs[0].conclusion = "success";
  report = assess(state, now);
  assert.equal(report.ok, false);
  assert.equal(report.issues.length, 1);
  state.sync.runs = [run(180)];
  report = assess(state, now);
  assert.equal(report.issues.length, 2);
});

test("missing upstream comparison or release tag resolution fails closed", async () => {
  const { options, messages } = apiFixture();
  options.github.rest.repos.compareCommitsWithBasehead = async () => ({ data: {} });
  await assert.rejects(check(options), /上游/);
  assert.ok(!messages.some(([key]) => key === "healthy"));
  const fixture2 = apiFixture();
  const getCommit = fixture2.options.github.rest.repos.getCommit;
  fixture2.options.github.rest.repos.getCommit = async (args) =>
    args.ref.startsWith("zh-v") ? { data: {} } : getCommit(args);
  await assert.rejects(check(fixture2.options), /上游|resolve/);
  assert.ok(!fixture2.messages.some(([key]) => key === "healthy"));
});

test("API failures cannot be reported as a healthy environment", async () => {
  const { options, messages } = apiFixture();
  options.github.rest.actions.getWorkflow = async () => {
    throw new Error("API unavailable");
  };
  await assert.rejects(check(options), /API unavailable/);
  assert.ok(!messages.some(([key]) => key === "healthy"));
});
