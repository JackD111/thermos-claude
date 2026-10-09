// The port's derivation of an upstream thermos file. sync.mjs, generate.mjs,
// and the tests all call derive(); none keeps its own copy of the rules.
//
//   derive(rel, text, rules) =
//     stampLeadLine(portFrontmatter(applySubstitutions(text)))
//
// `rel` is the path relative to the upstream plugin root, such as
// "skills/thermos/SKILL.md" or "agents/thermo-nuclear-review-subagent.md".

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN = "plugins/thermos";
export const NAMESPACE = "thermos";

// The one skill that keeps `disable-model-invocation: true`: a full two-agent
// review stays user-triggered, as upstream intends. The rubric skills lose the
// flag because their subagents load them through the Skill tool, which refuses
// a skill that carries it (docs/design.md, Problem, constraint 2).
export const USER_ONLY_SKILLS = new Set(["thermos"]);

// Skills whose text dispatches subagents and so needs the Codex mapping.
export const CODEX_PREAMBLE = "On Codex, read the [platform mapping](references/codex-tools.md) before following this skill.";
export const PREAMBLE_SKILLS = new Set(["thermos"]);

const RULE_FIELDS = new Set(["pattern", "regex", "files", "replacement", "rationale"]);

export function parseRule(rule, i) {
	const fail = (message) => {
		throw new Error(`substitutions[${i}]: ${message}`);
	};
	const unknown = Object.keys(rule).filter((field) => !RULE_FIELDS.has(field));
	if (unknown.length) fail(`unknown field ${unknown.map((f) => `"${f}"`).join(", ")}`);
	const { pattern, regex, files, replacement, rationale } = rule;
	const source = pattern ?? regex;
	if ((pattern == null) === (regex == null) || typeof source !== "string" || !source) {
		fail("needs exactly one of a non-empty pattern or regex");
	}
	if (typeof replacement !== "string") fail("needs a replacement string");
	if (typeof rationale !== "string" || !rationale) fail("needs a rationale");
	if (files != null && typeof files !== "string") fail("files must be a regex source string");
	return {
		key: pattern ?? regex,
		match: pattern ?? new RegExp(regex, "g"),
		files: files ? new RegExp(files) : null,
		replacement,
	};
}

// Rules apply in order, each to the output of the ones before it. A rule whose
// pattern contains an earlier rule's pattern could never match, so that order
// fails here: put the longer pattern first.
export function parseSubstitutions({ substitutions = [], denylist = [] }) {
	const rules = substitutions.map(parseRule);
	substitutions.forEach((later, j) => {
		const earlier = substitutions.slice(0, j).findIndex((r) => r.pattern && later.pattern?.includes(r.pattern));
		if (earlier !== -1) {
			throw new Error(
				`substitutions[${j}] "${later.pattern}" contains substitutions[${earlier}] "${substitutions[earlier].pattern}", ` +
					"which runs first and consumes it; move it above",
			);
		}
	});
	denylist.forEach((entry, i) => {
		if ((entry.token == null) === (entry.regex == null)) throw new Error(`denylist[${i}]: needs exactly one of token or regex`);
		if (typeof entry.hint !== "string" || !entry.hint) throw new Error(`denylist[${i}]: needs a hint`);
	});
	return { substitutions: rules, denylist };
}

export function loadRules(root = repo) {
	return parseSubstitutions(JSON.parse(readFileSync(join(root, "tools/substitutions.json"), "utf8")));
}

export function applySubstitutions(text, rules, rel = "") {
	const counts = new Map();
	let out = text;
	for (const rule of rules) {
		if (rule.files && !rule.files.test(rel)) continue;
		let n = 0;
		out = out.replaceAll(rule.match, () => {
			n++;
			return rule.replacement;
		});
		if (n) counts.set(rule.key, (counts.get(rule.key) ?? 0) + n);
	}
	return { text: out, counts };
}

export function denylistHits(path, text, denylist) {
	const hits = [];
	text.split("\n").forEach((line, i) => {
		for (const { token, regex, hint } of denylist) {
			if (token ? line.includes(token) : new RegExp(regex).test(line)) {
				hits.push(`${path}:${i + 1}: "${token ?? regex}": ${hint}`);
			}
		}
	});
	return hits;
}

// Split a Markdown file into its YAML frontmatter and the text after it.
export function parseFrontmatter(text) {
	const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!block) return { data: null, head: "", body: text };
	return { data: Bun.YAML.parse(block[1]) ?? {}, head: block[0], body: text.slice(block[0].length) };
}

const CURSOR_ONLY_KEYS = /^(?:mode|icon|color|reminder|is_background):/;

// `name` becomes the skill directory or agent file name, which is how Claude
// Code registers it. Cursor-only keys go, with their continuation lines. The
// rubric skills lose disable-model-invocation; USER_ONLY_SKILLS keep it.
export function portFrontmatter(rel, text) {
	const skill = rel.match(/^skills\/([^/]+)\/SKILL\.md$/)?.[1];
	const name = skill ?? rel.match(/^agents\/([^/]+)\.md$/)?.[1];
	if (!name) return text;
	const { head, body } = parseFrontmatter(text);
	if (!head) return text;
	const kept = [];
	let dropping = false;
	for (const line of head.split("\n")) {
		dropping = CURSOR_ONLY_KEYS.test(line) || (dropping && /^\s/.test(line));
		if (dropping) continue;
		if (skill && !USER_ONLY_SKILLS.has(skill) && /^disable-model-invocation:\s*true\s*$/.test(line)) continue;
		kept.push(line.startsWith("name:") ? `name: ${name}` : line);
	}
	return kept.join("\n") + body;
}

// Put `lead` as its own paragraph under the file's first H1. Idempotent: a
// file that already carries the line is returned unchanged.
export function stampLeadLine(text, lead) {
	const lines = text.split("\n");
	if (lines.includes(lead)) return text;
	const h1 = lines.findIndex((line) => line.startsWith("# "));
	if (h1 === -1) throw new Error(`no H1 to stamp "${lead}" under`);
	lines.splice(h1 + 1, 0, "", lead);
	return lines.join("\n");
}

export function derive(rel, text, rules) {
	const substituted = applySubstitutions(text, rules.substitutions, rel).text;
	const fronted = portFrontmatter(rel, substituted);
	const skill = rel.match(/^skills\/([^/]+)\/SKILL\.md$/)?.[1];
	return PREAMBLE_SKILLS.has(skill) ? stampLeadLine(fronted, CODEX_PREAMBLE) : fronted;
}

const FORK_FIELDS = ["kind", "why", "since", "upstream"];
const FORK_KINDS = new Set(["port-feature", "policy"]);
const UPSTREAM_LINK = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(pull|issues)\/\d+$/;

// tools/forks.json maps each port path that diverges from derive() on purpose
// to why. Returns a Map keyed by the upstream-relative path.
export function parseForks(registry, localPath = PLUGIN) {
	const prefix = `${localPath}/`;
	const forks = new Map();
	for (const [path, entry] of Object.entries(registry)) {
		const fail = (message) => {
			throw new Error(`forks.json "${path}": ${message}`);
		};
		if (!path.startsWith(prefix)) fail(`not under ${localPath}`);
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail("must be an object");
		const unknown = Object.keys(entry).filter((field) => !FORK_FIELDS.includes(field));
		if (unknown.length) fail(`unknown field ${unknown.map((f) => `"${f}"`).join(", ")}`);
		const missing = FORK_FIELDS.filter((field) => entry[field] == null);
		if (missing.length) fail(`missing field ${missing.map((f) => `"${f}"`).join(", ")}`);
		if (!FORK_KINDS.has(entry.kind)) fail(`unknown kind "${entry.kind}"; use port-feature or policy`);
		if (typeof entry.why !== "string" || !entry.why.trim()) fail("why must be a sentence");
		if (!/^\d+\.\d+\.\d+$/.test(entry.since)) fail(`since "${entry.since}" is not a version`);
		if (entry.upstream !== "not-proposed" && !UPSTREAM_LINK.test(entry.upstream)) {
			fail(`upstream "${entry.upstream}" is neither not-proposed nor a GitHub pull or issue URL`);
		}
		forks.set(path.slice(prefix.length), entry);
	}
	return forks;
}
