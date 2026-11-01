const SOURCE_BRANCH_PREFIX = "automation/source-ci/";

function sourceBranch(source) {
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error("Expected an immutable source commit SHA");
  return `${SOURCE_BRANCH_PREFIX}${source}`;
}

function sourceRuns(runs, { source, branch, repository }) {
  const pinnedBranch = sourceBranch(source);
  return runs
    .filter(
      (run) =>
        run.head_sha === source &&
        run.head_repository?.full_name === repository &&
        ((run.event === "push" && run.head_branch === branch) ||
          (run.event === "workflow_dispatch" && [branch, pinnedBranch].includes(run.head_branch))),
    )
    .toSorted((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

async function validate({
  github,
  context,
  core,
  source,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  discoveryPolls = 18,
  completionPolls = 180,
}) {
  const validationBranch = sourceBranch(source);
  const branch = context.payload.repository?.default_branch;
  if (!branch) throw new Error("Cannot determine the default branch");
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const scope = { source, branch, repository };
  const list = async () => {
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...context.repo,
      workflow_id: "ci.yml",
      head_sha: source,
      per_page: 100,
    });
    return sourceRuns(data.workflow_runs, scope)[0];
  };
  let run = await list();
  if (!run) {
    let ref;
    try {
      ({ data: ref } = await github.rest.git.getRef({
        ...context.repo,
        ref: `heads/${validationBranch}`,
      }));
    } catch (error) {
      if (error.status !== 404) throw error;
      try {
        ({ data: ref } = await github.rest.git.createRef({
          ...context.repo,
          ref: `refs/heads/${validationBranch}`,
          sha: source,
        }));
      } catch (creationError) {
        if (creationError.status !== 422) throw creationError;
        ({ data: ref } = await github.rest.git.getRef({
          ...context.repo,
          ref: `heads/${validationBranch}`,
        }));
      }
    }
    if (ref.object.sha !== source)
      throw new Error("Validation branch does not match the pinned source");
    await github.rest.actions.createWorkflowDispatch({
      ...context.repo,
      workflow_id: "ci.yml",
      ref: validationBranch,
    });
    for (let i = 0; i < discoveryPolls && !run; i++) {
      await wait(5000);
      run = await list();
    }
    if (!run) throw new Error(`CI dispatch for ${source} did not produce a matching run`);
  }
  core.info(`Validating ${source} with CI run ${run.id}: ${run.html_url}`);
  for (let i = 0; run.status !== "completed" && i < completionPolls; i++) {
    await wait(15000);
    const { data } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: run.id });
    if (data.id !== run.id || !sourceRuns([data], scope).length)
      throw new Error("CI run identity changed while waiting");
    run = data;
  }
  if (run.status !== "completed")
    throw new Error(`CI for ${source} exceeded the validation wait limit`);
  if (run.conclusion !== "success")
    throw new Error(`CI for ${source} finished with ${run.conclusion}: ${run.html_url}`);
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo,
    run_id: run.id,
    per_page: 100,
  });
  if (
    !jobs.some(
      (job) => job.name === "Check" && job.status === "completed" && job.conclusion === "success",
    )
  ) {
    throw new Error("The exact-source CI run has no successful Check gate");
  }
  core.setOutput("source", source);
  core.setOutput("ci-run", String(run.id));
  core.setOutput("validated", "true");
  core.summary.addRaw(`Validated source \`${source}\` with [CI run ${run.id}](${run.html_url}).\n`);
  await core.summary.write();
  if (run.head_branch === validationBranch) {
    try {
      const { data: ref } = await github.rest.git.getRef({
        ...context.repo,
        ref: `heads/${validationBranch}`,
      });
      if (ref.object.sha === source)
        await github.rest.git.deleteRef({ ...context.repo, ref: `heads/${validationBranch}` });
      else core.warning("CI passed; the validation branch moved and was left untouched");
    } catch (error) {
      if (error.status !== 404)
        core.warning("CI passed; temporary branch cleanup failed and the branch was retained");
    }
  }
  return run;
}

module.exports = { sourceBranch, sourceRuns, validate };
