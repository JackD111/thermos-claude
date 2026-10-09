# thermos-claude design

thermos-claude ports Cursor's [thermos](https://github.com/cursor/plugins/tree/main/thermos) plugin to Claude Code and Codex. It ports the content 1:1: every upstream skill and agent comes from a pinned upstream commit through a short list of mechanical rewrite rules. CI fails when the committed tree differs from that derivation in a way the port did not declare. The structure copies [pstack-claude](https://github.com/michael-denyer/pstack-claude), cut down to the parts a plugin with three skills and two agents needs.

Phases: P0 scaffold, P1 verbatim import, P2 rewrite rules, P3 Claude Code packaging, P4 Codex packaging, P5 CI and docs.

Status: proposal, 2026-10-09. Grounded on cursor/plugins `ccb5507`, pstack-claude `60ae9e2` (0.9.79), and Codex docs fetched 2026-10-09.

## Problem

Upstream thermos is five content files:

| Upstream file | Role | Cursor-specific content |
|---|---|---|
| `skills/thermos/SKILL.md` | Orchestrator. Launches both subagents in one message with `run_in_background: true`, then synthesizes the results. | Bare `subagent_type: "thermo-nuclear-review-subagent"` |
| `skills/thermo-nuclear-review/SKILL.md` | Bug, security, and breakage rubric | `disable-model-invocation: true` only |
| `skills/thermo-nuclear-code-quality-review/SKILL.md` | Maintainability rubric | `disable-model-invocation: true` only |
| `agents/thermo-nuclear-review-subagent.md` | Wrapper: "Load the `thermo-nuclear-review` skill and follow it" | "Task subagent", `Task` calls, `subagent_type: "shell"` and `"explore"` |
| `agents/thermo-nuclear-code-quality-review-subagent.md` | The same wrapper for the quality rubric | The same |

Grounding turned up four constraints.

1. **Plugin agents are namespaced in Claude Code.** A plugin agent registers as `thermos:<file-name>`. A bare `subagent_type` fails with "Agent type 'x' not found" (pstack-claude #58, enforced by its `validatePluginLayout`).
2. **The rubric skills cannot load in Claude Code as shipped.** The agents load a rubric through the Skill tool. Claude Code refuses that call for a skill with `disable-model-invocation: true`, and it cannot preload such a skill through `skills:` frontmatter either (code.claude.com/docs/en/sub-agents). The [kdoroszewicz port](https://github.com/kdoroszewicz/cursor-plugins-claude/tree/main/thermos) copied the files verbatim, so its subagents quietly fall back to the weak inline rubric.
3. **Codex has subagents, but a plugin cannot ship them.** `features.multi_agent` is on by default and exposes `spawn_agent`, `wait_agent`, and `close_agent`. Codex reads custom agents only as TOML in `~/.codex/agents/` or `<repo>/.codex/agents/`. A Codex plugin manifest has no agent component (openai/codex [#18988](https://github.com/openai/codex/issues/18988) and [#36855](https://github.com/openai/codex/issues/36855), both open). So the belief that "Codex has no agents" is half right: the runtime has them, but the plugin cannot install them.
4. **Codex reads `SKILL.md` natively.** One shared skills tree can serve both runtimes. Custom prompts are deprecated in favor of skills.

## Usage (caller's view)

### Install and run on Claude Code

```text
/plugin marketplace add JackD111/thermos-claude
/plugin install thermos@thermos-claude
/thermos:thermos review this branch against main
/thermos:thermo-nuclear-review
/thermos:thermo-nuclear-code-quality-review
```

`/thermos:thermos` collects the diff and starts two background subagents in one message: `thermos:thermo-nuclear-review-subagent` and `thermos:thermo-nuclear-code-quality-review-subagent`. When both finish, it writes one deduplicated verdict.

### Install and run on Codex

```text
codex plugin marketplace add JackD111/thermos-claude
codex plugin add thermos@thermos-claude
$thermos:thermos review this branch against main
```

Codex lists plugin skills as `thermos:<skill>`, so the explicit marker is `$thermos:thermos`. The `thermos` skill tells Codex to read `references/codex-tools.md`. Codex then makes two `spawn_agent` calls in one response. Each child is told to read the vendored agent file first. Each vendored file loads its rubric skill. Codex then calls `wait_agent` for both and synthesizes the results.

### Maintain the port

```text
bun tools/sync.mjs thermos <new-sha> --dry-run   # show what an upstream bump would change
bun tools/sync.mjs thermos <new-sha>             # apply it and advance the pin
bun tools/generate.mjs                           # restamp versions, vendored agents, Codex preamble
bun tools/generate.mjs --check                   # CI: fail on any stale generated file
bun test                                         # invariants, parity, packaging
```

## Shape

### Repo layout

```text
.claude-plugin/marketplace.json          Claude marketplace: one entry, source ./plugins/thermos
.agents/plugins/marketplace.json         Codex marketplace: local source, products [CODEX]
plugins/thermos/
  .claude-plugin/plugin.json             name, version, description, author, license, repository, keywords
  .codex-plugin/plugin.json              same fields, plus "skills": "./skills/" and an interface block, no agents
  agents/                                synced from upstream and rewritten
    thermo-nuclear-review-subagent.md
    thermo-nuclear-code-quality-review-subagent.md
  skills/
    thermos/SKILL.md                     synced, rewritten, Codex preamble stamped
    thermos/agents/openai.yaml           port-owned: allow_implicit_invocation false
    thermos/references/codex-tools.md    port-owned: Claude to Codex mapping
    thermos/references/agents/*.md       generated copies of ../../../agents/*.md for Codex
    thermo-nuclear-review/SKILL.md       synced, rewritten
    thermo-nuclear-code-quality-review/SKILL.md
tools/
  upstream.json                          remote, path "thermos", pinned sha, exclude list
  substitutions.json                     ordered rewrite rules, each with a rationale; denylist with hints
  forks.json                             declared intentional divergences (starts empty)
  sync.mjs                               derive, classify, write, advance the pin
  generate.mjs                           stamp and check the generated files
tests/                                   bun:test
.github/workflows/ci.yml  .github/dependabot.yml
.gitattributes                           * text=auto eol=lf
VERSION  CHANGES.md  README.md  CONTEXT.md  CONTRIBUTING.md  NOTICE.md  LICENSE
docs/reference.md  docs/design.md  docs/parity.diff
package.json  bun.lock  bunfig.toml
```

### Data model

The port has three kinds of file. Every path has exactly one owner.

| Owner | Files | Who writes them | What checks them |
|---|---|---|---|
| Upstream | the 5 content files | `sync.mjs` only, from `derive(upstream@pin)` | the `sync --dry-run` CI job. A hand edit fails unless `forks.json` declares it. |
| Generator | manifest `version` fields, `references/agents/*.md`, the Codex preamble line | `generate.mjs` only | `generate.mjs --check` in CI |
| Port | everything else (manifests, marketplaces, `codex-tools.md`, `openai.yaml`, tools, tests, docs) | people | tests |

`derive(file)` is a pure function: apply the substitutions in order, then the frontmatter rules, then the generator stamps. Every check calls the same function. Tests do not keep their own copy.

### Rewrite rules (`substitutions.json`)

Each rule carries a `rationale`. Rules run in order, and the loader rejects a rule whose pattern contains an earlier rule's pattern. That is the pstack-claude contract.

| # | Upstream text | Port text | Files |
|---|---|---|---|
| 1 | `` You are a **Task subagent**. `` | `` You are an **`Agent` subagent**. `` | agents |
| 2 | `Invoked via Task after a parent` | ``Invoked via the `Agent` tool after a parent`` | agents |
| 3 | `subagent_type: "thermo-nuclear-review-subagent"` | `subagent_type: "thermos:thermo-nuclear-review-subagent"` | all |
| 4 | `subagent_type: "thermo-nuclear-code-quality-review-subagent"` | `subagent_type: "thermos:thermo-nuclear-code-quality-review-subagent"` | all |
| 5 | ``run two `Task` calls in parallel — `subagent_type: "shell"` and `subagent_type: "explore"` —`` | ``run a `Bash` call and an `Agent` call with `subagent_type: "Explore"` in parallel`` | agents |

The port also has frontmatter rules, implemented as a port of pstack-claude's `portFrontmatter()`:

- Remove `disable-model-invocation: true` from the two rubric skills. Constraint 2 makes this a requirement. It is also the only change pstack-claude makes to the same rubric text.
- Keep `disable-model-invocation: true` on `thermos`. Nothing calls the orchestrator through the Skill tool, and a user typing `/thermos:thermos` still works. Keeping the flag preserves upstream's "user-triggered only" behavior.
- Set `name` to the file or directory name. Remove the Cursor-only keys `mode`, `icon`, `color`, `reminder`, and `is_background`. Thermos has none of these keys today. The rule guards future upstream versions.

The denylist fails a sync if any of these survive: `` `Task` ``, `Task subagent`, `generalPurpose`, `subagent_type: "shell"`, `subagent_type: "explore"`, a `subagent_type` naming a thermos agent without `thermos:`, `.cursor/`, `/add-plugin`, and `is_background`.

The port deliberately leaves alone:

- "BugBot" and `gh`/`glab`. Bugbot comments on GitHub PRs whatever editor the author uses, so the sentence is still true.
- The stale "take-the-wheel and FSD" wording in upstream's manifest description. Port-owned manifests replace that description.
- Upstream `README.md`, `CHANGELOG.md`, `.cursor-plugin/`, and `assets/`. They are on the exclude list. The port writes its own README and CHANGES.

### Codex adaptation

The skill text stays in Claude Code vocabulary. Codex resolves it through one mapping file, which is pstack-claude's `codex-tools.md` pattern. `skills/thermos/references/codex-tools.md` covers only what thermos uses:

| Claude Code | Codex |
|---|---|
| `Agent` call | `spawn_agent` |
| Two `Agent` calls in one message | Two `spawn_agent` calls in one response |
| `run_in_background: true` | Not needed. Spawned agents already run concurrently. |
| Wait for both | `wait_agent` on both, then `close_agent` if the host exposes it |
| `subagent_type: "thermos:<name>"` | No such type. Call `spawn_agent` with instructions to read `<skill dir>/references/agents/<name>.md` in full first (give the absolute path), and pass the same `### Git / diff output` and `### Changed file contents` sections. |
| `subagent_type: "Explore"`, `Bash` | Run `git diff` and read the files in the parent. |
| `spawn_agent` unavailable, or a capacity error | Run the two passes one after the other in this session, then synthesize. Say that you ran them in sequence. |

`generate.mjs` stamps one line under the first heading of `thermos/SKILL.md`:

> On Codex, read the [platform mapping](references/codex-tools.md) before following this skill.

`skills/thermos/agents/openai.yaml` sets `policy.allow_implicit_invocation: false`. That is the Codex equivalent of keeping `disable-model-invocation` on the orchestrator.

### Invariants enforced in code

| Invariant | Mechanism |
|---|---|
| The committed upstream-owned files equal `derive(upstream@pin)`, apart from declared forks | `sync.mjs <pin> --dry-run` in CI |
| Every intentional divergence has a `kind`, a `why`, and a `since` | `forks.json` schema; an undeclared fork fails the sync |
| No Cursor-ism survives | denylist in `substitutions.json` |
| Each vendored agent copy equals `agents/<name>.md` | `generate.mjs --check` |
| One version everywhere | `VERSION` is stamped into 2 manifests and the Claude marketplace entry. CHANGES.md must have a `## <VERSION>` heading. |
| The manifests agree on name, license, repository, and keywords | packaging test |
| A skill's name equals its directory and its description is at most 1024 chars. An agent's name equals its file name. | frontmatter test |
| No bare thermos `subagent_type`, no `commands/` directory, no merge markers | layout test |
| Byte parity survives a Windows checkout | `.gitattributes` with `eol=lf`. Without it, `core.autocrlf` breaks every byte comparison. |

Each invariant test includes a fixture that must fail. That is pstack-claude's `invariants.test.mjs` rule: a check that quietly matches nothing looks the same as a pass.

### Parity report

`sync.mjs --report` writes `docs/parity.diff`, the full `git diff` from `upstream@pin` to the port's upstream-owned files. The file is committed, and the sync test fails if it is stale. A reviewer can read all of the port's divergence in a single file.

### Deliberately not done

These cuts follow the subtract-before-you-add principle:

- **pstack-claude's three-way merge** (`git merge-file`, conflict markers). With 5 files, `sync` refuses to overwrite a forked file and prints the upstream hunk for a person to merge.
- **`models.json`, effort agents, model stamping.** Thermos names no models.
- **Hooks.** Thermos has no session mandate.
- **Codex prompt stubs.** Custom prompts are deprecated, and native skill invocation (`$thermos:thermos`) covers the need.
- **Codex custom-agent TOML.** A plugin cannot install it (constraint 3). It is a later option, not v1.
- **Pi, Copilot, Lean, TLA+, worktree scripts.**
- **The `Report Format` section that pstack-claude adds** to `thermo-nuclear-code-quality-review`. It refers to pstack's swarm skill and is not upstream thermos.

## Red-flag screen

- **Shallow module.** Pass. `derive()` hides substitution, frontmatter, and stamping behind one function.
- **Information leakage.** Pass. The Codex mapping lives in one file. Skills only point to it.
- **Temporal decomposition.** Pass. Ownership splits the code: sync owns upstream files, generate owns stamps.
- **Pass-through.** Pass.
- **Split ownership.** Fixed. Each path has one writer (see the data model).
- **Two ways to do one task.** Fixed. Codex has no prompt stubs because skills are the single entry point.
- **Importable internals.** Not applicable.
- **Hand-synced list.** Fixed. Versions and vendored agents are generated, not copied by hand.

## Alternatives considered

1. **Hand port with no tooling** (the kdoroszewicz approach). It exposes nothing and hides nothing. It lost because its result, as seen in that port, leaves the text untranslated and the rubrics unloadable, and nothing catches drift from upstream.
2. **Fork all of pstack-claude's tooling.** It brings three-way merge, models, effort agents, prompt stubs, and four runtimes. It lost because more than 90% of that surface goes unused, and each unused piece is code to maintain.
3. **Rewrite the skills in tool-neutral wording**, one text per runtime. It lost because it forks every upstream file, so "1:1" stops being checkable. pstack-claude rejected this approach for the same reason (`CONTEXT.md`).
4. **Codex agents as user-installed TOML.** Ship `codex-agents/*.toml` and a copy step. It lost for v1 because it needs a manual step outside the plugin and duplicates the agent bodies. It can be added later, generated from `agents/*.md`, if Codex starts honoring agents shipped in a plugin.

## Synthesis decision

The base is the pstack-claude mechanism: one shared skills tree in Claude vocabulary, a per-runtime manifest, a per-runtime mapping doc, a pinned upstream with rule-based derivation, and generator `--check` in CI. From the kdoroszewicz port this design takes only the minimal manifest fields. It rejects that port's verbatim copy. It drops the three-way merge in favor of refuse-and-print. The parity report is new here, and pstack-claude has no equivalent.

## Tradeoffs accepted

- We accept a manual merge when upstream edits a forked file, in exchange for dropping merge machinery. Upstream thermos has not changed since 1.0.0.
- We accept that Codex users get generic children told to read an agent file, not named agent types, in exchange for a plugin that installs in one command.
- We accept that the two rubric skills can be invoked by the model, in exchange for subagents that load the real rubric.
- We accept Bun as a dev dependency, matching pstack-claude, in exchange for reusing its tested sync and generate code.

## Premises attacked

Proof levels: 1 = stated, 2 = cited `file:line` or docs, 3 = walked through, 4 = run against the real tool, 5 = reproduced end to end.

| Premise | Observation that could break it | Level now | Proved in |
|---|---|---|---|
| A bare `subagent_type` fails for plugin agents | Install the plugin and dispatch both names | 2 (pstack #58). The namespaced names work at level 5. | P3 |
| A subagent cannot load a skill with `disable-model-invocation: true` | Run the review agent with the flag on, then with it off | 2 (docs) | P3 |
| With the flag off, the agent body's "Load the skill" instruction is enough, and `skills:` preload is not needed | The subagent transcript shows a Skill call or quotes rubric-only text ("code judo") | 5 (both subagents called Skill successfully) | done |
| Keeping the flag on `thermos` still lets the user invoke `/thermos:thermos` | Type it in a session | 2 | P3 |
| Codex plugins cannot ship agents | Read the manifest schema at P4 time | 2 (issues #18988, #36855) | P4 |
| A Codex child can read the vendored file by absolute path | `codex exec` run | 5 (both children read their file, then their rubric) | done |
| `codex plugin add` is the install command | `codex plugin --help` on the installed CLI | 4 (codex-cli 0.162.0 lists `add` and `marketplace`) | done |
| Upstream thermos files have not changed since 1.0.0 | `git log --follow -- thermos` on a full clone | 4 (3 commits, all on 2026-05-27) | done |
| Installing thermos and pstack together causes no collision | Claude namespaces both. On Codex, install both and list the skills. | 2 / 1 | P4 |

## Phases

Each phase is one PR with its own evidence. Tests alone are not enough. A phase is done only when its unit and live checks both pass.

### P0. Scaffold the repo

- **Depends on.** None.
- **Build.**
  - Run `git init`.
  - Add `LICENSE`: MIT, "Copyright (c) 2026 Cursor" plus the port author.
  - Add `NOTICE.md` with the upstream source table (path, pinned permalink, license).
  - Add `VERSION` set to `0.1.0`, `CHANGES.md`, `package.json`, `bunfig.toml`, `.gitattributes`, and a stub `ci.yml`.
- **Verify, unit.** `bun test` runs, with 0 tests.
- **Verify, live.** `n/a: nothing to install yet`.

### P1. Import upstream verbatim

- **Depends on.** P0.
- **Build.**
  - Write `tools/upstream.json`: pin `ccb5507cec1546dc88135c1139c811e6c59115ba`, path `thermos`, exclude `.cursor-plugin/`, `README.md`, `CHANGELOG.md`, `assets/`, `LICENSE`.
  - Port `sync.mjs` from pstack-claude: clone, derive, classify, denylist, refuse to overwrite a fork, and `--report`.
  - Leave `substitutions.json` and `forks.json` empty.
- **You see.** `sync thermos <pin>` writes 5 files. `--dry-run` at the pin prints `unchanged: 5`.
- **Verify, unit.**
  - A sync test: a hand edit with no `forks.json` entry fails.
  - A sync test: a denylist hit writes nothing.
  - `docs/parity.diff` is empty.
- **Verify, live.** `git diff --no-index` between upstream and the port prints nothing.

### P2. Add the rewrite rules

- **Depends on.** P1.
- **Build.** Add rules 1 to 5, the frontmatter rules, and the denylist. Re-sync at the same pin.
- **You see.** `docs/parity.diff` holds exactly these hunks: 5 rule hunks across the 3 files that change, plus 2 frontmatter removals.
- **Verify, unit.**
  - Each rule has a test with the upstream line in and the port line out.
  - The denylist scan of the tree passes.
  - Every invariant has a must-fail fixture.

### P3. Package for Claude Code

- **Depends on.** P2.
- **Build.**
  - Add `.claude-plugin/plugin.json` and the root `marketplace.json`.
  - Add `generate.mjs` with version stamping and `--check`.
  - Add the packaging and frontmatter tests.
- **Verify, unit.** `generate --check` passes. The packaging test passes, and its fixture with mismatched versions fails.
- **Verify, live.**
  1. Run `claude plugin marketplace add C:\Git\thermos-claude`, then `claude plugin install thermos@thermos-claude`.
  2. Build a scratch fixture repo with a `feature` branch. Plant a SQL string concatenation and a new 1,100-line file in it.
  3. Run `claude -p "/thermos:thermos review feature against main" --output-format stream-json`.

  The phase passes when all of the following hold:
  - One assistant message holds two `Agent` calls with the namespaced types.
  - Each subagent loads its rubric.
  - The review pass reports the SQL injection.
  - The quality pass flags the 1,100-line file under the 1k-line rule.
  - The final message is one merged verdict.

  Then run a regression lane: the same run against the kdoroszewicz port shows the rubric failing to load. That proves the check can tell the two apart.
- **Prototype fork.** If the "Load the skill" instruction does not load the rubric, add `skills: [thermo-nuclear-review]` frontmatter through a frontmatter rule and record the result in `forks.json`.

### P4. Package for Codex

- **Depends on.** P3.
- **Build.**
  - Add `.codex-plugin/plugin.json` and `.agents/plugins/marketplace.json`.
  - Add `codex-tools.md` and `openai.yaml`.
  - Extend the generator to stamp the preamble and vendor the agents.
  - Add a test that every vendored agent is named in `codex-tools.md`.
- **Verify, unit.**
  - `generate --check` passes.
  - The Codex marketplace validator passes: one entry, its name equals the manifest name, and its path exists.
  - The skills-only install check passes: `npx skills add ./plugins/thermos/skills --agent codex --copy` gives the same tree.
- **Verify, live.** Install through `codex plugin marketplace add`, then run the same fixture with `$thermos:thermos`. The phase passes when the session shows two `spawn_agent` calls in one response, each child reading its vendored file, and the same two planted findings. Rerun with `agents.enabled = false` and confirm the run states that the passes ran in sequence.

### P5. Write CI and the docs

- **Depends on.** P4.
- **Build.**
  - Add CI jobs: `generate --check`, `sync --dry-run` at the pin, `bun test` on ubuntu and windows, and actionlint.
  - Pin every action to a SHA and add Dependabot.
  - Write the README with installs for both runtimes and the ported mermaid diagram.
  - Write `CONTEXT.md` (the ownership rules) and `CONTRIBUTING.md` (bump `VERSION`, add a CHANGES heading, run the generator).
- **Verify, unit.** CI is green on a PR. A deliberately stale `VERSION` in a test commit turns CI red.
- **Verify, live.** Install from GitHub, not a local path, on both runtimes.

The live checks do not run in CI, because they need a signed-in `claude` and `codex`. Each phase's PR records their transcripts.

## Throughput checkpoint

- **Blocking first steps.** P1's sync tool. Everything else derives from it.
- **Independent workstreams.** After P2, the Claude work (P3) and the Codex manifest and mapping drafting (P4) touch different files and can run in parallel. P4's live check needs P3's fixture repo.
- **Shared mutable state.** `generate.mjs` is touched by both P3 and P4. Land P3's generator first.
- **Smallest safe decomposition.** The 6 phases above.

## Scrap triggers

Redesign instead of patching if any of these appear:

- A second rule that edits only one sentence of one file. Make it a fork instead.
- A Codex-specific sentence creeping into skill text, outside the stamped preamble.
- Rubric text copied into the agent bodies.
- A need for three-way merge, meaning upstream edits forked files repeatedly.

## Implementation reconciliation

These are the accepted deviations from the sketch above, with what forced each one.

- **Pin.** `dc41543`, the last commit that touches `thermos/`, replaces the merge commit `ccb5507`. Both commits have the same `thermos/` tree. Source: `git log -- thermos` on a full clone.
- **Phases.** P0 to P2 landed as one commit, and P3 and P4 as another. The derivation already included the frontmatter rules and the preamble, and the Codex mapping file must exist before the link check passes.
- **No `package.json` or `bun.lock`.** The tools need no dependencies, because Bun ships `Bun.YAML`.
- **`sync.mjs --rederive`.** Changing a rule makes the old output look like an undeclared fork, so a mode that rewrites the non-forked files at the pin is needed.
- **`parity.diff` ignores git config.** The milestone 1 review showed that a user's `diff.noprefix` or `diff.context` changed its bytes. The diff now runs with an empty global config and explicit format flags.
- **Codex invocation is `$thermos:thermos`.** Codex namespaces plugin skills. With `allow_implicit_invocation: false`, it also hides `thermos:thermos` from the model's skill list, so a bare `$thermos` ran the `thermo-nuclear-review` rubric alone. Source: the P4 live run and its rollout.
- **No `skills:` preload.** In the P3 live run, both subagents loaded `thermos:thermo-nuclear-review` and `thermos:thermo-nuclear-code-quality-review` through the Skill tool from the agent body's bare-name instruction. The prototype fork was not needed.
- **Sequential fallback not exercised live.** In codex-cli 0.162.0, neither `--disable multi_agent` nor `-c agents.enabled=false` stopped `spawn_agent`. Both runs still spawned two reviewers. The fallback in `codex-tools.md` is written, but it is unverified.
- **Live installs.** P3 ran first with `--plugin-dir`, and P4 ran first from a local marketplace. The milestone 2 review flagged that, so both runtimes were then installed from GitHub (`feat/port`) and passed again (docs/verification.md).
- **Docs quote the pin.** `NOTICE.md` and `docs/reference.md` quote the pinned commit, and `generate.mjs --check` fails when either one disagrees with `tools/upstream.json`.
## Decisions

These questions were answered on 2026-10-09.

- **Repo.** `JackD111/thermos-claude`, following the `<upstream>-claude` naming that pstack-claude uses, so a search for "thermos claude" finds it.
- **Version.** Start at `0.1.0`. Record upstream `1.0.0` in `upstream.json`.
- **Logo.** Ship without a logo in v0.1.0. `assets/` stays on the exclude list, and the Codex `interface` block has no `logo` or `composerIcon`. Upstream's MIT license covers the file, but the logo is Cursor branding, and pstack-claude made its own icon for this reason. A port-made icon can come later.
- **Codex CLI.** codex-cli 0.162.0 is installed, so P4's live check runs locally. Claude Code 2.1.146 is installed for P3.

- **Codex plugin agents.** Not in v0.1.0. Revisit if openai/codex #18988 lands, then generate Codex TOML agents from `agents/*.md`.
- **Orchestrator flag.** `thermos` keeps `disable-model-invocation: true`, for parity with upstream: a full two-agent review stays user-triggered. Only the two rubric skills drop the flag. P3 confirms that `/thermos:thermos` still runs with the flag on.

## Open questions and risks

None open. Two risks remain. Codex's plugin format is still changing, so P4 pins the tested codex-cli version in `docs/reference.md`. The live checks need signed-in CLIs and cannot run in CI.
## Next implementation step

None. v0.1.0 is implemented. Follow-up work starts from [CONTRIBUTING.md](../CONTRIBUTING.md).
