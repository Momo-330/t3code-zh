const RELEASE_INTERVAL = 4 * 60 * 60 * 1000;

function timestamp(value) {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`Invalid release timestamp: ${value}`);
  return result;
}

function publishedRelease(releases) {
  return releases
    .filter(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        release.published_at &&
        /^zh-v\d+\./.test(release.tag_name),
    )
    .toSorted((a, b) => timestamp(b.published_at) - timestamp(a.published_at))[0];
}

function releasePlan({ source, release, releasedCommit, now = Date.now(), force = false }) {
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error("Expected an immutable source SHA");
  if (!Number.isFinite(now)) throw new Error("Invalid current time");
  if (release && !/^[a-f0-9]{40}$/.test(releasedCommit))
    throw new Error("Cannot resolve the published release tag to a commit");
  const pending = !release || releasedCommit !== source;
  const dueAt = release ? timestamp(release.published_at) + RELEASE_INTERVAL : now;
  const publish = force || (pending && now >= dueAt);
  const reason = force
    ? "forced"
    : !pending
      ? "current"
      : !release
        ? "first-release"
        : publish
          ? "due"
          : "cooldown";
  return { publish, pending, dueAt, reason };
}

async function releaseState({ request, repository }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
  const releases = [];
  for (let page = 1; ; page++) {
    const data = await request(`/repos/${repository}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(data)) throw new Error("Cannot read published release metadata");
    releases.push(...data);
    if (data.length < 100) break;
  }
  const release = publishedRelease(releases);
  if (!release) return { release: undefined, releasedCommit: undefined };
  const commit = await request(
    `/repos/${repository}/commits/${encodeURIComponent(release.tag_name)}`,
  );
  if (!/^[a-f0-9]{40}$/.test(commit.sha))
    throw new Error("Cannot resolve the published release tag");
  return { release, releasedCommit: commit.sha };
}

async function main() {
  const fs = require("node:fs");
  const { execFileSync } = require("node:child_process");
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const request = async (path) => {
    const response = await fetch(`https://api.github.com${path}`, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "t3code-zh-sync",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok)
      throw new Error(`Cannot read GitHub release metadata: HTTP ${response.status}`);
    return response.json();
  };
  const state = await releaseState({ request, repository: process.env.GITHUB_REPOSITORY || "" });
  const source = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const plan = releasePlan({ ...state, source, force: process.env.FORCE_RELEASE === "true" });
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `publish=${plan.publish}\n`);
  const due = new Date(plan.dueAt).toISOString();
  console.log(JSON.stringify({ source, release: state.release?.tag_name, ...plan, dueAt: due }));
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Release cadence\n\nDecision: ${plan.reason}. Next eligible time: ${due}.\n`,
    );
}

module.exports = { RELEASE_INTERVAL, publishedRelease, releasePlan, releaseState };
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
