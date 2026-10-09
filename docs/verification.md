# Verification

These are the live checks for v0.1.0. They need signed-in `claude` and `codex` CLIs, so CI does not run them. CI runs `sync.mjs --check`, `generate.mjs --check`, and `bun test` on Ubuntu and Windows.

## Fixture

[`tests/live/make-fixture.ps1`](../tests/live/make-fixture.ps1) builds a scratch repo:

- `main` has a parameterized SQL query.
- Branch `feature` changes the query to an f-string, which is a SQL injection.
- `feature` also adds `app/report.py`, a 1,106-line function with 220 near-identical branches.

A review passes when it reports both defects.

## Claude Code

The tested version is Claude Code 2.1.146 (2026-10-09). `--plugin-dir` loads the plugin for one session only. The run used the Sonnet model and allowed only read-only tools plus `git`.

```text
claude -p "/thermos:thermos review the feature branch against main" --plugin-dir <repo>/plugins/thermos --model sonnet --output-format stream-json --verbose --permission-mode dontAsk --allowedTools Read Grep Glob "Bash(git:*)" Agent Skill
```

[`tests/live/check-claude-run.mjs`](../tests/live/check-claude-run.mjs) reads the stream-json output and the session's subagent transcripts. All six checks passed:

| Check | Result |
|---|---|
| One message launches both `thermos:`-namespaced reviewers | PASS |
| Both reviewers launch with `run_in_background: true` | PASS |
| The review subagent loads `thermos:thermo-nuclear-review` through the Skill tool | PASS |
| The quality subagent loads `thermos:thermo-nuclear-code-quality-review` through the Skill tool | PASS |
| The verdict reports the SQL injection | PASS |
| The verdict flags `report.py` under the 1k-line rule | PASS |

`claude plugin validate` passes for both `plugins/thermos` and the repo-root marketplace.

## Codex

The tested version is codex-cli 0.162.0 (2026-10-09). The plugin was installed with `codex plugin marketplace add <repo>` and `codex plugin add thermos@thermos-claude`, then run with `codex exec --json -s read-only`.

| Run | Result |
|---|---|
| `$thermos ...` | **Wrong skill.** Codex lists plugin skills as `thermos:<skill>` and hides `thermos:thermos`, because it sets `allow_implicit_invocation: false`. The model ran the `thermo-nuclear-review` rubric alone, with no subagents. The docs now say `$thermos:thermos`. |
| `$thermos:thermos ...` | **PASS.** The parent reads `skills/thermos/SKILL.md` and `references/codex-tools.md`, makes two `spawn_agent` calls, and calls `wait_agent`. One child reads `references/agents/thermo-nuclear-review-subagent.md` and then the `thermo-nuclear-review` rubric. The other child reads the code-quality agent file and its rubric. The verdict reports the SQL injection (P1) and the 1,106-line report function (P2). |
| `$thermos:thermos ...` with `--disable multi_agent`, and again with `-c agents.enabled=false` | **Not exercised.** Neither switch stopped `spawn_agent` in this version, so the sequential fallback in `codex-tools.md` is unverified. |

On this Windows machine, Codex's shell sandbox failed to start with "setup refresh had errors". The agents read files through Codex's built-in JavaScript tool instead. This is a property of the host, not of the plugin.
