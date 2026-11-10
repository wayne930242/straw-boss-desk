import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { CHILD_MARKER, CHILD_NAME, LOOKUP_COMMAND, modelsJson, reply, RESULT_PREFIX, startStubModel, SUBAGENT_MARKER, textOf, type StubModel } from "./harness/stub-model.ts";

// The scripted stub model of the task 8b anchor (test code): which marker gives which answer, and that the server speaks the streaming chat-completions format a pi reads.
const open: StubModel[] = [];
after(async () => {
	for (const s of open) await s.close();
});

describe("the scripted answers", () => {
	it("answers the subagent marker with one subagent call whose task carries the child's marker", () => {
		const r = reply([{ role: "user", content: `please ${SUBAGENT_MARKER}` }]);
		assert.equal(r.kind, "tool");
		if (r.kind !== "tool") return;
		assert.equal(r.name, "subagent");
		assert.equal(r.args.name, CHILD_NAME);
		assert.ok(String(r.args.task).includes(CHILD_MARKER));
		assert.equal(r.args.model, "stub/stub-1", "the child does not take the profile's default model");
		assert.equal(r.args.agent, "scout", "a scout, which pi-straw-boss's plan gate never holds");
	});

	it("answers the child's marker with the bash lookup, and a tool result with the final text that echoes it", () => {
		assert.deepEqual(reply([{ role: "user", content: [{ type: "text", text: `@file ${CHILD_MARKER}` }] }]), { kind: "tool", name: "bash", args: { command: LOOKUP_COMMAND } });
		assert.deepEqual(reply([{ role: "user", content: CHILD_MARKER }, { role: "assistant", content: "" }, { role: "tool", content: "gh=/x/gh" }]), { kind: "text", text: `${RESULT_PREFIX}\ngh=/x/gh` });
	});

	it("looks only at the last message, so an old marker never repeats a call, and anything else is plain", () => {
		assert.deepEqual(reply([{ role: "user", content: SUBAGENT_MARKER }, { role: "assistant", content: "ok" }, { role: "user", content: `Sub-agent "${CHILD_NAME}" completed.` }]), { kind: "text", text: "Stub model: ready." });
		assert.deepEqual(reply([]), { kind: "text", text: "Stub model: ready." });
		assert.equal(textOf(undefined), "");
	});

	it("writes a lookup that prints name=path for the four programs", () => {
		for (const name of ["gh", "git", "pi", "bash"]) assert.ok(LOOKUP_COMMAND.includes(name));
		assert.ok(LOOKUP_COMMAND.includes("command -v"));
		assert.equal(JSON.parse(modelsJson("http://127.0.0.1:1/v1")).providers.stub.models[0].id, "stub-1");
	});
});

describe("the server", () => {
	it("streams a text answer and a tool call in the chat-completions format, and records the last message", async () => {
		const stub = await startStubModel();
		open.push(stub);
		const ask = async (messages: unknown[]): Promise<string> => (await fetch(`${stub.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "stub-1", stream: true, messages }) })).text();
		const text = await ask([{ role: "user", content: "hi" }]);
		assert.match(text, /Stub model: ready\./);
		assert.match(text, /"finish_reason":"stop"/);
		assert.ok(text.trimEnd().endsWith("data: [DONE]"));
		const tool = await ask([{ role: "user", content: SUBAGENT_MARKER }]);
		const deltas = [...tool.matchAll(/^data: (\{.*\})$/gm)].map((m) => JSON.parse(m[1] ?? "{}") as { choices: Array<{ delta?: { tool_calls?: Array<{ function: { name: string; arguments: string } }> }; finish_reason?: string | null }> });
		const call = deltas.flatMap((d) => d.choices.flatMap((c) => c.delta?.tool_calls ?? []))[0];
		assert.equal(call?.function.name, "subagent");
		assert.equal(JSON.parse(call?.function.arguments ?? "{}").name, CHILD_NAME);
		assert.ok(deltas.some((d) => d.choices.some((c) => c.finish_reason === "tool_calls")));
		assert.deepEqual(stub.requests.map((r) => r.role), ["user", "user"]);
		assert.equal((await fetch(`${stub.baseUrl}/models`)).status, 404);
	});
});
