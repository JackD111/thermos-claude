# Reference

## Skills

| Skill | Claude Code | Codex | Model can start it on its own |
|---|---|---|---|
| `thermos` | `/thermos:thermos` | `$thermos:thermos` | No (`disable-model-invocation: true`; Codex `allow_implicit_invocation: false`) |
| `thermo-nuclear-review` | `/thermos:thermo-nuclear-review` | `$thermos:thermo-nuclear-review` | Yes |
| `thermo-nuclear-code-quality-review` | `/thermos:thermo-nuclear-code-quality-review` | `$thermos:thermo-nuclear-code-quality-review` | Yes |

## Agents

| Agent | Claude Code `subagent_type` | Codex |
|---|---|---|
| `thermo-nuclear-review-subagent` | `thermos:thermo-nuclear-review-subagent` | `spawn_agent`, told to read `skills/thermos/references/agents/thermo-nuclear-review-subagent.md` |
| `thermo-nuclear-code-quality-review-subagent` | `thermos:thermo-nuclear-code-quality-review-subagent` | `spawn_agent`, told to read `skills/thermos/references/agents/thermo-nuclear-code-quality-review-subagent.md` |

## Tested versions

| Runtime | Version | Date |
|---|---|---|
| Claude Code | 2.1.146 | 2026-10-09 |
| Codex CLI | 0.162.0 | 2026-10-09 |

Codex lists plugin skills as `<plugin>:<skill>`. With `allow_implicit_invocation: false`, the skill is missing from that list, so only the full `$thermos:thermos` marker reaches it. A bare `$thermos` ran the wrong skill in testing.

Codex's plugin format is still changing. Recheck the Codex install after a major Codex CLI update.

## Upstream

| Field | Value |
|---|---|
| Repository | [cursor/plugins](https://github.com/cursor/plugins) |
| Path | `thermos/` |
| Upstream version | 1.0.0 |
| Pinned commit | [`dc41543`](https://github.com/cursor/plugins/commit/dc415439eebed0cd8fddb11e896dee43bce9d8b0) |
| Not carried | `.cursor-plugin/`, `CHANGELOG.md`, `LICENSE`, `README.md`, `assets/` |
