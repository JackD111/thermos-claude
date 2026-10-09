import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { derive, loadRules, repo } from "../tools/derive.mjs";
import { isExcluded, isolatedGitEnv, main, parityReport, plan } from "../tools/sync.mjs";

// Tests here spawn git, which can stall for seconds on Windows runners.
setDefaultTimeout(30_000);

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

	test("an undeclared hand edit is an error", () => {
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

	test("--rederive keeps a declared fork", () => {
		const r = run({
			oldFiles: files({ [A]: v1 }),
			newFiles: files({ [A]: v1 }),
			localFiles: files({ [A]: "forked\n" }),
			forks: new Map([[A, fork]]),
			rederive: true,
		});
		expect(r.outcomes).toEqual([{ rel: A, outcome: "forked" }]);
		expect(r.writes.size).toBe(0);
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

// The CLI against a scratch port tree and a local two-commit upstream.
describe("main", () => {
	let dirs = [];
	afterEach(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		dirs = [];
	});
	const scratch = () => {
		const dir = mkdtempSync(join(tmpdir(), "thermos-sync-"));
		dirs.push(dir);
		return dir;
	};
	const git = (cwd, ...args) => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd }).toString().trim();
	const agent = (text) => `---\nname: a\ndescription: d\n---\n\n# A\n\n${text}\n`;

	// Upstream commit one has agents/a.md; commit two changes it to `second`.
	function setup({ second = "version two" } = {}) {
		const upstream = scratch();
		git(upstream, "init", "-q", "-b", "main");
		mkdirSync(join(upstream, "thermos/agents"), { recursive: true });
		writeFileSync(join(upstream, "thermos/agents/a.md"), agent("version one"));
		writeFileSync(join(upstream, "thermos/README.md"), "excluded\n");
		git(upstream, "add", "-A");
		git(upstream, "commit", "-q", "-m", "one");
		const one = git(upstream, "rev-parse", "HEAD");
		writeFileSync(join(upstream, "thermos/agents/a.md"), agent(second));
		git(upstream, "commit", "-q", "-am", "two");
		const two = git(upstream, "rev-parse", "HEAD");

		const root = scratch();
		mkdirSync(join(root, "tools"));
		cpSync(join(repo, "tools/substitutions.json"), join(root, "tools/substitutions.json"));
		writeFileSync(join(root, "tools/forks.json"), "{}\n");
		const spec = { remote: pathToFileURL(upstream).href, upstreamPath: "thermos", localPath: "plugins/thermos", sha: one, exclude: ["README.md"] };
		writeFileSync(join(root, "tools/upstream.json"), JSON.stringify(spec, null, "\t") + "\n");
		const cache = join(root, ".cache/upstream.git");
		const out = [];
		const opts = { root, cache, log: (m) => out.push(m), error: (m) => out.push(m) };
		expect(main([one], opts)).toBe(0);
		return { root, one, two, opts, out };
	}
	const snapshot = (root) =>
		["tools/upstream.json", "plugins/thermos/agents/a.md", "docs/parity.diff"].map((rel) => readFileSync(join(root, rel), "utf8"));

	test("a first sync writes the port, the parity report, and passes --check", ({ root, opts } = setup()) => {
		expect(readFileSync(join(root, "plugins/thermos/agents/a.md"), "utf8")).toBe(agent("version one"));
		expect(readFileSync(join(root, "docs/parity.diff"), "utf8")).toBe("");
		expect(main(["--check"], opts)).toBe(0);
	});

	test("a sync to a new sha updates the file, advances the pin, and rewrites the report", () => {
		const { root, two, opts } = setup();
		expect(main([two], opts)).toBe(0);
		expect(readFileSync(join(root, "plugins/thermos/agents/a.md"), "utf8")).toBe(agent("version two"));
		expect(JSON.parse(readFileSync(join(root, "tools/upstream.json"), "utf8")).sha).toBe(two);
		expect(main(["--check"], opts)).toBe(0);
	});

	test("a denylist hit writes nothing and keeps the pin", () => {
		const { root, two, opts, out } = setup({ second: "see .cursor/rules" });
		const before = snapshot(root);
		expect(main([two], opts)).toBe(1);
		expect(out.join("\n")).toContain(".cursor/");
		expect(snapshot(root)).toEqual(before);
	});

	test("an undeclared hand edit writes nothing and keeps the pin", () => {
		const { root, two, opts, out } = setup();
		writeFileSync(join(root, "plugins/thermos/agents/a.md"), agent("hand edit"));
		const before = snapshot(root);
		expect(main([two], opts)).toBe(1);
		expect(out.join("\n")).toContain("no forks.json entry");
		expect(snapshot(root)).toEqual(before);
	});

	test("--dry-run writes nothing", () => {
		const { root, two, opts } = setup();
		const before = snapshot(root);
		expect(main([two, "--dry-run"], opts)).toBe(0);
		expect(snapshot(root)).toEqual(before);
	});

	test("--check fails on a stale or missing parity report", () => {
		const { root, opts, out } = setup();
		writeFileSync(join(root, "docs/parity.diff"), "tampered\n");
		expect(main(["--check"], opts)).toBe(1);
		expect(out.join("\n")).toContain("parity.diff is stale");
		rmSync(join(root, "docs/parity.diff"));
		expect(main(["--check"], opts)).toBe(1);
		expect(out.join("\n")).toContain("parity.diff is missing");
	});

	test("--check fails when the port lacks an upstream file", () => {
		const { root, opts, out } = setup();
		rmSync(join(root, "plugins/thermos/agents/a.md"));
		expect(main(["--check"], opts)).toBe(1);
		expect(out.join("\n")).toContain("port lacks it");
	});
});

describe("isolatedGitEnv", () => {
	test("drops every git config override and the user's global config", () => {
		const env = isolatedGitEnv("/empty", { PATH: "p", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "diff.noprefix", GIT_CONFIG_VALUE_0: "true", GIT_CONFIG_PARAMETERS: "'diff.context'='9'" });
		expect(env.PATH).toBe("p");
		expect(env.GIT_CONFIG_GLOBAL).toBe("/empty");
		expect(Object.keys(env).filter((k) => k.startsWith("GIT_CONFIG")).sort()).toEqual(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]);
		expect(env.GIT_ATTR_NOSYSTEM).toBe("1");
	});

	test("the parity report ignores a global attributes file", () => {
		const files = (text) => new Map([["agents/a.md", text]]);
		const before = "# Head\n\none\ntwo\nthree\nfour\nfive\nsix\nseven\n";
		const after = before.replace("six", "SIX");
		const baseline = parityReport(files(before), files(after));
		const xdg = mkdtempSync(join(tmpdir(), "thermos-xdg-"));
		mkdirSync(join(xdg, "git"));
		const saved = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = xdg;
		try {
			for (const attributes of ["*.md diff=markdown\n", "* -diff\n"]) {
				writeFileSync(join(xdg, "git/attributes"), attributes);
				expect(parityReport(files(before), files(after))).toBe(baseline);
			}
		} finally {
			if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = saved;
			rmSync(xdg, { recursive: true, force: true });
		}
	});

	test("the parity report ignores diff settings in the environment", () => {
		const files = (text) => new Map([["agents/a.md", text]]);
		const baseline = parityReport(files("one\ntwo\n"), files("one\nthree\n"));
		const saved = { ...process.env };
		Object.assign(process.env, { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "diff.noprefix", GIT_CONFIG_VALUE_0: "true", GIT_CONFIG_KEY_1: "diff.context", GIT_CONFIG_VALUE_1: "9" });
		try {
			expect(parityReport(files("one\ntwo\n"), files("one\nthree\n"))).toBe(baseline);
		} finally {
			for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"]) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		}
	});
});
