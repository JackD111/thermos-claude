import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import { derive, loadRules, repo } from "../tools/derive.mjs";
import { isExcluded, parityReport, plan } from "../tools/sync.mjs";

const rules = loadRules();
const fork = { kind: "policy", why: "Because.", since: "0.1.0", upstream: "not-proposed" };
const files = (entries) => new Map(Object.entries(entries));
const run = (overrides) =>
	plan({ oldFiles: files({}), newFiles: files({}), localFiles: files({}), rules, forks: new Map(), ...overrides });

const A = "agents/a.md";
const v1 = "---\nname: a\ndescription: d\n---\n\nversion one\n";
const v2 = "---\nname: a\ndescription: d\n---\n\nversion two\n";

describe("plan", () => {
	test("adds a file the port lacks", () => {
		const r = run({ newFiles: files({ [A]: v1 }) });
		expect(r.outcomes).toEqual([{ rel: A, outcome: "added" }]);
		expect(r.writes.get(A)).toBe(derive(A, v1, rules));
	});

	test("under --check, a file the port lacks is an error", () => {
		const r = run({ oldFiles: files({ [A]: v1 }), newFiles: files({ [A]: v1 }), atPin: true });
		expect(r.errors.join()).toContain("port lacks it");
	});

	test("leaves an up-to-date file alone", () => {
		const r = run({ oldFiles: files({ [A]: v1 }), newFiles: files({ [A]: v1 }), localFiles: files({ [A]: derive(A, v1, rules) }) });
		expect(r.outcomes).toEqual([{ rel: A, outcome: "unchanged" }]);
		expect(r.writes.size).toBe(0);
		expect(r.errors).toEqual([]);
	});

	test("updates a clean file when upstream moves", () => {
		const r = run({ oldFiles: files({ [A]: v1 }), newFiles: files({ [A]: v2 }), localFiles: files({ [A]: derive(A, v1, rules) }) });
		expect(r.outcomes).toEqual([{ rel: A, outcome: "updated" }]);
		expect(r.writes.get(A)).toBe(derive(A, v2, rules));
	});

	test("an undeclared hand edit is an error and writes nothing", () => {
		const r = run({
			oldFiles: files({ [A]: v1, "agents/b.md": v1 }),
			newFiles: files({ [A]: v2, "agents/b.md": v1 }),
			localFiles: files({ [A]: "hand edited\n" }),
		});
		expect(r.errors.join()).toContain("no forks.json entry");
	});

	test("a declared fork is kept while upstream is still", () => {
		const r = run({
			oldFiles: files({ [A]: v1 }),
			newFiles: files({ [A]: v1 }),
			localFiles: files({ [A]: "forked\n" }),
			forks: new Map([[A, fork]]),
		});
		expect(r.outcomes).toEqual([{ rel: A, outcome: "forked" }]);
		expect(r.errors).toEqual([]);
	});

	test("a declared fork that upstream changed fails with the upstream diff", () => {
		const args = {
			oldFiles: files({ [A]: v1 }),
			newFiles: files({ [A]: v2 }),
			localFiles: files({ [A]: "forked\n" }),
			forks: new Map([[A, fork]]),
		};
		const r = run(args);
		expect(r.errors.join()).toContain("--accept-forks");
		expect(r.errors.join()).toContain("+version two");
		expect(run({ ...args, acceptForks: true }).errors).toEqual([]);
	});

	test("a stale fork entry is an error at the pin and a warning elsewhere", () => {
		const args = {
			oldFiles: files({ [A]: v1 }),
			newFiles: files({ [A]: v1 }),
			localFiles: files({ [A]: derive(A, v1, rules) }),
			forks: new Map([[A, fork]]),
		};
		expect(run({ ...args, atPin: true }).errors.join()).toContain("remove the entry");
		expect(run(args).warnings.join()).toContain("remove the entry");
	});

	test("--rederive rewrites a non-forked file to the current rules", () => {
		const r = run({ oldFiles: files({ [A]: v1 }), newFiles: files({ [A]: v1 }), localFiles: files({ [A]: "old rules output\n" }), rederive: true });
		expect(r.outcomes).toEqual([{ rel: A, outcome: "updated" }]);
		expect(r.errors).toEqual([]);
	});

	test("deletes a clean file that upstream deleted, refuses an edited one", () => {
		const clean = run({ oldFiles: files({ [A]: v1 }), localFiles: files({ [A]: derive(A, v1, rules) }) });
		expect(clean.outcomes).toEqual([{ rel: A, outcome: "deleted" }]);
		expect(clean.writes.get(A)).toBeNull();
		const edited = run({ oldFiles: files({ [A]: v1 }), localFiles: files({ [A]: "edited\n" }) });
		expect(edited.errors.join()).toContain("upstream deleted it");
	});

	test("a Cursor-ism that survives the rules fails the run", () => {
		const r = run({ newFiles: files({ [A]: "---\nname: a\ndescription: d\n---\n\nsee .cursor/rules\n" }) });
		expect(r.errors.join()).toContain(".cursor/");
	});
});

describe("isExcluded", () => {
	test("directories match by prefix, files exactly", () => {
		const exclude = ["assets/", "README.md"];
		expect(isExcluded("assets/logo.png", exclude)).toBe(true);
		expect(isExcluded("README.md", exclude)).toBe(true);
		expect(isExcluded("skills/README.md", exclude)).toBe(false);
	});
});

describe("parityReport", () => {
	test("is empty for identical trees and names the changed file otherwise", () => {
		expect(parityReport(files({ [A]: v1 }), files({ [A]: v1 }))).toBe("");
		const report = parityReport(files({ [A]: v1 }), files({ [A]: v2 }));
		expect(report).toContain("a/upstream/agents/a.md");
		expect(report).toContain("+version two");
	});
});

describe("the committed tree", () => {
	// Fetches the pinned upstream commit (cached under .cache/), so it needs
	// network on a cold cache.
	test("matches derive(upstream@pin) and docs/parity.diff is current", () => {
		const out = spawnSync(process.execPath, ["tools/sync.mjs", "--check"], { cwd: repo, encoding: "utf8" });
		expect(out.stderr).toBe("");
		expect(out.status).toBe(0);
	}, 120_000);
});
