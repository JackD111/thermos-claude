import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	applySubstitutions,
	CODEX_PREAMBLE,
	denylistHits,
	derive,
	loadRules,
	parseForks,
	parseRule,
	parseSubstitutions,
	portFrontmatter,
	repo,
	stampLeadLine,
} from "../tools/derive.mjs";

const rules = loadRules();
const sub = (text, rel = "agents/x.md") => applySubstitutions(text, rules.substitutions, rel).text;

describe("substitution rules", () => {
	// Upstream line in, port line out. One case per rule in tools/substitutions.json.
	test.each([
		["You are a **Task subagent**. The parent agent", "You are an **`Agent` subagent**. The parent agent"],
		["scoped to the diff. Invoked via Task after a parent gathers diff", "scoped to the diff. Invoked via the Agent tool after a parent gathers diff"],
		[
			"in **one** message, run two `Task` calls in parallel — `subagent_type: \"shell\"` and `subagent_type: \"explore\"` — to collect",
			"in **one** message, run a `Bash` call and an `Agent` call with `subagent_type: \"Explore\"` in parallel to collect",
		],
		['`subagent_type: "thermo-nuclear-review-subagent"` for bugs', '`subagent_type: "thermos:thermo-nuclear-review-subagent"` for bugs'],
		[
			'`subagent_type: "thermo-nuclear-code-quality-review-subagent"` for maintainability',
			'`subagent_type: "thermos:thermo-nuclear-code-quality-review-subagent"` for maintainability',
		],
	])("%s", (upstream, port) => {
		expect(sub(upstream)).toBe(port);
	});

	test("every rule fires at least once on the pinned upstream text", () => {
		// A rule whose replacement never reaches the committed tree matched nothing upstream.
		const tree = ["agents/thermo-nuclear-review-subagent.md", "agents/thermo-nuclear-code-quality-review-subagent.md", "skills/thermos/SKILL.md"]
			.map((rel) => readFileSync(join(repo, "plugins/thermos", rel), "utf8"))
			.join("\n");
		for (const rule of JSON.parse(readFileSync(join(repo, "tools/substitutions.json"), "utf8")).substitutions) {
			expect(tree).toContain(rule.replacement);
		}
	});

	test("agent-only rules leave skills alone", () => {
		expect(sub("You are a **Task subagent**.", "skills/thermos/SKILL.md")).toBe("You are a **Task subagent**.");
	});

	test("rewriting is idempotent", () => {
		const once = sub('run two `Task` calls in parallel — `subagent_type: "shell"` and `subagent_type: "explore"` —');
		expect(sub(once)).toBe(once);
		expect(sub('subagent_type: "thermos:thermo-nuclear-review-subagent"')).toBe('subagent_type: "thermos:thermo-nuclear-review-subagent"');
	});
});

describe("rule parsing", () => {
	test("rejects a rule without a rationale", () => {
		expect(() => parseRule({ pattern: "a", replacement: "b" }, 0)).toThrow("rationale");
	});
	test("rejects both pattern and regex", () => {
		expect(() => parseRule({ pattern: "a", regex: "a", replacement: "b", rationale: "r" }, 0)).toThrow("exactly one");
	});
	test("rejects unknown fields", () => {
		expect(() => parseRule({ pattern: "a", replacement: "b", rationale: "r", flags: "g" }, 0)).toThrow("unknown field");
	});
	test("rejects a later rule its earlier rule would consume", () => {
		const substitutions = [
			{ pattern: "Task", replacement: "Agent", rationale: "r" },
			{ pattern: "Task subagent", replacement: "Agent subagent", rationale: "r" },
		];
		expect(() => parseSubstitutions({ substitutions })).toThrow("move it above");
	});
	test("rejects a denylist entry without a hint", () => {
		expect(() => parseSubstitutions({ denylist: [{ token: "x" }] })).toThrow("hint");
	});
});

describe("denylist", () => {
	test.each([
		"run two `Task` calls",
		"You are a **Task subagent**.",
		"Invoked via Task after the parent changes its wording",
		'subagent_type: "generalPurpose"',
		'subagent_type: "shell"',
		'subagent_type: "explore"',
		'subagent_type: "thermo-nuclear-review-subagent"',
		"see .cursor/rules",
		"install with /add-plugin thermos",
		"is_background: true",
	])("flags %s", (line) => {
		expect(denylistHits("f.md", line, rules.denylist)).not.toEqual([]);
	});

	test("passes the committed port tree", () => {
		for (const rel of [
			"agents/thermo-nuclear-review-subagent.md",
			"agents/thermo-nuclear-code-quality-review-subagent.md",
			"skills/thermos/SKILL.md",
			"skills/thermo-nuclear-review/SKILL.md",
			"skills/thermo-nuclear-code-quality-review/SKILL.md",
		]) {
			expect(denylistHits(rel, readFileSync(join(repo, "plugins/thermos", rel), "utf8"), rules.denylist)).toEqual([]);
		}
	});
});

describe("portFrontmatter", () => {
	const skill = (name) => `---\nname: ${name}\ndescription: d\ndisable-model-invocation: true\n---\n\n# T\n`;

	test("rubric skills drop disable-model-invocation", () => {
		expect(portFrontmatter("skills/thermo-nuclear-review/SKILL.md", skill("thermo-nuclear-review"))).not.toContain("disable-model-invocation");
		expect(portFrontmatter("skills/thermo-nuclear-code-quality-review/SKILL.md", skill("thermo-nuclear-code-quality-review"))).not.toContain(
			"disable-model-invocation",
		);
	});

	test("the thermos orchestrator keeps it", () => {
		expect(portFrontmatter("skills/thermos/SKILL.md", skill("thermos"))).toContain("disable-model-invocation: true");
	});

	test("name follows the directory or file name", () => {
		expect(portFrontmatter("agents/real-name.md", "---\nname: Real Name\ndescription: d\n---\nbody")).toBe("---\nname: real-name\ndescription: d\n---\nbody");
	});

	test("Cursor-only keys go with their continuation lines", () => {
		const text = "---\nname: a\nmode: agent\nicon: flame\ncolor: red\nreminder: |\n  line one\n  line two\nis_background: true\ndescription: d\n---\nbody";
		expect(portFrontmatter("agents/a.md", text)).toBe("---\nname: a\ndescription: d\n---\nbody");
	});

	test("the body is untouched, even a body line that looks like frontmatter", () => {
		const text = "---\nname: x\ndescription: d\n---\n\nis_background: true\ndisable-model-invocation: true\n";
		expect(portFrontmatter("skills/x/SKILL.md", text)).toBe("---\nname: x\ndescription: d\n---\n\nis_background: true\ndisable-model-invocation: true\n");
	});

	test("files outside skills and agents are untouched", () => {
		const text = "---\nname: x\ndisable-model-invocation: true\n---\n";
		expect(portFrontmatter("skills/thermos/references/x.md", text)).toBe(text);
	});
});

describe("stampLeadLine and derive", () => {
	test("stamps under the first H1, once", () => {
		const once = stampLeadLine("---\nname: thermos\n---\n\n# Thermos\n\nBody.\n", CODEX_PREAMBLE);
		expect(once).toBe(`---\nname: thermos\n---\n\n# Thermos\n\n${CODEX_PREAMBLE}\n\nBody.\n`);
		expect(stampLeadLine(once, CODEX_PREAMBLE)).toBe(once);
	});

	test("fails without an H1", () => {
		expect(() => stampLeadLine("no heading", CODEX_PREAMBLE)).toThrow("no H1");
	});

	test("only the thermos skill gets the Codex preamble", () => {
		const text = "---\nname: n\ndescription: d\n---\n\n# T\n\nBody.\n";
		expect(derive("skills/thermos/SKILL.md", text, rules)).toContain(CODEX_PREAMBLE);
		expect(derive("skills/thermo-nuclear-review/SKILL.md", text, rules)).not.toContain(CODEX_PREAMBLE);
		expect(derive("agents/a.md", text, rules)).not.toContain(CODEX_PREAMBLE);
	});
});

describe("parseForks", () => {
	const entry = { kind: "policy", why: "Because.", since: "0.1.0", upstream: "not-proposed" };

	test("keys entries by upstream-relative path", () => {
		const forks = parseForks({ "plugins/thermos/skills/thermos/SKILL.md": entry });
		expect([...forks.keys()]).toEqual(["skills/thermos/SKILL.md"]);
	});

	test.each([
		[{ "elsewhere/x.md": entry }, "not under"],
		[{ "plugins/thermos/x.md": { ...entry, kind: "whim" } }, "unknown kind"],
		[{ "plugins/thermos/x.md": { ...entry, since: "soon" } }, "not a version"],
		[{ "plugins/thermos/x.md": { ...entry, upstream: "https://example.com" } }, "neither"],
		[{ "plugins/thermos/x.md": { kind: "policy" } }, "missing field"],
		[{ "plugins/thermos/x.md": { ...entry, extra: 1 } }, "unknown field"],
	])("rejects %j", (registry, message) => {
		expect(() => parseForks(registry)).toThrow(message);
	});
});
