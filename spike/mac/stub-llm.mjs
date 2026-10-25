// Local stand-in for a model endpoint (OpenAI chat-completions, streaming): answers every request with one short message.
// The spike needs pi sessions that complete a turn (so they persist a session file) without any model call leaving the machine.
import { createServer } from "node:http";

const port = Number(process.argv[2]);
if (!port) throw new Error("usage: stub-llm.mjs <port>");
createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
		const id = `chatcmpl-${Date.now()}`, created = Math.floor(Date.now() / 1000);
		const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "stub-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.write(chunk({ role: "assistant", content: "" }));
		res.write(chunk({ content: "Stub model: ready." }));
		res.write(chunk({}, "stop"));
		res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "stub-1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
}).listen(port, "127.0.0.1", () => console.log(`stub model on 127.0.0.1:${port}`));
