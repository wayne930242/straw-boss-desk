import assert from "node:assert/strict";
import { once } from "node:events";
import tls from "node:tls";
import { describe, it } from "node:test";
import { createTestCa } from "./harness/test-ca.ts";

// The throw-away CA of the TLS checks (task 6) is built in memory: this proves the chain and that a TLS client trusts it only when told to.

describe("the test CA", () => {
	const ca = createTestCa("unit");

	it("issues a server certificate for 127.0.0.1 and localhost that verifies under the CA, and marks the CA as one", () => {
		assert.ok(ca.server.cert.verify(ca.ca.publicKey));
		assert.equal(ca.server.cert.checkIP("127.0.0.1"), "127.0.0.1");
		assert.equal(ca.server.cert.checkHost("localhost"), "localhost");
		assert.equal(ca.ca.ca, true);
		assert.equal(ca.server.cert.ca, false);
		assert.equal(ca.ca.subject, `CN=${ca.commonName}`);
		assert.ok(ca.server.cert.issuer.includes(ca.commonName));
		assert.ok(ca.caDer.length > 200 && ca.caDer[0] === 0x30);
	});

	it("is trusted by a TLS client that is given the CA, and refused by one that is not", async () => {
		const server = tls.createServer({ cert: ca.server.certPem, key: ca.server.keyPem }, (socket) => socket.end("hello"));
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const port = (server.address() as { port: number }).port;
		try {
			const trusting = tls.connect({ host: "127.0.0.1", port, ca: ca.caPem, servername: "localhost" });
			await once(trusting, "secureConnect");
			assert.equal(trusting.authorized, true);
			trusting.destroy();
			const plain = tls.connect({ host: "127.0.0.1", port, servername: "localhost" });
			const [error] = (await once(plain, "error")) as [NodeJS.ErrnoException];
			assert.match(error.code ?? "", /SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/);
		} finally {
			server.close();
		}
	});

	it("makes a different CA every time", () => {
		assert.notEqual(createTestCa("unit").commonName, ca.commonName);
	});
});
