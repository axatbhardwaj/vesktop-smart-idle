import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Host adapters only: exercise the real entry point, observations, native IPC, and controller.
const sender = Object.assign(new EventEmitter(), {
    mainFrame: { url: "https://discord.com/app", name: "", parent: null }, isDestroyed: () => false
});
const window = { webContents: sender, isDestroyed: () => false };
const client = { pid: process.pid, class: "vesktop", xwayland: true, address: "0xbeef", inhibitingIdle: false };
let muted = false;
const warnings: any[] = []; const invocations: any[] = [];
const fixture = {
    BrowserWindow: { fromWebContents: (s: any) => s === sender ? window : null, getAllWindows: () => [window] },
    stores: {
        SelectedChannelStore: { getVoiceChannelId: () => "voice" },
        MediaEngineStore: { isSelfMute: () => muted, isSelfDeaf: () => false, isVideoEnabled: () => false, isScreenSharing: () => false },
        ApplicationStreamingStore: { getCurrentUserActiveStream: () => null }
    },
    execFile: (file: string, args: string[], options: any, cb: (err: null, result: string) => void) => {
        invocations.push({ file, args, options });
        if (args[0] === "dispatch") client.inhibitingIdle = args[1].includes('value="1"');
        queueMicrotask(() => cb(null, args[0] === "-j" ? JSON.stringify([client]) : "ok"));
    }, warnings
};
(globalThis as any).__smartIdleFixture = fixture;
(globalThis as any).document = { querySelectorAll: () => [] };
const hooks = registerHooks({ resolve(specifier, context, next) {
    const replacements: Record<string, string> = {
        electron: "export const BrowserWindow = globalThis.__smartIdleFixture.BrowserWindow;",
        "node:child_process": "export const execFile = globalThis.__smartIdleFixture.execFile;",
        "@utils/types": "export default function definePlugin(plugin) { return plugin; }",
        "@webpack/common": "export const {SelectedChannelStore, MediaEngineStore, ApplicationStreamingStore} = globalThis.__smartIdleFixture.stores;",
        "@api/Notifications": "export function showNotification(notice) { globalThis.__smartIdleFixture.warnings.push(notice); }"
    };
    if (specifier in replacements) return { url: "data:text/javascript," + encodeURIComponent(replacements[specifier]), shortCircuit: true };
    return next(specifier, context);
} });
const native = await import("../src/smartIdle.vesktop/native.ts");
(globalThis as any).VencordNative = { pluginHelpers: { SmartIdle: { update: (m: unknown) => native.update({ sender, senderFrame: sender.mainFrame } as any, m) } } };
const { default: plugin } = await import("../src/smartIdle.vesktop/index.ts");
const settle = () => new Promise(resolve => setTimeout(resolve, 15));

test("built-in plugin lifecycle reaches bounded native commands with no import-time work", async () => {
    const prior = process.env.HYPRLAND_INSTANCE_SIGNATURE;
    process.env.HYPRLAND_INSTANCE_SIGNATURE = "isolated-test";
    assert.equal(invocations.length, 0);
    try {
        plugin.start!(); await settle();
        assert.equal(client.inhibitingIdle, true);
        muted = true;
        await new Promise(resolve => setTimeout(resolve, 2050));
        assert.equal(client.inhibitingIdle, false);
        plugin.stop!(); await settle();
        for (const { file, args, options } of invocations) {
            assert.equal(file, "hyprctl"); assert.equal(options.shell, false);
            assert.equal(options.timeout, 1000); assert.equal(options.maxBuffer, 1024 * 1024);
            if (args[0] === "dispatch") assert.equal(args.length, 2);
        }
        assert.equal(invocations.filter(c => c.args[0] === "dispatch").length, 3);
        assert.deepEqual(warnings, []);
    } finally {
        plugin.stop!(); hooks.deregister();
        if (prior === undefined) delete process.env.HYPRLAND_INSTANCE_SIGNATURE; else process.env.HYPRLAND_INSTANCE_SIGNATURE = prior;
    }
});
