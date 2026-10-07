import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../scripts/build.mjs", import.meta.url).pathname;
test("builder refuses existing directories and leaves user files intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "smart-idle-build-test-"));
    const file = join(dir, "user-file"); writeFileSync(file, "preserve");
    try {
        const result = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
        assert.notEqual(result.status, 0, "must refuse to overwrite an existing checkout");
        assert.equal(readFileSync(file, "utf8"), "preserve");
        assert.deepEqual(readdirSync(dir), ["user-file"]);
    } finally { unlinkSync(file); rmdirSync(dir); }
});
test("builder requires an explicit absolute fresh checkout path", () => {
    for (const args of [[], ["relative-checkout"]]) {
        const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /absolute.*new/i);
    }
});
