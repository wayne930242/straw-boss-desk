import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADMINISTRATORS_SID, groupSids, HIGH_MANDATORY_SID, isElevatedToken } from "./harness/elevation.ts";

const row = (name: string, sid: string, attrs = "Mandatory group, Enabled by default, Enabled group") => `"${name}","Well-known group","${sid}","${attrs}"`;
const elevated = [row("Everyone", "S-1-1-0"), row("BUILTIN\\Administrators", ADMINISTRATORS_SID, "Mandatory group, Enabled by default, Enabled group, Group owner"), row("Mandatory Label\\High Mandatory Level", HIGH_MANDATORY_SID)].join("\r\n");
const filtered = [row("Everyone", "S-1-1-0"), row("BUILTIN\\Administrators", ADMINISTRATORS_SID, "Group used for deny only"), row("Mandatory Label\\Medium Mandatory Level", "S-1-16-8192")].join("\r\n");

describe("the elevation check of the hosted Windows suites (S53-F004)", () => {
	it("reads the SIDs of whoami's csv, whatever the language of the names", () => {
		assert.deepEqual(groupSids(elevated), ["S-1-1-0", ADMINISTRATORS_SID, HIGH_MANDATORY_SID]);
		assert.deepEqual(groupSids(row("強制標籤\\高強制層級", HIGH_MANDATORY_SID, "必要群組")), [HIGH_MANDATORY_SID]);
	});

	it("accepts a full administrator token", () => {
		assert.equal(isElevatedToken(elevated), true);
	});

	it("refuses a UAC-filtered administrator token, a standard user, and an empty answer", () => {
		assert.equal(isElevatedToken(filtered), false);
		assert.equal(isElevatedToken([row("Everyone", "S-1-1-0"), row("Mandatory Label\\Medium Mandatory Level", "S-1-16-8192")].join("\n")), false);
		assert.equal(isElevatedToken(""), false);
		assert.equal(isElevatedToken(row("x", HIGH_MANDATORY_SID)), false, "the label without the Administrators group is not enough");
	});
});
