import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repo } from "../tools/derive.mjs";
import { plan, problems, stale, stampVersion } from "../tools/generate.mjs";

// Tests here spawn git, which can stall for seconds on Windows runners.
setDefaultTimeout(30_000);

// Each guard gets a fixture that must trip it: a check that quietly matches
// nothing looks the same as a pass.
let dirs = [];
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	dirs = [];
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "thermos-gen-"));
	dirs.push(dir);
	for (const path of ["VERSION", "CHANGES.md", "NOTICE.md", "docs/reference.md", "tools/upstream.json", ".claude-plugin", ".agents", "plugins"]) {
		cpSync(join(repo, path), join(dir, path), { recursive: true });
	}
	return dir;
}
const edit = (dir, rel, fn) => writeFileSync(join(dir, rel), fn(readFileSync(join(dir, rel), "utf8")));
const P = "plugins/thermos";

describe("the committed tree", () => {
	test("has no stale generated file and no broken invariant", () => {
		expect(stale(repo, plan(repo))).toEqual([]);
		expect(problems(repo)).toEqual([]);
	});
});

describe("generated files", () => {
	test("a VERSION bump makes all three versioned files stale", () => {
		const dir = fixture();
		writeFileSync(join(dir, "VERSION"), "0.2.0\n");
		expect(stale(dir, plan(dir)).sort()).toEqual([
			".claude-plugin/marketplace.json",
			`${P}/.claude-plugin/plugin.json`,
			`${P}/.codex-plugin/plugin.json`,
		]);
	});

	test("a hand edit to a vendored agent copy is stale", () => {
		const dir = fixture();
		edit(dir, `${P}/skills/thermos/references/agents/thermo-nuclear-review-subagent.md`, (t) => t + "hand edit\n");
		expect(stale(dir, plan(dir))).toEqual([`${P}/skills/thermos/references/agents/thermo-nuclear-review-subagent.md`]);
	});

	test("a vendored copy with no source agent is an orphan", () => {
		const dir = fixture();
		writeFileSync(join(dir, P, "skills/thermos/references/agents/gone.md"), "x");
		expect(stale(dir, plan(dir))).toEqual([`${P}/skills/thermos/references/agents/gone.md (orphan)`]);
	});

	test("stampVersion refuses an ambiguous manifest", () => {
		expect(() => stampVersion('{"version":"1","x":{"version":"2"}}', "3", "f")).toThrow("exactly 1");
		expect(stampVersion('{\n\t"version": "0.1.0"\n}', "0.2.0", "f")).toBe('{\n\t"version": "0.2.0"\n}');
	});
});

describe("invariants", () => {
	test.each([
		[
			"a rubric skill with disable-model-invocation",
			(dir) => edit(dir, `${P}/skills/thermo-nuclear-review/SKILL.md`, (t) => t.replace("---\n\n#", "disable-model-invocation: true\n---\n\n#")),
			"stops its subagent loading it",
		],
		[
			"thermos without disable-model-invocation",
			(dir) => edit(dir, `${P}/skills/thermos/SKILL.md`, (t) => t.replace("disable-model-invocation: true\n", "")),
			"must keep disable-model-invocation",
		],
		[
			"thermos without its Codex invocation policy",
			(dir) => writeFileSync(join(dir, P, "skills/thermos/agents/openai.yaml"), "policy:\n  allow_implicit_invocation: true\n"),
			"allow_implicit_invocation: false",
		],
		[
			"thermos without the Codex preamble",
			(dir) => edit(dir, `${P}/skills/thermos/SKILL.md`, (t) => t.replace(/On Codex, read.*\n\n/, "")),
			"Codex preamble",
		],
		[
			"a skill whose name is not its directory",
			(dir) => edit(dir, `${P}/skills/thermo-nuclear-review/SKILL.md`, (t) => t.replace("name: thermo-nuclear-review", "name: other")),
			'!= directory "thermo-nuclear-review"',
		],
		[
			"an agent whose name is not its file name",
			(dir) => edit(dir, `${P}/agents/thermo-nuclear-review-subagent.md`, (t) => t.replace("name: thermo-nuclear-review-subagent", "name: Thermo")),
			"!= file name",
		],
		[
			"a bare subagent_type for a plugin agent",
			(dir) => edit(dir, `${P}/skills/thermos/SKILL.md`, (t) => t.replace('"thermos:thermo-nuclear-review-subagent"', '"thermo-nuclear-review-subagent"')),
			'dispatch "thermos:thermo-nuclear-review-subagent"',
		],
		[
			"a commands/ directory",
			(dir) => mkdirSync(join(dir, P, "commands")),
			"commands/ exists",
		],
		[
			"a merge conflict marker",
			(dir) => edit(dir, `${P}/skills/thermo-nuclear-review/SKILL.md`, (t) => t + "<<<<<<< local\n"),
			"conflict marker",
		],
		[
			"a broken link in the skills tree",
			(dir) => rmSync(join(dir, P, "skills/thermos/references/codex-tools.md")),
			'link "references/codex-tools.md" does not resolve',
		],
		[
			"a link that leaves the skills tree",
			(dir) => edit(dir, `${P}/skills/thermo-nuclear-review/SKILL.md`, (t) => t + "\nSee [notice](../../../../NOTICE.md).\n"),
			"leaves the skills tree",
		],
		[
			"manifests that disagree",
			(dir) => edit(dir, `${P}/.codex-plugin/plugin.json`, (t) => t.replace('"license": "MIT"', '"license": "ISC"')),
			'disagree on "license"',
		],
		[
			"a Codex manifest that ships agents",
			(dir) => edit(dir, `${P}/.codex-plugin/plugin.json`, (t) => t.replace('"skills":', '"agents": "./agents/",\n\t"skills":')),
			"cannot ship agents",
		],
		[
			"a Claude marketplace entry pointing elsewhere",
			(dir) => edit(dir, ".claude-plugin/marketplace.json", (t) => t.replace('"./plugins/thermos"', '"./thermos"')),
			"source must be",
		],
		[
			"a Codex marketplace with a non-local source",
			(dir) => edit(dir, ".agents/plugins/marketplace.json", (t) => t.replace('"source": "local"', '"source": "url"')),
			"source must be",
		],
		[
			"a VERSION with no CHANGES heading",
			(dir) => writeFileSync(join(dir, "VERSION"), "9.9.9\n"),
			'"## 9.9.9 - <title>"',
		],
		[
			"a skill description over 1024 characters",
			(dir) => edit(dir, `${P}/skills/thermo-nuclear-review/SKILL.md`, (t) => t.replace(/^description: .*$/m, `description: ${"x".repeat(1025)}`)),
			"description over 1024 characters",
		],
		[
			"a skill without a description",
			(dir) => edit(dir, `${P}/skills/thermo-nuclear-review/SKILL.md`, (t) => t.replace(/^description: .*\n/m, "")),
			"thermo-nuclear-review/SKILL.md: no description",
		],
		[
			"a skill without frontmatter",
			(dir) => writeFileSync(join(dir, P, "skills/thermo-nuclear-review/SKILL.md"), "# No frontmatter\n"),
			"thermo-nuclear-review/SKILL.md: no frontmatter",
		],
		[
			"an agent without a description",
			(dir) => edit(dir, `${P}/agents/thermo-nuclear-review-subagent.md`, (t) => t.replace(/^description: .*\n/m, "")),
			"frontmatter needs a name and a description",
		],
		[
			"an agent with invalid YAML frontmatter",
			(dir) => edit(dir, `${P}/agents/thermo-nuclear-review-subagent.md`, (t) => t.replace(/^description: /m, "description: [unclosed ")),
			"frontmatter is not valid YAML",
		],
		[
			"a Codex manifest whose skills path is wrong",
			(dir) => edit(dir, `${P}/.codex-plugin/plugin.json`, (t) => t.replace('"skills": "./skills/"', '"skills": "./skill/"')),
			'"skills" must be "./skills/"',
		],
		[
			"a Claude marketplace description that differs from the manifest",
			(dir) => edit(dir, ".claude-plugin/marketplace.json", (t) => t.replace(/("source": "\.\/plugins\/thermos",\s*"description": ")[^"]*"/, '$1different"')),
			"description differs from the plugin manifest",
		],
		[
			"a Claude marketplace without an owner name",
			(dir) => edit(dir, ".claude-plugin/marketplace.json", (t) => t.replace(/"owner": \{[^}]*\}/, '"owner": {}')),
			"needs owner.name",
		],
		[
			"a Codex marketplace without an install policy",
			(dir) => edit(dir, ".agents/plugins/marketplace.json", (t) => t.replace(/"policy": \{[^}]*\}/, '"policy": {}')),
			"needs policy.installation and policy.authentication",
		],
		[
			"a Codex marketplace entry named differently from the manifest",
			(dir) => edit(dir, ".agents/plugins/marketplace.json", (t) => t.replace('"name": "thermos",', '"name": "thermo",')),
			'.agents/plugins/marketplace.json: needs exactly one entry named "thermos"',
		],
		[
			"a second Claude marketplace entry",
			(dir) =>
				edit(dir, ".claude-plugin/marketplace.json", (t) => {
					const market = JSON.parse(t);
					market.plugins.push({ ...market.plugins[0], name: "other" });
					return JSON.stringify(market, null, "\t");
				}),
			'.claude-plugin/marketplace.json: needs exactly one entry named "thermos"',
		],
		[
			"a field missing from both manifests",
			(dir) => {
				for (const manifest of [`${P}/.claude-plugin/plugin.json`, `${P}/.codex-plugin/plugin.json`]) {
					edit(dir, manifest, (t) => t.replace(/\t"license": "MIT",\n/, ""));
				}
			},
			'.claude-plugin/plugin.json: missing "license"',
		],
		[
			"a pin bump the docs do not follow",
			(dir) => edit(dir, "tools/upstream.json", (t) => t.replace(/"sha": "[0-9a-f]{40}"/, `"sha": "${"a".repeat(40)}"`)),
			"NOTICE.md: does not quote the pinned upstream commit",
		],
		[
			"a Codex mapping that forgets a vendored agent",
			(dir) =>
				edit(dir, `${P}/skills/thermos/references/codex-tools.md`, (t) =>
					t.replaceAll("references/agents/thermo-nuclear-review-subagent.md", "references/agents/elsewhere.md"),
				),
			"does not name references/agents/thermo-nuclear-review-subagent.md",
		],
	])("flags %s", (_, mutate, message) => {
		const dir = fixture();
		mutate(dir);
		expect(problems(dir).join("\n")).toContain(message);
	});
});
