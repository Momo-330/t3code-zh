# Automatic upstream conflict repair

The normal hourly sync keeps the fork's workflows and merges clean upstream changes. When it fails with a source conflict, `Repair upstream conflicts` can start a coding agent, publish a candidate branch, run the existing full CI workflow against that exact commit, and promote it to `main` only after CI succeeds. The normal sync/release workflow is then dispatched again.

This runs on GitHub-hosted machines. It does not wake an existing chat or reuse a ChatGPT session's login. Installation of the workflow does not supply model authorization.

## Enable

In this repository's **Settings → Secrets and variables → Actions**:

1. Add the repository secret `MAGPIE_API_KEY`. For the default OpenCode Go preset, use the contents of the local `opencode-go-api-key.txt` file. A local Windows file path is not a credential available to GitHub. Enter the actual value in GitHub Settings, never in a chat, commit, or log.
2. With this secret present, unattended repair is enabled unless `CODEX_AUTO_REPAIR` is explicitly `false`. Pushes changing the workflow still run free deployment checks only. The next failed normal sync, or a manual **Actions → Repair upstream conflicts → Run workflow**, can attempt a real conflict.
3. The default engine is pinned OpenCode 1.3.15. `MAGPIE_REPAIR_PROVIDER` selects one preset below; `MAGPIE_REPAIR_MODEL` can override its model. Use the corresponding provider's key in `MAGPIE_API_KEY` when switching. There is no automatic paid fallback between vendors.

| Provider variable       | Official base URL                             | Default model         |
| ----------------------- | --------------------------------------------- | --------------------- |
| `opencode-go` (default) | `https://opencode.ai/zen/go/v1`               | `deepseek-v4.1-flash` |
| `deepseek`              | `https://api.deepseek.com/v1`                 | `deepseek-flash`      |
| `zhipu`                 | `https://open.bigmodel.cn/api/coding/paas/v4` | `GLM-5.3-Flash`       |

These presets use Chat Completions with tool calling. Zhipu uses the Coding Plan endpoint, not its general API. The supplied Qwen entry is embedding-only and cannot repair code. Provider quota and unattended-use eligibility depend on that provider's plan. The model IDs come from the supplied Magpie configuration; real authentication and model availability remain unverified until a keyed run succeeds. With no actual conflict, no model call is made.

The optional Codex engine remains available by setting `SYNC_REPAIR_ENGINE=codex`, adding the secret `OPENAI_API_KEY` and setting `CODEX_AUTO_REPAIR=true`. Its optional variables are `CODEX_SYNC_MODEL` and `CODEX_SYNC_RESPONSES_ENDPOINT` (a full HTTPS Responses endpoint). Codex requires Responses compatibility; the default OpenCode presets do not. OpenAI API usage is billed separately from a ChatGPT subscription.

Use the provider's project usage limits to control spending. A model step has a 15-minute limit. The same base/upstream pair is automatically attempted once while its attempt-cache entry remains available. To retry that pair deliberately, select the workflow's `retry` input. GitHub caches can expire or be evicted, so this is not a billing cap.

## Behavior and recovery

The repair job has read-only GitHub permissions. In OpenCode mode the model process receives no GitHub credentials, loads no repository configuration or plugins, and has no shell, network, task delegation or external-directory tools. Its edit permission allows only the original conflict paths; trusted code supplies merge-stage text. Formatters and language servers are disabled to avoid executing project hooks. It receives only a prepared merge and a conflict file list. Trusted code stored outside that workspace checks that the agent changed only the conflicting paths and left automation and policy untouched. Unresolved markers or unrelated edits are rejected before a candidate is published.

CI receives the immutable candidate SHA. Candidate publication and promotion happen in separate jobs with no model credentials. The merge commit retains both the original fork parent and the upstream parent, so future syncs recognize the imported history. A concurrent update to `main` is never overwritten; the normal sync is retriggered against the new state instead. No force pushes or pull requests are used.

Automation/policy conflicts, binary or non-regular-file conflicts, files larger than 2 MiB, OpenCode merge-stage context exceeding 128 KiB, paths containing permission wildcards, and repairs involving more than 30 paths require manual work. Failed candidates remain under `automation/upstream-repair/<run-id>-<attempt>` for investigation; successfully promoted temporary branches are deleted. If a model cannot resolve a conflict, or CI fails, `main` and published releases stay unchanged.

To stop model calls, set `CODEX_AUTO_REPAIR=false` or remove the model secret. The ordinary sync, release and hourly health inspection continue independently. The health inspector can detect a blocked sync, but cannot itself repair code without the selected provider credential.
