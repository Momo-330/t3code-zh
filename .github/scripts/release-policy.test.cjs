const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { publishedRelease, releasePlan, releaseState } = require("./release-policy.cjs");

const source = "1".repeat(40);
const releasedCommit = "2".repeat(40);
const release = { tag_name: "zh-v0.1.6-zh.4", published_at: "2026-11-01T23:12:45Z" };
const plan = (time, overrides = {}) =>
  releasePlan({ source, releasedCommit, release, now: Date.parse(time), ...overrides });

test("catches up a delayed release after its four-hour due time, outside the old hour window", () => {
  assert.equal(plan("2026-11-02T03:48:00Z").publish, true);
  assert.equal(plan("2026-11-02T03:12:44Z").publish, false);
  const due = plan("2026-11-02T03:12:45Z");
  assert.equal(due.publish, true);
  assert.equal(due.reason, "due");
});

test("re-evaluates the release gate when source validation crosses the cooldown boundary", () => {
  const beforeValidation = plan("2026-11-02T03:12:44Z");
  assert.equal(beforeValidation.publish, false);
  assert.equal(beforeValidation.reason, "cooldown");

  const afterValidation = plan("2026-11-02T03:16:00Z");
  assert.equal(afterValidation.publish, true);
  assert.equal(afterValidation.reason, "due");
});

test("does not publish more often than four hours or rebuild an unchanged source", () => {
  assert.equal(
    plan("2026-11-02T06:17:00Z", {
      release: { ...release, published_at: "2026-11-02T03:48:00Z" },
    }).publish,
    false,
  );
  const current = plan("2026-11-03T03:48:00Z", { releasedCommit: source });
  assert.equal(current.publish, false);
  assert.equal(current.pending, false);
  assert.equal(current.reason, "current");
  assert.equal(plan("2026-11-02T00:00:00Z", { releasedCommit: source, force: true }).publish, true);
  assert.equal(plan("2026-11-02T00:00:00Z", { release: undefined }).publish, true);
});

test("uses actual published stable releases, not drafts, prereleases or newer unshipped tags", async () => {
  const releases = [
    { ...release, tag_name: "zh-v0.1.6-zh.5", draft: true, published_at: "2026-11-02T03:40:00Z" },
    { ...release, tag_name: "zh-v0.1.6-zh.6", prerelease: true },
    { ...release, tag_name: "v0.1.7" },
    release,
  ];
  assert.equal(publishedRelease(releases), release);
  const state = await releaseState({
    repository: "acme/app",
    request: async (path) => (path.includes("/releases?") ? releases : { sha: releasedCommit }),
  });
  assert.equal(state.release.tag_name, release.tag_name);
  assert.equal(
    releasePlan({ ...state, source, now: Date.parse("2026-11-02T03:48:00Z") }).publish,
    true,
  );
});

test("release metadata and tag resolution failures cannot authorize publishing", async () => {
  await assert.rejects(
    releaseState({
      repository: "acme/app",
      request: async () => {
        throw new Error("API unavailable");
      },
    }),
    /API unavailable/,
  );
  await assert.rejects(
    releaseState({
      repository: "acme/app",
      request: async (path) => (path.includes("/releases?") ? [release] : {}),
    }),
    /resolve/,
  );
  assert.throws(
    () => plan("2026-11-02T03:48:00Z", { release: { ...release, published_at: "invalid" } }),
    /timestamp/,
  );
  assert.throws(() => plan("2026-11-02T03:48:00Z", { releasedCommit: undefined }), /resolve/);
});

test("finds a published release beyond the first page of draft metadata", async () => {
  const state = await releaseState({
    repository: "acme/app",
    request: async (path) =>
      path.endsWith("&page=1")
        ? Array.from({ length: 100 }, () => ({ ...release, draft: true }))
        : path.includes("/releases?")
          ? [release]
          : { sha: source },
  });
  assert.equal(state.releasedCommit, source);
  assert.equal(
    releasePlan({ ...state, source, now: Date.parse("2026-11-02T03:48:00Z") }).pending,
    false,
  );
});

test("the workflow computes release eligibility only after exact-source validation", () => {
  const workflow = readFileSync(join(__dirname, "../workflows/sync-zh.yml"), "utf8");
  const job = (name) => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    assert.notEqual(start, -1, `Missing ${name} job`);
    const bodyStart = start + name.length + 4;
    const body = workflow.slice(bodyStart);
    const nextJob = body.search(/^ {2}\S/m);
    return nextJob === -1 ? body : body.slice(0, nextJob);
  };
  const syncJob = job("sync");
  const planJob = job("release-plan");
  const releaseJob = job("release");

  assert.doesNotMatch(syncJob, /zh-release-needed\.sh|Resolve the next version/);
  assert.match(planJob, /^    needs: \[sync, validate\]$/m);
  assert.match(planJob, /^    if: needs\.validate\.outputs\.validated == 'true'$/m);
  assert.match(planJob, /run: bash scripts\/zh-release-needed\.sh/);
  assert.match(releaseJob, /^    needs: \[sync, validate, release-plan\]$/m);
  assert.match(releaseJob, /needs\.release-plan\.outputs\.publish == 'true'/);
  assert.match(releaseJob, /version: \$\{\{ needs\.release-plan\.outputs\.version \}\}/);
});
