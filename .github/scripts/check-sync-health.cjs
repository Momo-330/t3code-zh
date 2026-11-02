const HOUR = 60 * 60 * 1000;
const QUEUE_LIMIT = 90 * 60 * 1000;
const SYNC_GAP_LIMIT = 6 * HOUR;
const SUCCESS_GAP_LIMIT = 12 * HOUR;
const PENDING_SYNC_GAP_LIMIT = 2 * HOUR;
const { sourceRuns } = require("./validate-source.cjs");
const { publishedRelease, releasePlan } = require("./release-policy.cjs");

const workflows = [
  { key: "sync", file: "sync-zh.yml", label: "上游同步与自动发版", runningLimit: 180 * 60 * 1000 },
  { key: "ci", file: "ci.yml", label: "CI", runningLimit: 90 * 60 * 1000 },
  {
    key: "repair",
    file: "repair-upstream.yml",
    label: "自动冲突修复",
    runningLimit: 90 * 60 * 1000,
  },
  {
    key: "release",
    file: "release-zh-windows.yml",
    label: "手动 Windows 发版",
    runningLimit: 150 * 60 * 1000,
  },
];

function timestamp(value) {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`GitHub 返回了无效的时间：${value}`);
  return result;
}

function executionTime(run) {
  return timestamp(run.run_started_at || run.created_at);
}

function assess(snapshot, now) {
  const issues = [];
  const rows = [];
  let validated = false;
  let lastSuccessfulSync;
  const active = new Set();
  const release = publishedRelease(snapshot.releases);
  const issue = (level, message, url) => issues.push({ level, message, url });

  for (const policy of workflows) {
    const workflow = snapshot[policy.key];
    if (workflow.state !== "active") {
      issue("error", `${policy.label}工作流未启用：${workflow.state}`, workflow.html_url);
    }
    const runs =
      policy.key === "ci"
        ? sourceRuns(workflow.runs, {
            source: snapshot.sha,
            branch: snapshot.branch,
            repository: snapshot.repository,
          })
        : workflow.runs
            .filter(
              (run) =>
                (run.head_branch === snapshot.branch ||
                  (policy.key === "release" &&
                    run.event === "push" &&
                    /^zh-v\d+\./.test(run.head_branch))) &&
                (policy.key !== "repair" || run.conclusion !== "skipped") &&
                (policy.key === "repair"
                  ? ["workflow_run", "workflow_dispatch"]
                  : ["push", "schedule", "workflow_dispatch"]
                ).includes(run.event),
            )
            .toSorted((a, b) => executionTime(b) - executionTime(a));
    const latest = runs[0];
    if (!latest) {
      rows.push({ label: policy.label, value: "没有运行记录", url: workflow.html_url });
      if (policy.key === "sync")
        issue("error", "同步工作流没有主分支运行记录。", workflow.html_url);
      if (policy.key === "ci")
        issue(
          "error",
          `当前主分支 ${snapshot.sha} 没有匹配提交的 CI 验证记录。`,
          workflow.html_url,
        );
      continue;
    }
    rows.push({
      label: policy.label,
      value: latest.status === "completed" ? latest.conclusion : latest.status,
      url: latest.html_url,
    });
    if (policy.key === "ci")
      validated = latest.status === "completed" && latest.conclusion === "success";
    if (latest.status !== "completed") active.add(policy.key);

    // A later published release supersedes an old failed manual release.
    if (
      policy.key === "release" &&
      release &&
      timestamp(release.published_at) > timestamp(latest.updated_at)
    )
      continue;

    if (latest.status === "completed") {
      const recovered =
        policy.key === "repair" &&
        snapshot.sync.runs.some(
          (run) =>
            run.head_branch === snapshot.branch &&
            ["push", "schedule", "workflow_dispatch"].includes(run.event) &&
            run.status === "completed" &&
            run.conclusion === "success" &&
            timestamp(run.updated_at) > timestamp(latest.updated_at),
        );
      if (latest.conclusion !== "success" && !recovered)
        issue("error", `${policy.label}最近一次运行未成功：${latest.conclusion}`, latest.html_url);
    } else if (latest.status === "in_progress") {
      if (now - timestamp(latest.run_started_at || latest.created_at) > policy.runningLimit) {
        issue(
          "error",
          `${policy.label}运行已超过 ${policy.runningLimit / 60000} 分钟，需要检查是否卡住。`,
          latest.html_url,
        );
      }
    } else if (
      now - (latest.run_attempt > 1 ? executionTime(latest) : timestamp(latest.created_at)) >
      QUEUE_LIMIT
    ) {
      issue("error", `${policy.label}等待执行已超过 90 分钟：${latest.status}`, latest.html_url);
    }

    if (policy.key === "sync") {
      if (now - executionTime(latest) > SYNC_GAP_LIMIT) {
        issue(
          "error",
          "超过 6 小时没有新的同步任务，请检查定时触发或工作流是否被停用。",
          workflow.html_url,
        );
      }
      const success = runs.find(
        (run) => run.status === "completed" && run.conclusion === "success",
      );
      lastSuccessfulSync = success;
      if (success && now - timestamp(success.updated_at) > SUCCESS_GAP_LIMIT) {
        issue("error", "超过 12 小时没有成功完成同步，近期重试仍未恢复。", latest.html_url);
      }
    }
  }

  const upstream = snapshot.upstream;
  if (
    !upstream ||
    !/^[a-f0-9]{40}$/.test(upstream.sha) ||
    !Number.isInteger(upstream.ahead) ||
    upstream.ahead < 0
  )
    throw new Error("无法核对上游提交状态。");
  const upToDate = upstream.ahead === 0;
  rows.push({
    label: "上游同步覆盖",
    value: upToDate
      ? `已纳入 ${upstream.sha}`
      : `还有 ${upstream.ahead} 个提交未合入（${upstream.sha}）`,
    url: upstream.html_url,
  });
  if (!upToDate && !active.has("sync") && !active.has("repair")) {
    // Commit dates do not tell us when a commit entered upstream main.
    if (!lastSuccessfulSync || now - executionTime(lastSuccessfulSync) > PENDING_SYNC_GAP_LIMIT)
      issue(
        "error",
        `上游还有 ${upstream.ahead} 个提交未合入，${lastSuccessfulSync ? "上次成功同步启动距今已超过 2 小时" : "尚无成功同步记录"}。`,
        upstream.html_url,
      );
  }
  let releasePending = true;
  let releaseDue = true;
  if (!release) {
    issue("error", "尚未找到已发布的中文版版本。", snapshot.releasesUrl);
  } else {
    rows.push({ label: "最新中文版", value: release.tag_name, url: release.html_url });
    const uploaded = (name) =>
      release.assets.some(
        (asset) => name(asset.name) && asset.state === "uploaded" && asset.size > 0,
      );
    if (!uploaded((name) => /\.exe$/i.test(name)))
      issue("error", "最新中文版缺少已上传的 Windows 安装包。", release.html_url);
    if (!uploaded((name) => name === "latest.yml"))
      issue("error", "最新中文版缺少自动更新清单 latest.yml。", release.html_url);
    const plan = releasePlan({
      source: snapshot.sha,
      release,
      releasedCommit: snapshot.releaseCommit,
      now,
    });
    releasePending = plan.pending;
    releaseDue = plan.publish;
    rows.push({ label: "发布提交", value: snapshot.releaseCommit, url: release.html_url });
    rows.push({
      label: "发布进度",
      value: !plan.pending
        ? "当前主分支已发布"
        : plan.publish
          ? "待发布，已到期"
          : `待发布，最早 ${new Date(plan.dueAt).toISOString()}`,
      url: release.html_url,
    });
    if (releaseDue && !active.has("sync") && !active.has("repair") && !active.has("release"))
      issue(
        "error",
        "主分支存在尚未发布的提交，距上次成功发布已满 4 小时，发布已到期。",
        release.html_url,
      );
  }
  return {
    ok: !issues.some((item) => item.level === "error"),
    validated,
    upToDate,
    releasePending,
    releaseDue,
    issues,
    rows,
  };
}

async function check({ github, context, core, now = Date.now() }) {
  const branch = context.payload.repository?.default_branch;
  if (!branch) throw new Error("GitHub 未提供默认分支，无法核对同步状态。");
  const { data: head } = await github.rest.repos.getCommit({ ...context.repo, ref: branch });
  const snapshot = {
    branch,
    sha: head.sha,
    repository: `${context.repo.owner}/${context.repo.repo}`,
    releasesUrl: `https://github.com/${context.repo.owner}/${context.repo.repo}/releases`,
  };
  await Promise.all(
    workflows.map(async (policy) => {
      const [workflow, runs] = await Promise.all([
        github.rest.actions.getWorkflow({ ...context.repo, workflow_id: policy.file }),
        github.rest.actions.listWorkflowRuns({
          ...context.repo,
          workflow_id: policy.file,
          ...(policy.key === "ci"
            ? { head_sha: snapshot.sha }
            : policy.key === "release"
              ? {}
              : { branch }),
          per_page: 100,
        }),
      ]);
      snapshot[policy.key] = { ...workflow.data, runs: runs.data.workflow_runs };
    }),
  );
  snapshot.releases = await github.paginate(github.rest.repos.listReleases, {
    ...context.repo,
    per_page: 100,
  });
  const latest = publishedRelease(snapshot.releases);
  if (latest) {
    const { data } = await github.rest.repos.getCommit({ ...context.repo, ref: latest.tag_name });
    snapshot.releaseCommit = data.sha;
  }
  const { data: upstream } = await github.rest.repos.getCommit({
    owner: "pingdotgg",
    repo: "t3code",
    ref: "main",
  });
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${snapshot.sha}...${upstream.sha}`,
    per_page: 1,
  });
  snapshot.upstream = {
    sha: upstream.sha,
    ahead: comparison.ahead_by,
    html_url: comparison.html_url,
  };
  const report = assess(snapshot, now);
  const escape = (value) => String(value).replace(/[|<>\r\n]/g, " ");
  const link = (url, label) => `[${escape(label)}](${url})`;
  const observedAt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(now));
  core.summary.addHeading(
    report.ok
      ? !report.upToDate
        ? "同步巡检：待同步上游"
        : !report.validated
          ? "同步巡检：待 CI 验证"
          : report.releasePending
            ? "同步巡检：待发布"
            : "同步巡检：正常"
      : "同步巡检：需要处理",
  );
  core.summary.addRaw(`检查时间（北京时间）：${observedAt}\n\n`);
  core.summary.addRaw(`当前主分支提交：\`${snapshot.sha}\`\n\n`);
  core.summary.addRaw("| 项目 | 状态 |\n| --- | --- |\n");
  for (const row of report.rows)
    core.summary.addRaw(`| ${link(row.url, row.label)} | ${escape(row.value)} |\n`);
  core.summary.addRaw("\n");
  for (const item of report.issues) {
    core[item.level](item.message);
    core.summary.addRaw(
      `- ${escape(item.message)}${item.url ? ` ${link(item.url, "查看记录")}` : ""}\n`,
    );
  }
  core.summary.addRaw(
    "\n此任务只检查状态，不修改代码、重跑发布或调用 AI。GitHub 定时执行可能延迟。\n",
  );
  await core.summary.write();
  core.setOutput(
    "healthy",
    String(report.ok && report.validated && report.upToDate && !report.releasePending),
  );
  core.setOutput("validated", String(report.validated));
  core.setOutput("up_to_date", String(report.upToDate));
  core.setOutput("release_due", String(report.releaseDue));
  if (!report.ok) core.setFailed("发现同步、CI 或发布异常，详情见本次运行摘要。");
  return report;
}

module.exports = { assess, check };
