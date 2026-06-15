# symbolic-scribe-harness

My AI agent harness

> **Repo Maintainer** — Maintainer triages the diff → benchmarker reports regressions → release drafts the GH release body → security flags risky MCP grants. Drop into any repo and run.
>
> Generated with [`create-agent-harness`](https://github.com/ruvnet/agent-harness-generator). WASM kernel, multi-host support, witness-signed releases.

## Install

```bash
npm install -g symbolic-scribe-harness
symbolic-scribe-harness init
symbolic-scribe-harness doctor
```

## Agents

| Agent | Role |
|---|---|
| `maintainer` | Triages the repo state — what changed, what is risky, what to review first. |
| `benchmarker` | Runs the perf gates and reports regressions. |
| `release` | Drafts the GitHub release body + runs the readiness gates. |
| `security` | Flags risky MCP grants, leaked secrets, dangerous diffs. |

This harness ships with the **claude-code** adapter.

## License

MIT
