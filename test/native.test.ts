import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createController } from "../src/smartIdle.vesktop/controller.ts";

function fixture() {
    const sender = Object.assign(new EventEmitter(), {
        mainFrame: { url: "https://discord.com/channels/@me", name: "", parent: null },
        isDestroyed: () => false
    });
    const win = { webContents: sender, isDestroyed: () => false };
    const event = { sender, senderFrame: sender.mainFrame };
    const client = { pid: 77, class: "vesktop", xwayland: true, address: "0xabc", inhibitingIdle: false };
    const calls: string[][] = []; const warnings: string[] = [];
    let clients = [client]; let windows = [win]; let now = 0; let tick = () => {};
    let timers = 0;
    let effective = true; let fail = false; let gate: Promise<void> | undefined;
    const host = {
        warn: (reason: string) => { warnings.push(reason); }, pid: 77, available: () => true, now: () => now,
        windows: () => windows, fromWebContents: (s: any) => windows.find(w => w.webContents === s),
        setInterval: (fn: () => void) => { tick = fn; timers++; return 1; }, clearInterval: () => { tick = () => {}; timers--; },
        run: async (args: string[]) => {
            calls.push(args);
            if (gate) await gate;
            if (fail) throw Error("ETIMEDOUT private details");
            if (args[0] === "-j") return JSON.stringify(clients);
            if (effective) client.inhibitingIdle = args[1].includes('value="1"');
            return "ok";
        }
    };
    const control = createController(host);
    return { control, event, sender, client, calls, warnings, host,
        timers: () => timers, setClients: (v: any[]) => { clients = v; }, setWindows: (v: any[]) => { windows = v; },
        setFailure: (v: boolean) => { fail = v; }, setEffective: (v: boolean) => { effective = v; },
        setGate: (v?: Promise<void>) => { gate = v; }, expire: () => { now = 7000; tick(); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const dispatches = (f: ReturnType<typeof fixture>) => f.calls.filter(a => a[0] === "dispatch");

test("authenticated main renderer controls only the owned client and verifies readback", async () => {
    const f = fixture();
    assert.equal((await f.control.update(f.event, { keep: true })).ok, true);
    assert.equal(f.client.inhibitingIdle, true);
    assert.deepEqual(dispatches(f), [["dispatch", 'hl.dsp.window.set_prop({window="address:0xabc", prop="idle_inhibit", value="1"})']]);
    assert.equal((await f.control.update(f.event, { stop: true })).ok, true);
    assert.equal(f.client.inhibitingIdle, false);
    assert.equal(dispatches(f).at(-1)?.[1], 'hl.dsp.window.set_prop({window="address:0xabc", prop="idle_inhibit", value="0"})');
});

test("schema, origin, frame, BrowserWindow, and bound-renderer failures cannot mutate", async () => {
    const f = fixture();
    for (const message of [true, null, { keep: 1 }, { keep: true, pid: 77 }, { stop: false }, { keep: true, stop: true }]) {
        assert.equal((await f.control.update(f.event, message)).ok, false);
    }
    for (const url of ["https://discord.com.evil.test/app", "http://discord.com/app", "https://discord.com:444/app", "https://evil@discord.com/app"]) {
        f.sender.mainFrame.url = url;
        assert.equal((await f.control.update(f.event, { keep: true })).ok, false);
    }
    f.sender.mainFrame.url = "https://discord.com/app";
    assert.equal((await f.control.update({ ...f.event, senderFrame: { ...f.sender.mainFrame } }, { keep: true })).ok, false);
    f.setWindows([]);
    assert.equal((await f.control.update(f.event, { keep: true })).ok, false);
    f.setWindows([{ webContents: f.sender, isDestroyed: () => false }]);
    assert.equal((await f.control.update(f.event, { keep: true })).ok, true);
    const other = Object.assign(new EventEmitter(), { mainFrame: { ...f.sender.mainFrame, name: "popout" }, isDestroyed: () => false });
    f.setWindows([{ webContents: f.sender, isDestroyed: () => false }, { webContents: other, isDestroyed: () => false }]);
    assert.equal((await f.control.update({ sender: other, senderFrame: other.mainFrame }, { keep: true })).ok, false);
    await f.control.update(f.event, { stop: true });
    assert.equal(dispatches(f).length, 2);
});

test("unsupported, ambiguous, invalid address, and reused targets never receive a dispatch", async () => {
    for (const patch of [{ pid: 99 }, { class: "discord" }, { xwayland: false }, { address: '0xabc"evil' }]) {
        const f = fixture(); Object.assign(f.client, patch);
        assert.equal((await f.control.update(f.event, { keep: true })).ok, false);
        assert.deepEqual(dispatches(f), []);
    }
    const f = fixture(); f.setClients([f.client, { ...f.client, address: "0xdef" }]);
    assert.equal((await f.control.update(f.event, { keep: true })).ok, false);
    assert.deepEqual(dispatches(f), []);
    f.setClients([f.client]);
    await f.control.update(f.event, { keep: true });
    f.client.pid = 99;
    assert.equal((await f.control.update(f.event, { stop: true })).ok, false);
    assert.equal(dispatches(f).length, 1);
    const unavailable = fixture(); unavailable.host.available = () => false;
    assert.equal((await unavailable.control.update(unavailable.event, { keep: true })).ok, false);
    assert.equal(unavailable.calls.length, 0);
});

test("non-effective ok and command timeouts are visible; healthy heartbeat retries", async () => {
    const f = fixture(); f.setEffective(false);
    assert.equal((await f.control.update(f.event, { keep: true })).ok, false);
    f.setEffective(true); f.setFailure(true);
    const failed = await f.control.update(f.event, { keep: true });
    assert.equal(failed.ok, false);
    assert.equal(failed.error?.includes("private"), false);
    f.setFailure(false);
    assert.equal((await f.control.update(f.event, { keep: true })).ok, true);
    await f.control.update(f.event, { stop: true });
});

test("disable wins an in-flight update; stale lease and crash release only the owned property", async () => {
    for (const stop of ["disable", "expire", "crash"]) {
        const f = fixture(); let release!: () => void;
        f.setGate(new Promise(resolve => { release = resolve; }));
        const active = f.control.update(f.event, { keep: true });
        await settle();
        let disabled: Promise<any> | undefined;
        if (stop === "disable") disabled = f.control.update(f.event, { stop: true });
        if (stop === "expire") f.expire();
        if (stop === "crash") f.sender.emit("render-process-gone");
        f.setGate(); release();
        await active; await disabled; await settle();
        assert.equal(f.client.inhibitingIdle, false, stop);
        assert.equal(dispatches(f).some(a => a[1].includes('value="1"')), false, "stale work must not enable after discovery");
    }
    for (const stop of ["expire", "crash", "destroyed"]) {
        const f = fixture(); await f.control.update(f.event, { keep: true });
        if (stop === "expire") f.expire(); else f.sender.emit(stop === "crash" ? "render-process-gone" : "destroyed");
        await settle();
        assert.equal(f.client.inhibitingIdle, false, stop);
        assert.equal(dispatches(f).length, 2);
    }
});

test("popout uncertainty keeps the established main window awake, never controls popout", async () => {
    const f = fixture(); await f.control.update(f.event, { keep: false });
    const popup = { webContents: { mainFrame: { url: "https://discord.com/popout", name: "popup" }, isDestroyed: () => false }, isDestroyed: () => false };
    f.setWindows([{ webContents: f.sender, isDestroyed: () => false }, popup] as any);
    f.setClients([f.client, { ...f.client, address: "0xdef" }]);
    const result = await f.control.update(f.event, { keep: false });
    assert.equal(result.ok, true); assert.equal(result.uncertain, true);
    assert.equal(f.client.inhibitingIdle, true);
    assert.equal(dispatches(f).length, 1);
    await f.control.update(f.event, { stop: true });
});


test("expiry retires the lease timer even when initial control was unsupported", async () => {
    const f = fixture(); f.setClients([]);
    assert.equal((await f.control.update(f.event, { keep: true })).ok, false);
    assert.equal(f.timers(), 1);
    f.expire(); await settle();
    assert.equal(f.timers(), 0);
});

test("stop during dispatch drains the pending write before clearing; failed cleanup retries", async () => {
    const f = fixture(); const run = f.host.run; let unblock!: () => void;
    let blocked = false;
    const barrier = new Promise<void>(resolve => { unblock = resolve; });
    f.host.run = async args => {
        if (args[0] === "dispatch" && !blocked) { blocked = true; await barrier; }
        return run(args);
    };
    const enabled = f.control.update(f.event, { keep: true }); await settle();
    assert.equal(blocked, true);
    const disabled = f.control.update(f.event, { stop: true });
    unblock(); await enabled; await disabled;
    assert.equal(f.client.inhibitingIdle, false);
    assert.deepEqual(dispatches(f).map(a => a[1].match(/value="(\d)"/)![1]), ["1", "0"]);
    await f.control.update(f.event, { keep: true }); f.setFailure(true);
    assert.equal((await f.control.update(f.event, { stop: true })).ok, false);
    assert.equal(f.client.inhibitingIdle, true);
    f.setFailure(false); f.expire(); await settle();
    assert.equal(f.client.inhibitingIdle, false);
    assert.equal(f.timers(), 0);
});


test("crash cleanup failure warns without leaking command details, then retries", async () => {
    const f = fixture(); await f.control.update(f.event, { keep: true });
    f.setFailure(true); f.sender.emit("render-process-gone"); await settle();
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0], /failed|timed out/);
    assert.equal(f.warnings[0].includes("private"), false);
    f.setFailure(false); f.expire(); await settle();
    assert.equal(f.client.inhibitingIdle, false);
});
