#!/usr/bin/env bun
// Keep plugins/thermos equal to derive(upstream@pin), apart from declared forks.
//
//   bun tools/sync.mjs <sha> [--dry-run] [--accept-forks]   move the pin to <sha>
//   bun tools/sync.mjs --check                              CI: the tree matches the pin
//   bun tools/sync.mjs --rederive                           rewrite non-forked files with the current rules
//   bun tools/sync.mjs --report                             rewrite docs/parity.diff
//
// tools/upstream.json holds the remote, the pinned sha, and the upstream paths
// the port does not carry. Per upstream file, with old = derive(file@pin) and
// new = derive(file@sha):
//
//   - port copy missing -> added (under --check: an error)
//   - port copy equals new -> unchanged (a forks.json entry for it is stale)
//   - port copy equals old -> updated, written
//   - port copy differs and forks.json has no entry -> undeclared fork, error
//   - declared fork, upstream unchanged -> forked, kept
//   - declared fork, upstream changed -> error that prints the upstream diff;
//     merge it by hand, then rerun with --accept-forks
//   - upstream deleted it -> deleted when the port copy equals old, else error
//
// Every effective text is denylist-scanned. Any error writes nothing and
// leaves the pin. A successful real run writes, then advances the pin.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { denylistHits, derive, loadRules, parseForks, PLUGIN, repo } from "./derive.mjs";

export function loadUpstream(root = repo) {
	const spec = JSON.parse(readFileSync(join(root, "tools/upstream.json"), "utf8"));
	for (const field of ["remote", "upstreamPath", "localPath", "sha", "exclude"]) {
		if (spec[field] == null) throw new Error(`upstream.json: missing "${field}"`);
	}
	if (!/^[0-9a-f]{40}$/.test(spec.sha)) throw new Error(`upstream.json: sha "${spec.sha}" is not a full commit sha`);
	return spec;
}

export function isExcluded(rel, exclude) {
	return exclude.some((entry) => (entry.endsWith("/") ? rel.startsWith(entry) : rel === entry));
}

// Pure: decide every file's outcome. Nothing here touches the disk.
// oldFiles and newFiles map upstream-relative paths to raw upstream text;
// localFiles maps the same paths to the port's text, or omits them.
export function plan({ oldFiles, newFiles, localFiles, rules, forks, atPin = false, acceptForks = false, rederive = false }) {
	const outcomes = [];
	const writes = new Map();
	const errors = [];
	const warnings = [];
	const rels = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort();
	for (const rel of rels) {
		const dOld = oldFiles.has(rel) ? derive(rel, oldFiles.get(rel), rules) : null;
		const dNew = newFiles.has(rel) ? derive(rel, newFiles.get(rel), rules) : null;
		const local = localFiles.get(rel) ?? null;
		const fork = forks.get(rel);
		const record = (outcome) => outcomes.push({ rel, outcome });

		if (dNew === null) {
			if (local === null) record("gone");
			else if (local === dOld) {
				record("deleted");
				writes.set(rel, null);
			} else errors.push(`${rel}: upstream deleted it, but the port copy differs; delete it or make it port-owned by hand`);
			continue;
		}
		for (const hit of denylistHits(rel, fork && local !== null ? local : dNew, rules.denylist)) errors.push(hit);
		if (local === null) {
			if (atPin) errors.push(`${rel}: upstream has it at the pin, but the port lacks it; run a sync`);
			record("added");
			writes.set(rel, dNew);
		} else if (local === dNew) {
			record("unchanged");
			if (fork) (atPin ? errors : warnings).push(`${rel}: forks.json declares a fork, but the file equals upstream; remove the entry`);
		} else if (!fork && (local === dOld || rederive)) {
			record("updated");
			writes.set(rel, dNew);
		} else if (!fork) {
			errors.push(`${rel}: differs from derived upstream with no forks.json entry; declare it or rerun the sync`);
		} else if (dOld === dNew || acceptForks) {
			record("forked");
		} else {
			errors.push(
				`${rel}: upstream changed this forked file; merge by hand, then rerun with --accept-forks\n` + unifiedDiff(dOld ?? "", dNew),
			);
		}
	}
	return { outcomes, writes, errors, warnings };
}

// Upstream's tree at `sha`, through a cached bare clone that fetches only that
// commit. `remote` may be a URL or a local repository path (tests use one).
export function upstreamFiles({ remote, sha, upstreamPath, exclude, cache = join(repo, ".cache/upstream.git") }) {
	if (!existsSync(cache)) git(["init", "--quiet", "--bare", cache]);
	const has = spawnSync("git", ["-C", cache, "cat-file", "-e", `${sha}^{commit}`]).status === 0;
	if (!has) git(["-C", cache, "fetch", "--quiet", "--depth", "1", remote, sha]);
	const listing = git(["-C", cache, "ls-tree", "-r", "-z", sha, "--", upstreamPath]).toString("utf8");
	const files = new Map();
	for (const entry of listing.split("\0").filter(Boolean)) {
		const [meta, path] = entry.split("\t");
		const [mode, type, object] = meta.split(" ");
		if (type !== "blob") continue;
		const rel = path.slice(upstreamPath.length + 1);
		if (isExcluded(rel, exclude)) continue;
		if (mode === "120000") throw new Error(`${path}: upstream symlink; exclude it in upstream.json`);
		const raw = git(["-C", cache, "cat-file", "blob", object]);
		const text = raw.toString("utf8");
		if (raw.includes(0) || !Buffer.from(text).equals(raw)) throw new Error(`${path}: binary upstream file; exclude it in upstream.json`);
		files.set(rel, text);
	}
	if (!files.size) throw new Error(`no upstream files under ${upstreamPath} at ${sha}`);
	return files;
}

function git(args, options = {}) {
	return execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, ...options });
}

function readLocal(root, localPath, rels) {
	const local = new Map();
	for (const rel of rels) {
		const path = join(root, localPath, rel);
		if (existsSync(path)) local.set(rel, readFileSync(path, "utf8"));
	}
	return local;
}

export function unifiedDiff(a, b) {
	const dir = mkdtempSync(join(tmpdir(), "thermos-diff-"));
	try {
		writeFileSync(join(dir, "old"), a);
		writeFileSync(join(dir, "new"), b);
		return diffNoIndex(dir, "old", "new");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// The output must be the same bytes on every machine, so no user or system
// git config or attributes reach it (diff.noprefix, diff.context, a global
// `*.md diff=markdown`, and the like), and every format choice is spelled out.
const GIT_CONFIG_ENV = /^GIT_CONFIG(?:_|$)|^GIT_CONFIG_PARAMETERS$/;

// `emptyConfig` is an empty file: Git for Windows rejects the null device here.
export function isolatedGitEnv(emptyConfig, env = process.env) {
	const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !GIT_CONFIG_ENV.test(key)));
	return { ...clean, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1" };
}

function diffNoIndex(cwd, a, b) {
	const emptyConfig = join(cwd, ".empty-gitconfig");
	writeFileSync(emptyConfig, "");
	const out = spawnSync(
		"git",
		[
			"-c", "core.autocrlf=false",
			"-c", "core.quotepath=false",
			"-c", `core.attributesFile=${emptyConfig}`,
			"diff", "--no-index", "--no-color", "--no-ext-diff", "--no-renames",
			"--src-prefix=a/", "--dst-prefix=b/", "--diff-algorithm=myers", "--unified=3", "--inter-hunk-context=0",
			"--", a, b,
		],
		{ cwd, encoding: "utf8", maxBuffer: 64 << 20, env: isolatedGitEnv(emptyConfig) },
	);
	if (out.status > 1) throw new Error(`git diff --no-index failed: ${out.stderr}`);
	return out.stdout;
}

// docs/parity.diff: every byte the port changes in an upstream-owned file,
// raw upstream at the pin on the left and the committed port on the right.
export function parityReport(upstream, local) {
	const dir = mkdtempSync(join(tmpdir(), "thermos-parity-"));
	try {
		for (const [side, files] of [["upstream", upstream], ["port", local]]) {
			for (const [rel, text] of files) {
				mkdirSync(dirname(join(dir, side, rel)), { recursive: true });
				writeFileSync(join(dir, side, rel), text);
			}
		}
		return diffNoIndex(dir, "upstream", "port");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export function loadForks(root = repo) {
	return parseForks(JSON.parse(readFileSync(join(root, "tools/forks.json"), "utf8")));
}

// The CLI. `root` and `cache` are parameters so tests can run it against a
// scratch tree and a local upstream repository.
export function main(argv, { root = repo, cache = join(root, ".cache/upstream.git"), log = console.log, error = console.error } = {}) {
	const flags = new Set(argv.filter((a) => a.startsWith("--")));
	const [target] = argv.filter((a) => !a.startsWith("--"));
	const spec = loadUpstream(root);
	if (spec.localPath !== PLUGIN) throw new Error(`upstream.json localPath "${spec.localPath}" != ${PLUGIN}`);
	const rules = loadRules(root);
	const forks = loadForks(root);
	const parityPath = join(root, "docs/parity.diff");
	const fetch = (sha) => upstreamFiles({ ...spec, sha, cache });
	const local = (files) => readLocal(root, spec.localPath, [...files.keys()]);

	if (flags.has("--report")) {
		const upstream = fetch(spec.sha);
		mkdirSync(dirname(parityPath), { recursive: true });
		writeFileSync(parityPath, parityReport(upstream, local(upstream)));
		log("wrote docs/parity.diff");
		return 0;
	}

	const check = flags.has("--check");
	const rederive = flags.has("--rederive");
	const sha = check || rederive ? spec.sha : target;
	if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
		error("usage: bun tools/sync.mjs <40-char sha> [--dry-run] [--accept-forks] | --rederive | --check | --report");
		return 2;
	}
	const oldFiles = fetch(spec.sha);
	const newFiles = sha === spec.sha ? oldFiles : fetch(sha);
	const result = plan({
		oldFiles,
		newFiles,
		localFiles: readLocal(root, spec.localPath, [...new Set([...oldFiles.keys(), ...newFiles.keys()])]),
		rules,
		forks,
		atPin: check,
		acceptForks: flags.has("--accept-forks"),
		rederive,
	});
	for (const { rel, outcome } of result.outcomes) log(`${outcome.padEnd(9)} ${rel}`);
	for (const warning of result.warnings) error(`warning: ${warning}`);
	if (check) {
		if (!existsSync(parityPath)) result.errors.push("docs/parity.diff is missing; run bun tools/sync.mjs --report");
		else if (readFileSync(parityPath, "utf8") !== parityReport(oldFiles, local(oldFiles))) {
			result.errors.push("docs/parity.diff is stale; run bun tools/sync.mjs --report");
		}
	}
	if (result.errors.length) {
		for (const message of result.errors) error(`error: ${message}`);
		return 1;
	}
	if (check || flags.has("--dry-run")) return 0;
	for (const [rel, text] of result.writes) {
		const path = join(root, spec.localPath, rel);
		if (text === null) unlinkSync(path);
		else {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text);
		}
	}
	const upstreamJson = join(root, "tools/upstream.json");
	writeFileSync(upstreamJson, readFileSync(upstreamJson, "utf8").replace(spec.sha, sha));
	mkdirSync(dirname(parityPath), { recursive: true });
	writeFileSync(parityPath, parityReport(newFiles, local(newFiles)));
	log(`pin ${spec.sha.slice(0, 7)} -> ${sha.slice(0, 7)}; rewrote docs/parity.diff`);
	return 0;
}
if (import.meta.main) process.exit(main(process.argv.slice(2)));
