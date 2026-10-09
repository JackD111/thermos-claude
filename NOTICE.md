# Notice

thermos-claude is a port of MIT-licensed work by Cursor. Upstream copyright notices and license terms are kept in [LICENSE](LICENSE).

## Upstream source

| Component | Upstream path | Pinned commit | Copyright | License |
|---|---|---|---|---|
| thermos 1.0.0 | [`thermos/`](https://github.com/cursor/plugins/tree/dc415439eebed0cd8fddb11e896dee43bce9d8b0/thermos) | [`dc41543`](https://github.com/cursor/plugins/commit/dc415439eebed0cd8fddb11e896dee43bce9d8b0) | Copyright (c) 2026 Cursor | MIT |

## What the port changes

`tools/sync.mjs` derives every upstream-owned file from the pinned commit through the rules in `tools/substitutions.json`, and [docs/parity.diff](docs/parity.diff) shows every changed line. In short:

- Cursor tool and subagent names become Claude Code names (`Agent`, `Bash`, `Explore`, `thermos:`-namespaced agents).
- The two rubric skills drop `disable-model-invocation: true`.
- `skills/thermos/SKILL.md` gains one line that points Codex to its platform mapping.

## Port-authored files

The manifests, marketplaces, `skills/thermos/references/codex-tools.md`, `skills/thermos/agents/openai.yaml`, everything under `tools/`, `tests/`, and `docs/`, and the README are written for this port.
