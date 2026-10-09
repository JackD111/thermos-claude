// Pass predicate for the live Claude Code thermos run.
//   bun check-claude-run.mjs <stream-json transcript> <session transcript dir>
// stream-json emits one event per content block, so tool calls are grouped by
// message id. Background subagents write their own transcripts under
// <session dir>/subagents/, with a .meta.json naming the agent type.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const lines = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const events = lines(process.argv[2]);
const sessionDir = process.argv[3];
const toolUses = (e) => (e.message?.content ?? []).filter((c) => c.type === "tool_use");

const byMessage = new Map();
for (const e of events.filter((e) => e.type === "assistant" && !e.parent_tool_use_id)) {
	byMessage.set(e.message.id, [...(byMessage.get(e.message.id) ?? []), ...toolUses(e)]);
}
const want = ["thermos:thermo-nuclear-review-subagent", "thermos:thermo-nuclear-code-quality-review-subagent"];
const launch = [...byMessage.values()].find((uses) => want.every((t) => uses.some((u) => u.name === "Agent" && u.input?.subagent_type === t)));
const launched = (launch ?? []).filter((u) => u.name === "Agent" && want.includes(u.input?.subagent_type));

const subagents = {};
const dir = join(sessionDir, "subagents");
for (const f of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".meta.json")) : []) {
	const meta = JSON.parse(readFileSync(join(dir, f), "utf8"));
	const transcript = lines(join(dir, f.replace(".meta.json", ".jsonl")));
	const skills = transcript.filter((e) => e.type === "assistant").flatMap((e) => toolUses(e).filter((u) => u.name === "Skill").map((u) => ({ id: u.id, skill: u.input?.skill })));
	const results = transcript.filter((e) => e.type === "user").flatMap((e) => [].concat(e.message?.content ?? []).filter((c) => c.type === "tool_result"));
	subagents[meta.agentType] = skills.map((s) => ({ ...s, ok: results.some((r) => r.tool_use_id === s.id && !r.is_error) }));
}
const loaded = (agent, skill) => (subagents[agent] ?? []).some((s) => s.skill === skill && s.ok);

const text = events.findLast((e) => e.type === "result")?.result ?? "";
const checks = {
	"one message launches both namespaced reviewers": Boolean(launch),
	"both launched with run_in_background": launched.length === 2 && launched.every((u) => u.input?.run_in_background === true),
	"review subagent loads thermos:thermo-nuclear-review": loaded(want[0], "thermos:thermo-nuclear-review"),
	"quality subagent loads thermos:thermo-nuclear-code-quality-review": loaded(want[1], "thermos:thermo-nuclear-code-quality-review"),
	"verdict reports the SQL injection": /sql injection|sql-injection/i.test(text),
	"verdict flags report.py size (1k-line rule)": /report\.py/.test(text) && /1[,.]?\d{3}|1k/i.test(text),
};
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
console.log("subagent skill calls:", JSON.stringify(subagents));
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
