import net from "node:net";
import { connectProxy } from "./connect-proxy.ts";

// Test code: does a client read `no_proxy`, `NO_PROXY`, or both? (T3-F007.) A TCP target on 127.0.0.1 counts the connections it accepts and drops them;
// a CONNECT proxy records the targets it is asked for. A client given the proxy variables and a target on the loopback address either asks the proxy
// for it (it did not honour the bypass list) or connects to the target itself (it did). The TLS handshake that follows fails either way; only the route is read.

export type Variant = "none" | "lower" | "upper" | "both";
export const VARIANTS: readonly Variant[] = ["none", "lower", "upper", "both"];

export interface Route {
	/** CONNECTs the proxy got for the target. */
	proxied: number;
	/** Connections that reached the target without the proxy. */
	direct: number;
}

/** The proxy and bypass variables of a variant: the constructed environment's `HTTPS_PROXY` and `HTTP_PROXY`, and `127.0.0.1` in the bypass list as the name(s) the variant says. */
export function proxyVariables(variant: Variant, proxyPort: number): Record<string, string> {
	const env: Record<string, string> = { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, HTTP_PROXY: `http://127.0.0.1:${proxyPort}` };
	if (variant === "lower" || variant === "both") env.no_proxy = "127.0.0.1";
	if (variant === "upper" || variant === "both") env.NO_PROXY = "127.0.0.1";
	return env;
}

export interface ProbeContext {
	/** `https://127.0.0.1:<port>/`, a target nobody answers TLS on. */
	url: string;
	port: number;
	/** The proxy and bypass variables of the variant being probed. */
	env: Record<string, string>;
}

/**
 * Runs `client` once for each variant and reports the route its connection took. `client` must try to reach `context.url` and return when it has given
 * up or been killed; it should fail fast (no retries).
 */
export async function probeNoProxy(client: (context: ProbeContext) => Promise<void>): Promise<Record<Variant, Route>> {
	let accepted = 0;
	const sockets = new Set<net.Socket>();
	const target = net.createServer((socket) => {
		accepted++;
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		socket.destroy();
	});
	await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
	const port = (target.address() as net.AddressInfo).port;
	const proxy = await connectProxy();
	const result = {} as Record<Variant, Route>;
	try {
		for (const variant of VARIANTS) {
			accepted = 0;
			proxy.connects.length = 0;
			await client({ url: `https://127.0.0.1:${port}/`, port, env: proxyVariables(variant, proxy.port) });
			const proxied = proxy.connects.filter((c) => c === `127.0.0.1:${port}`).length;
			result[variant] = { proxied, direct: Math.max(0, accepted - proxied) };
		}
	} finally {
		await proxy.close();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => target.close(() => resolve()));
	}
	return result;
}

/** `bypassed` when the client went to the target without the proxy, `proxied` when it asked the proxy, `neither` when it never connected. */
export const routeOf = (route: Route): "bypassed" | "proxied" | "neither" => (route.proxied > 0 ? "proxied" : route.direct > 0 ? "bypassed" : "neither");
