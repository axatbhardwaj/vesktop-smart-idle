// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const pin = "3374b8a9d8f6b051c64204917360293aad7f5d75";
const target = process.argv[2];
if (!target || !isAbsolute(target) || process.argv.length !== 3) {
    console.error("Usage: npm run build -- /absolute/path/to/new-checkout (parent must exist)");
    process.exit(1);
}
function run(file, args, cwd, capture = false) {
    const result = spawnSync(file, args, { cwd, stdio: capture ? "pipe" : "inherit", encoding: "utf8", shell: false });
    if (result.error || result.status !== 0) throw Error(`${file} failed; checkout retained for inspection.`);
    return result.stdout?.trim();
}
try {
    if (realpathSync(dirname(target)) !== dirname(target)) throw Error("Checkout parent must be a real path, without symlink aliases.");
    mkdirSync(target); // Exclusive creation: never overwrite a user's checkout.
    const source = process.env.VENCORD_SOURCE ?? "https://github.com/Vendicated/Vencord.git";
    run("git", ["clone", "--no-hardlinks", "--no-checkout", "--", source, target]);
    run("git", ["checkout", "--detach", pin], target);
    if (run("git", ["rev-parse", "HEAD"], target, true) !== pin) throw Error("Upstream revision mismatch.");
    const plugin = fileURLToPath(new URL("../src/smartIdle.vesktop", import.meta.url));
    const destination = join(target, "src", "userplugins", basename(plugin));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(plugin, destination, { recursive: true, errorOnExist: true, force: false });
    const pnpm = ["--yes", "pnpm@11.9.0"];
    run("npx", [...pnpm, "install", "--frozen-lockfile"], target);
    run("npx", [...pnpm, "build"], target);
    for (const name of ["vencordDesktopMain.js", "vencordDesktopPreload.js", "vencordDesktopRenderer.js", "vencordDesktopRenderer.css"]) {
        if (statSync(join(target, "dist", name)).size === 0) throw Error(`Empty artifact: ${name}`);
    }
    console.log(`Built Vencord ${pin}. Select ${join(target, "dist")} in Vesktop's Vencord Location picker.`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
