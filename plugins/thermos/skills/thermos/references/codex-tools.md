# Codex platform mapping for thermos

The thermos skills are written for Claude Code. On Codex, read each Claude Code instruction in the left column as the Codex action in the right column. Everything else in the skills applies as written.

| Claude Code | Codex |
|---|---|
| Launch a subagent with the `Agent` tool | `spawn_agent` |
| Launch both subagents in the same message | Two `spawn_agent` calls in one response |
| `run_in_background: true` | Leave it out. Spawned agents already run at the same time. |
| Wait for both subagents to finish | `wait_agent` for both. Then `close_agent` for each, when your session has it. |
| `subagent_type: "thermos:thermo-nuclear-review-subagent"` | No such type exists on Codex. See "Reviewer agents" below. |
| `subagent_type: "thermos:thermo-nuclear-code-quality-review-subagent"` | No such type exists on Codex. See "Reviewer agents" below. |
| A `Bash` call | A shell command |
| An `Agent` call with `subagent_type: "Explore"` | Read the files yourself, in the parent agent. |

## Reviewer agents

Codex plugins cannot ship agent types. This plugin vendors each reviewer agent as a file next to this one:

- `references/agents/thermo-nuclear-review-subagent.md`
- `references/agents/thermo-nuclear-code-quality-review-subagent.md`

To launch a reviewer, call `spawn_agent` with instructions that do three things:

1. Tell the agent to read its reviewer file in full first and act as that agent. Give the absolute path: the directory that holds the `thermos` skill's `SKILL.md`, plus `references/agents/<name>.md`.
2. Pass the same scoped context to both reviewers, under the headings `### Git / diff output` and `### Changed file contents`.
3. Ask for prioritized findings with file references and evidence.

Each reviewer file tells the agent to load its rubric skill: `thermo-nuclear-review` or `thermo-nuclear-code-quality-review`. Both ship in this plugin.

## When subagents are unavailable

If `spawn_agent` is missing, or it returns a capacity or thread-limit error, do not retry. Run the two reviews yourself, one after the other: first the `thermo-nuclear-review` skill, then the `thermo-nuclear-code-quality-review` skill, both on the same scoped context. Then synthesize as the `thermos` skill says. State in your answer that the passes ran in sequence, not in parallel.
