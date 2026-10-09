#!/usr/bin/env bun
// Stamp the generator-owned files and check every cross-file invariant.
//
//   bun tools/generate.mjs           write the generated files, then check
//   bun tools/generate.mjs --check   CI: fail on a stale generated file or a broken invariant
//
// Generated (regeneration overwrites hand edits):
//   - "version" in both plugin manifests and the Claude marketplace entry, from VERSION
//   - skills/thermos/references/agents/<name>.md, a copy of agents/<name>.md for
//     Codex, which cannot ship agent types (references/codex-tools.md)

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { CODEX_PREAMBLE, NAMESPACE, parseFrontmatter, PLUGIN, PREAMBLE_SKILLS, repo, USER_ONLY_SKILLS } from "./derive.mjs";

const CLAUDE_MANIFEST = `${PLUGIN}/.claude-plugin/plugin.json`;
const CODEX_MANIFEST = `${PLUGIN}/.codex-plugin/plugin.json`;
const CLAUDE_MARKETPLACE = ".claude-plugin/marketplace.json";
const CODEX_MARKETPLACE = ".agents/plugins/marketplace.json";
const VERSIONED = [CLAUDE_MANIFEST, CODEX_MANIFEST, CLAUDE_MARKETPLACE];
const VENDORED_AGENTS = `${PLUGIN}/skills/thermos/references/agents`;
const CODEX_MAPPING = `${PLUGIN}/skills/thermos/references/codex-tools.md`;
const SHARED_MANIFEST_FIELDS = ["name", "version", "description", "author", "homepage", "repository", "license", "keywords"];

const read = (root, rel) => readFileSync(join(root, rel), "utf8");

// Replace the file's single "version" value. A second "version" field would
// make the replace ambiguous, so it fails instead.
export function stampVersion(text, version, file) {
	const fields = text.match(/"version"\s*:\s*"[^"]*"/g) ?? [];
	if (fields.length !== 1) throw new Error(`${file}: expected exactly 1 "version" field, found ${fields.length}`);
	return text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
}

export function readVersion(root) {
	const version = read(root, "VERSION").trim();
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`VERSION "${version}" is not x.y.z`);
	return version;
}

export function agentFiles(root) {
	const dir = join(root, PLUGIN, "agents");
	return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
}

// Every generated file as its exact intended text.
export function plan(root = repo) {
	const version = readVersion(root);
	const intended = new Map();
	for (const file of VERSIONED) intended.set(file, stampVersion(read(root, file), version, file));
	for (const agent of agentFiles(root)) intended.set(`${VENDORED_AGENTS}/${agent}`, read(root, `${PLUGIN}/agents/${agent}`));
	return intended;
}

// Generated paths whose committed text differs from the plan, plus vendored
// copies the plan no longer produces.
export function stale(root, intended) {
	const out = [];
	for (const [file, text] of intended) {
		const path = join(root, file);
		if (!existsSync(path) || readFileSync(path, "utf8") !== text) out.push(file);
	}
	const dir = join(root, VENDORED_AGENTS);
	if (existsSync(dir)) {
		for (const f of readdirSync(dir)) if (!intended.has(`${VENDORED_AGENTS}/${f}`)) out.push(`${VENDORED_AGENTS}/${f} (orphan)`);
	}
	return out;
}

function* walk(dir) {
	for (const entry of readdirSync(dir).sort()) {
		const path = join(dir, entry);
		const stat = lstatSync(path);
		if (stat.isDirectory()) yield* walk(path);
		else yield path;
	}
}

const posix = (path) => path.split(sep).join("/");

export function validateSkills(root) {
	const faults = [];
	const skillsDir = join(root, PLUGIN, "skills");
	for (const entry of readdirSync(skillsDir).sort()) {
		const path = join(skillsDir, entry, "SKILL.md");
		const rel = posix(relative(root, path));
		if (!statSync(join(skillsDir, entry)).isDirectory() || !existsSync(path)) continue;
		const { data } = parseFrontmatter(readFileSync(path, "utf8"));
		if (!data) {
			faults.push(`${rel}: no frontmatter`);
			continue;
		}
		if (data.name !== entry) faults.push(`${rel}: frontmatter name "${data.name}" != directory "${entry}"`);
		if (typeof data.description !== "string" || !data.description) faults.push(`${rel}: no description`);
		else if (data.description.length > 1024) faults.push(`${rel}: description over 1024 characters`);
		const userOnly = data["disable-model-invocation"] === true;
		if (userOnly && !USER_ONLY_SKILLS.has(entry)) {
			faults.push(`${rel}: disable-model-invocation: true stops its subagent loading it through the Skill tool`);
		}
		if (!userOnly && USER_ONLY_SKILLS.has(entry)) faults.push(`${rel}: must keep disable-model-invocation: true (user-triggered only)`);
		if (USER_ONLY_SKILLS.has(entry)) {
			const policy = join(skillsDir, entry, "agents/openai.yaml");
			const allow = existsSync(policy) ? Bun.YAML.parse(readFileSync(policy, "utf8"))?.policy?.allow_implicit_invocation : undefined;
			if (allow !== false) faults.push(`${posix(relative(root, policy))}: needs policy.allow_implicit_invocation: false, Codex's match for disable-model-invocation`);
		}
		if (PREAMBLE_SKILLS.has(entry) && !readFileSync(path, "utf8").split("\n").includes(CODEX_PREAMBLE)) {
			faults.push(`${rel}: missing the Codex preamble line; run bun tools/sync.mjs --rederive`);
		}
	}
	return faults;
}

export function validateAgents(root) {
	const faults = [];
	for (const agent of agentFiles(root)) {
		const rel = `${PLUGIN}/agents/${agent}`;
		try {
			const { data } = parseFrontmatter(read(root, rel));
			if (!data?.name || !data?.description) faults.push(`${rel}: frontmatter needs a name and a description`);
			else if (data.name !== basename(agent, ".md")) faults.push(`${rel}: frontmatter name "${data.name}" != file name`);
		} catch (err) {
			faults.push(`${rel}: frontmatter is not valid YAML: ${err.message}`);
		}
	}
	return faults;
}

// A dispatch of a plugin agent by its bare name fails in Claude Code with
// "Agent type not found"; plugin agents register as thermos:<name>.
export function validateLayout(root) {
	const faults = [];
	const pluginRoot = join(root, PLUGIN);
	if (existsSync(join(pluginRoot, "commands"))) faults.push(`${PLUGIN}/commands/ exists; a command beside a same-named skill shows twice in the slash menu`);
	const agents = agentFiles(root).map((f) => basename(f, ".md"));
	for (const file of walk(pluginRoot)) {
		if (!file.endsWith(".md")) continue;
		readFileSync(file, "utf8").split("\n").forEach((line, i) => {
			for (const [, prefix, name] of line.matchAll(/subagent_type:\s*["'`]?(?:([a-z0-9-]+):)?([a-z0-9-]+)/g)) {
				if (agents.includes(name) && prefix !== NAMESPACE) {
					faults.push(`${posix(relative(root, file))}:${i + 1}: dispatch "${NAMESPACE}:${name}", not "${prefix ? `${prefix}:` : ""}${name}"`);
				}
			}
			if (/^(<{7}|={7}|>{7})( |$)/.test(line)) faults.push(`${posix(relative(root, file))}:${i + 1}: merge conflict marker`);
		});
	}
	return faults;
}

// Every relative Markdown link inside the skills tree resolves, and stays in
// the skills tree: Codex installs skills without the rest of the plugin.
export function validateLinks(root) {
	const faults = [];
	const skillsDir = resolve(root, PLUGIN, "skills");
	for (const file of walk(skillsDir)) {
		if (!file.endsWith(".md")) continue;
		for (const [, target] of readFileSync(file, "utf8").matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
			if (/^[a-z]+:/.test(target)) continue;
			const resolved = resolve(dirname(file), target);
			const rel = posix(relative(root, file));
			if (!resolved.startsWith(skillsDir + sep)) faults.push(`${rel}: link "${target}" leaves the skills tree`);
			else if (!existsSync(resolved)) faults.push(`${rel}: link "${target}" does not resolve`);
		}
	}
	return faults;
}

export function validatePackaging(root) {
	const faults = [];
	const json = (rel) => JSON.parse(read(root, rel));
	const claude = json(CLAUDE_MANIFEST);
	const codex = json(CODEX_MANIFEST);
	for (const field of SHARED_MANIFEST_FIELDS) {
		if (claude[field] == null) faults.push(`${CLAUDE_MANIFEST}: missing "${field}"`);
		if (JSON.stringify(claude[field]) !== JSON.stringify(codex[field])) faults.push(`manifests disagree on "${field}"`);
	}
	if ("agents" in codex) faults.push(`${CODEX_MANIFEST}: Codex plugins cannot ship agents; drop "agents"`);
	if (codex.skills !== "./skills/") faults.push(`${CODEX_MANIFEST}: "skills" must be "./skills/"`);

	const market = json(CLAUDE_MARKETPLACE);
	const entry = market.plugins?.find((p) => p.name === claude.name);
	if (market.plugins?.length !== 1 || !entry) faults.push(`${CLAUDE_MARKETPLACE}: needs exactly one entry named "${claude.name}"`);
	else {
		if (entry.source !== `./${PLUGIN}`) faults.push(`${CLAUDE_MARKETPLACE}: source must be "./${PLUGIN}"`);
		if (entry.version !== claude.version) faults.push(`${CLAUDE_MARKETPLACE}: version ${entry.version} != plugin ${claude.version}`);
		if (entry.description !== claude.description) faults.push(`${CLAUDE_MARKETPLACE}: description differs from the plugin manifest`);
	}
	if (typeof market.owner?.name !== "string") faults.push(`${CLAUDE_MARKETPLACE}: needs owner.name`);

	const codexMarket = json(CODEX_MARKETPLACE);
	const codexEntry = codexMarket.plugins?.[0];
	if (codexMarket.plugins?.length !== 1 || codexEntry.name !== codex.name) faults.push(`${CODEX_MARKETPLACE}: needs exactly one entry named "${codex.name}"`);
	else {
		if (codexEntry.source?.source !== "local" || codexEntry.source?.path !== `./${PLUGIN}`) {
			faults.push(`${CODEX_MARKETPLACE}: source must be { source: "local", path: "./${PLUGIN}" }`);
		}
		if (!codexEntry.policy?.installation || !codexEntry.policy?.authentication) faults.push(`${CODEX_MARKETPLACE}: needs policy.installation and policy.authentication`);
	}
	return faults;
}

// Plugin auto-update installs by version, so a release needs its CHANGES entry.
export function validateChanges(root) {
	const version = readVersion(root);
	const headings = read(root, "CHANGES.md").split("\n").filter((l) => /^## \d+\.\d+\.\d+/.test(l));
	if (!headings[0]?.startsWith(`## ${version} - `)) return [`CHANGES.md: newest heading must be "## ${version} - <title>"`];
	return [];
}

export function validateCodexMapping(root) {
	if (!existsSync(join(root, CODEX_MAPPING))) return [`${CODEX_MAPPING}: missing`];
	const mapping = read(root, CODEX_MAPPING);
	return agentFiles(root)
		.filter((agent) => !mapping.includes(`references/agents/${agent}`))
		.map((agent) => `${CODEX_MAPPING}: does not name references/agents/${agent}, so Codex never reads it`);
}

// The docs quote the upstream pin; they must quote the one sync.mjs uses.
export function validatePinQuotes(root) {
	const { sha } = JSON.parse(read(root, "tools/upstream.json"));
	return ["NOTICE.md", "docs/reference.md"]
		.filter((rel) => existsSync(join(root, rel)) && !read(root, rel).includes(sha))
		.map((rel) => `${rel}: does not quote the pinned upstream commit ${sha}`);
}

export function problems(root = repo) {
	return [
		...validatePinQuotes(root),
		...validateSkills(root),
		...validateAgents(root),
		...validateLayout(root),
		...validateLinks(root),
		...validatePackaging(root),
		...validateChanges(root),
		...validateCodexMapping(root),
	];
}

function main(argv) {
	const check = argv.includes("--check");
	const intended = plan(repo);
	if (check) {
		const old = stale(repo, intended);
		for (const file of old) console.error(`stale: ${file} (run bun tools/generate.mjs)`);
		const faults = problems(repo);
		for (const fault of faults) console.error(`error: ${fault}`);
		return old.length || faults.length ? 1 : 0;
	}
	for (const [file, text] of intended) {
		const path = join(repo, file);
		if (existsSync(path) && readFileSync(path, "utf8") === text) continue;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
		console.log(`wrote ${file}`);
	}
	for (const file of stale(repo, intended)) console.error(`remove by hand: ${file}`);
	const faults = problems(repo);
	for (const fault of faults) console.error(`error: ${fault}`);
	return faults.length ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
