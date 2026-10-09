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

The run was repeated with the plugin installed from GitHub instead of `--plugin-dir`, and all six checks passed again:

```text
claude plugin marketplace add "https://github.com/JackD111/thermos-claude.git#feat/port"
claude plugin install thermos@thermos-claude
```

`claude plugin details thermos@thermos-claude` lists 3 skills and 2 agents.

### Regression lane

The same run against the earlier [kdoroszewicz port](https://github.com/kdoroszewicz/cursor-plugins-claude/tree/main/thermos) passes 4 of 6 checks. That port keeps upstream's `disable-model-invocation: true` on the rubric skills, so both subagents' Skill calls fail:

```text
Skill thermo-nuclear-review cannot be used with Skill tool due to disable-model-invocation
```

The two rubric-loading checks fail, and the reviewers fall back to their inline rubric. This run proves two things: the port must drop the flag on the rubric skills, and `check-claude-run.mjs` can tell a working port from a broken one. The `#feat/port` ref was used because the branch was not merged yet. The README omits the ref, so installs take `main`, which holds the same plugin once the branch merges.

## Codex

The tested version is codex-cli 0.162.0 (2026-10-09). The plugin was installed with `codex plugin marketplace add <repo>` and `codex plugin add thermos@thermos-claude`, then run with `codex exec --json -s read-only`.

| Run | Result |
|---|---|
| `$thermos ...` | **Wrong skill.** Codex lists plugin skills as `thermos:<skill>` and hides `thermos:thermos`, because it sets `allow_implicit_invocation: false`. The model ran the `thermo-nuclear-review` rubric alone, with no subagents. The docs now say `$thermos:thermos`. |
| `$thermos:thermos ...` | **PASS.** The parent reads `skills/thermos/SKILL.md` and `references/codex-tools.md`, makes two `spawn_agent` calls, and calls `wait_agent`. One child reads `references/agents/thermo-nuclear-review-subagent.md` and then the `thermo-nuclear-review` rubric. The other child reads the code-quality agent file and its rubric. The verdict reports the SQL injection (P1) and the 1,106-line report function (P2). |
| `$thermos:thermos ...`, installed from GitHub with `codex plugin marketplace add JackD111/thermos-claude --ref feat/port` | **PASS.** Two `spawn_agent` calls. Each child reads its own vendored agent file. The verdict reports both defects. |
| `$thermos:thermos ...` with `--disable multi_agent`, and again with `-c agents.enabled=false` | **Not exercised.** Neither switch stopped `spawn_agent` in this version, so the sequential fallback in `codex-tools.md` is unverified. |

On this Windows machine, Codex's shell sandbox failed to start with "setup refresh had errors". The agents read files through Codex's built-in JavaScript tool instead. This is a property of the host, not of the plugin.
