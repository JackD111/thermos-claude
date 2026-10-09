# Contributing

Upstream owns the skill and agent content. This repo owns the translation from Cursor to Claude Code and Codex. Each file under `plugins/thermos` has exactly one owner:

| Owner | Files | How to change them |
|---|---|---|
| Upstream | `agents/*.md`, `skills/*/SKILL.md` | Run `tools/sync.mjs`. Never edit these files by hand unless you declare a fork. |
| Generator | `version` in the manifests and marketplace, `skills/thermos/references/agents/*.md` | Run `bun tools/generate.mjs`. |
| Port | Everything else | Edit the file. |

## Sync to a newer upstream

1. Find the newest cursor/plugins commit that touches `thermos/`.
2. Preview the sync without writing anything:

   ```bash
   bun tools/sync.mjs <sha> --dry-run
   ```

3. Run the sync. It writes the files, advances the pin in `tools/upstream.json`, and rewrites `docs/parity.diff`:

   ```bash
   bun tools/sync.mjs <sha>
   ```

4. Read `docs/parity.diff` in the PR. It must hold only the declared rewrites.

A sync fails, and writes nothing, in each of these cases:

- A Cursor-ism survives. Add a substitution rule, with a `rationale`, to `tools/substitutions.json`.
- A file differs from the derived upstream with no `tools/forks.json` entry.
- Upstream changed a file the port forks. Merge the upstream change by hand, then rerun with `--accept-forks`.

## Change a rewrite rule

1. Edit `tools/substitutions.json`. Every rule needs a `rationale`.
2. Rewrite the derived files with the new rules:

   ```bash
   bun tools/sync.mjs --rederive
   ```

3. Add a test in `tests/derive.test.mjs` that pairs an upstream line with its port line.

## Fork a file on purpose

Prefer a substitution rule. If a change cannot be a mechanical rewrite, edit the file and add an entry to `tools/forks.json` with these fields:

- `kind`: `port-feature` or `policy`.
- `why`: one sentence.
- `since`: the version.
- `upstream`: `not-proposed`, or a PR or issue URL.

Keep the fork small, because every upstream edit to that file needs a manual merge.

## Release

Plugin updates install by version number, so a fix without a version bump never reaches installed copies.

1. Bump `VERSION`.
2. Add a `## <version> - <title>` entry at the top of `CHANGES.md`.
3. Run `bun tools/generate.mjs` to stamp the version.

## Before you push

Run all three checks. CI runs the same ones.

```bash
bun tools/sync.mjs --check
```

```bash
bun tools/generate.mjs --check
```

```bash
bun test
```
