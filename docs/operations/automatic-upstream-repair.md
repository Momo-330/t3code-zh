# Automatic upstream conflict repair

The normal hourly sync keeps the fork's workflows and merges clean upstream changes. When it fails with a source conflict, `Repair upstream conflicts` can start Codex, publish a candidate branch, run the existing full CI workflow against that exact commit, and promote it to `main` only after CI succeeds. The normal sync/release workflow is then dispatched again.

This runs on GitHub-hosted machines. It does not wake an existing chat or reuse a ChatGPT session's login. Installation of the workflow does not supply model authorization.

## Enable

In this repository's **Settings → Secrets and variables → Actions**:

1. Add the secret `OPENAI_API_KEY` for the model provider. Enter its value there, never in a chat, commit, or log. OpenAI API usage is billed separately from a ChatGPT subscription.
2. Set the repository variable `CODEX_AUTO_REPAIR` to `true` to authorize unattended model calls. Without this opt-in, the workflow only reports that repair is disabled and makes no model calls.
3. Optionally set `CODEX_SYNC_MODEL` to a supported model ID. When omitted, the official Codex CLI chooses its default. A compatible Responses API provider can use `CODEX_SYNC_RESPONSES_ENDPOINT` for its full HTTPS Responses endpoint, with its credential in `OPENAI_API_KEY`.
4. Run **Actions → Repair upstream conflicts → Run workflow**. With no actual source conflict it does not invoke Codex. Real model behavior and authentication remain unverified until an enabled run encounters a conflict and completes successfully.

Use the provider's project usage limits to control spending. A model step has a 15-minute limit. The same base/upstream pair is automatically attempted once while its attempt-cache entry remains available. To retry that pair deliberately, select the workflow's `retry` input. GitHub caches can expire or be evicted, so this is not a billing cap.

## Behavior and recovery

The agent has read-only GitHub permissions and a workspace permission profile. It receives only a prepared merge and a conflict file list. Trusted code stored outside that workspace checks that the agent changed only the conflicting paths and left automation and policy untouched. Unresolved markers or unrelated edits are rejected before a candidate is published.

CI receives the immutable candidate SHA. Candidate publication and promotion happen in separate jobs with no model credentials. The merge commit retains both the original fork parent and the upstream parent, so future syncs recognize the imported history. A concurrent update to `main` is never overwritten; the normal sync is retriggered against the new state instead. No force pushes or pull requests are used.

Automation/policy conflicts, binary or non-regular-file conflicts, files larger than 2 MiB, and repairs involving more than 30 paths require manual work. Failed candidates remain under `automation/upstream-repair/<run-id>-<attempt>` for investigation; successfully promoted temporary branches are deleted. If a model cannot resolve a conflict, or CI fails, `main` and published releases stay unchanged.

To stop model calls, unset `CODEX_AUTO_REPAIR` or set it to `false`. The ordinary sync, release and hourly health inspection continue independently. The health inspector can detect a blocked sync, but cannot itself repair code without this separate model authorization.
