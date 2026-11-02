// Test code only; never shipped. The kit's stub model (spike/mac/stub-llm.mjs), an OpenAI-compatible chat-completions endpoint on 127.0.0.1 that CI can run a pi turn against (CI cannot
// sign in to Claude), with the scripted mode of the task 8b anchor (spec: Workflows, step 7): a marker in the last message makes it answer with a fixed tool call, so a parent pi
// dispatches one pi-herdr-agents subagent and the child runs `command -v` in its bash tool. It is configured by the harness (a `models.json` and the default model in the agent
// folder), never by the app.
//
//   [[stub:subagent]]   in the last message  -> a `subagent` tool call: a child named `e2e-child` whose task carries [[stub:child-bash]]
//   [[stub:child-bash]] in the last message  -> a `bash` tool call that prints where gh, git, pi and bash resolve
//   a tool result       as the last message  -> the final text `STUB-RESULT` and the tool's output, so the parent's steer message holds what the child saw
//   anything else                            -> "Stub model: ready."
import { createServer, type Server } from "node:http";

export const SUBAGENT_MARKER = "[[stub:subagent]]";
export const CHILD_MARKER = "[[stub:child-bash]]";
export const RESULT_PREFIX = "STUB-RESULT";
export const CHILD_NAME = "e2e-child";

/** Where each name resolves, one `name=path` line each, in the form the platform's bash prints (`cygpath -m` turns an MSYS path into `C:/...` where there is one). */
export const LOOKUP_COMMAND = 'for n in gh git pi bash; do p=$(command -v $n); printf "%s=%s\\n" "$n" "$(cygpath -m "$p" 2>/dev/null || printf %s "$p")"; done';

interface ChatMessage {
	role?: string;
	content?: unknown;
}

export type StubReply = { kind: "text"; text: string } | { kind: "tool"; name: string; args: Record<string, unknown> };

/** The text of a message whatever shape the client sent: a string, or a list of parts. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n");
	return "";
}

/** What the stub answers to a conversation: only the last message decides, so a marker earlier in the history never repeats a tool call. */
export function reply(messages: readonly ChatMessage[]): StubReply {
	const last = messages[messages.length - 1];
	const text = textOf(last?.content);
	if (last?.role === "tool") return { kind: "text", text: `${RESULT_PREFIX}\n${text}` };
	if (text.includes(CHILD_MARKER)) return { kind: "tool", name: "bash", args: { command: LOOKUP_COMMAND } };
	if (text.includes(SUBAGENT_MARKER)) {
		return { kind: "tool", name: "subagent", args: { name: CHILD_NAME, task: `${CHILD_MARKER} Print where gh, git, pi and bash resolve, then say what you saw.`, model: "stub/stub-1" } };
	}
	return { kind: "text", text: "Stub model: ready." };
}

export interface StubModel {
	port: number;
	/** The `baseUrl` of the provider in `models.json`. */
	baseUrl: string;
	/** Every conversation the stub answered, as the last message's role and text. */
	requests: Array<{ role: string; text: string }>;
	close(): Promise<void>;
}

/** The agent folder's `models.json`: the stub as a custom provider (the shape the kit's `01-install.sh` writes). */
export const modelsJson = (baseUrl: string): string => JSON.stringify({ providers: { stub: { baseUrl, api: "openai-completions", apiKey: "stub", models: [{ id: "stub-1" }] } } }, null, 2);

export async function startStubModel(): Promise<StubModel> {
	const requests: StubModel["requests"] = [];
	let calls = 0;
	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			let messages: ChatMessage[] = [];
			try {
				const parsed = JSON.parse(body) as { messages?: ChatMessage[] };
				messages = Array.isArray(parsed.messages) ? parsed.messages : [];
			} catch {
				// An unreadable body is answered like an empty conversation.
			}
			const last = messages[messages.length - 1];
			requests.push({ role: last?.role ?? "", text: textOf(last?.content).slice(0, 2000) });
			const answer = reply(messages);
			const id = `chatcmpl-${Date.now()}-${calls++}`;
			const created = Math.floor(Date.now() / 1000);
			const chunk = (delta: Record<string, unknown>, finish: string | null = null): string => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "stub-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.write(chunk({ role: "assistant", content: "" }));
			if (answer.kind === "text") {
				res.write(chunk({ content: answer.text }));
				res.write(chunk({}, "stop"));
			} else {
				res.write(chunk({ tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: answer.name, arguments: JSON.stringify(answer.args) } }] }));
				res.write(chunk({}, "tool_calls"));
			}
			res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "stub-1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const port = (server.address() as { port: number }).port;
	return {
		port,
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections?.();
			}),
	};
}
