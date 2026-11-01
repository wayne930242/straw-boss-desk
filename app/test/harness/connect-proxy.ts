import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

// Test code: a CONNECT proxy on 127.0.0.1 that tunnels to the requested host and records what was asked for (task 3's proof that a child goes through
// the proxy the OS setting names, reused by task 6 for the `pi` stage's npm).
export interface ConnectProxy {
	port: number;
	/** Each CONNECT target seen, `host:port`, in order. */
	connects: string[];
	/** Each plain-HTTP request seen, as the absolute URL the client sent (a forward proxy gets those instead of a CONNECT). */
	requests: string[];
	close(): Promise<void>;
}

export interface ConnectProxyOptions {
	/** Host names the proxy resolves itself, to the address they stand for (`registry.sbd.test` to `127.0.0.1`): a name that is not on `NO_PROXY`'s loopback list. */
	hostMap?: Readonly<Record<string, string>>;
}

export async function connectProxy(options: ConnectProxyOptions = {}): Promise<ConnectProxy> {
	const connects: string[] = [];
	const requests: string[] = [];
	const sockets = new Set<Duplex>();
	const mapped = (host: string): string => options.hostMap?.[host] ?? host;
	const server = http.createServer((req, res) => {
		// A plain-HTTP request through a forward proxy carries an absolute URL.
		if (!/^http:\/\//.test(req.url ?? "")) {
			res.writeHead(405).end();
			return;
		}
		requests.push(req.url ?? "");
		const target = new URL(req.url ?? "");
		const upstream = http.request({ host: mapped(target.hostname), port: target.port, path: `${target.pathname}${target.search}`, method: req.method, headers: { ...req.headers, host: target.host } }, (answer) => {
			res.writeHead(answer.statusCode ?? 502, answer.headers);
			answer.pipe(res);
		});
		upstream.on("error", () => res.writeHead(502).end());
		req.pipe(upstream);
	});
	server.on("connect", (req, client, head) => {
		connects.push(req.url ?? "");
		const [host, port] = (req.url ?? "").split(":");
		const upstream = net.connect(Number(port), mapped(host ?? ""), () => {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			upstream.write(head);
			upstream.pipe(client);
			client.pipe(upstream);
		});
		for (const s of [client, upstream]) {
			sockets.add(s);
			s.on("close", () => sockets.delete(s));
			s.on("error", () => s.destroy());
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		port: (server.address() as net.AddressInfo).port,
		connects,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				for (const s of sockets) s.destroy();
				server.close(() => resolve());
			}),
	};
}
