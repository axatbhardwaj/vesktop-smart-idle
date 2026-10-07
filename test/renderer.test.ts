import assert from "node:assert/strict";
import { test } from "node:test";
import { observe, startRenderer } from "../src/smartIdle.vesktop/renderer.ts";

const state = () => ({ connected: true, muted: false, deaf: false, camera: false, sharing: false, stream: null as object | null });
function stores(s: ReturnType<typeof state>) {
    return {
        SelectedChannelStore: { getVoiceChannelId: () => s.connected ? "voice" : null },
        MediaEngineStore: { isSelfMute: () => s.muted, isSelfDeaf: () => s.deaf, isVideoEnabled: () => s.camera, isScreenSharing: () => s.sharing },
        ApplicationStreamingStore: { getCurrentUserActiveStream: () => s.stream }
    };
}
const dom = (videos: any[] = [], frames: any[] = []) => ({ querySelectorAll: (tag: string) => tag === "video" ? videos : frames });
const flush = () => new Promise(resolve => setImmediate(resolve));

test("enabling SmartIdle sends voice protection, reconciles mute, and disabling sends stop", async () => {
    const s = state();
    const messages: any[] = [];
    let tick = () => {};
    let cleared = false;
    const stop = startRenderer(() => observe(stores(s), dom()), async m => { messages.push(m); return { ok: true }; }, assert.fail,
        { setInterval: (fn: () => void) => { tick = fn; return 1; }, clearInterval: () => { cleared = true; } } as any);
    await flush();
    assert.deepEqual(messages, [{ keep: true }]);
    s.muted = true;
    tick();
    await flush();
    assert.deepEqual(messages.at(-1), { keep: false });
    stop();
    await flush();
    assert.deepEqual(messages.at(-1), { stop: true });
    assert.equal(cleared, true);
    tick();
    await flush();
    assert.equal(messages.length, 3);
});

test("policy covers every voice/media combination; playing muted video wins", () => {
    for (let bits = 0; bits < 64; bits++) {
        const [connected, muted, deaf, camera, sharing, video] = Array.from({ length: 6 }, (_, n) => Boolean(bits & (1 << n)));
        const s = { connected, muted, deaf, camera, sharing, stream: null };
        const doc = dom(video ? [{ paused: false, ended: false, muted: true }] : []);
        assert.equal(observe(stores(s), doc).keep, camera || sharing || video || (connected && !muted && !deaf), `state ${bits}`);
    }
    const s = state(); s.muted = true; s.stream = {};
    assert.equal(observe(stores(s), dom()).keep, true);
});

test("DOM playback transitions and ambiguous frames protect without remote stream inference", () => {
    const s = state(); s.connected = false;
    const v = { paused: true, ended: false, muted: true };
    const videos = [v]; const frames: any[] = [];
    const doc = dom(videos, frames);
    assert.equal(observe(stores(s), doc).keep, false);
    v.paused = false;
    assert.equal(observe(stores(s), doc).keep, true);
    v.ended = true;
    assert.equal(observe(stores(s), doc).keep, false);
    videos.pop(); frames.push({});
    assert.deepEqual(observe(stores(s), doc), { keep: true, uncertain: true });
    frames.pop();
    const st = stores(s);
    (st.ApplicationStreamingStore as any).getAllActiveStreams = () => { throw Error("must never enumerate remote streams"); };
    assert.equal(observe(st, doc).keep, false);
});

test("missing, throwing, and malformed getters remain unknown and keep awake", () => {
    const s = state(); s.connected = false;
    for (const bad of [undefined, () => { throw Error("drift"); }, () => "false"]) {
        const st = stores(s); (st.MediaEngineStore as any).isSelfMute = bad;
        assert.deepEqual(observe(st, dom()), { keep: true, uncertain: true });
    }
    assert.deepEqual(observe(undefined, dom()), { keep: true, uncertain: true });
});


test("distinct degraded conditions are visible once each; disable follows a rejected in-flight IPC", async () => {
    let resolve!: (value: any) => void;
    let reject!: (error: Error) => void;
    let tick = () => {};
    const warnings: string[] = []; const messages: any[] = [];
    let sends = 0;
    const stop = startRenderer(() => ({ keep: true, uncertain: true }), message => {
        messages.push(message); sends++;
        if (sends === 1) return Promise.resolve({ ok: false, error: "Unsupported XWayland" });
        return new Promise((res, rej) => { resolve = res; reject = rej; });
    }, reason => warnings.push(reason), { setInterval: (fn: () => void) => { tick = fn; return 1; }, clearInterval() {} });
    await flush();
    assert.equal(warnings.length, 2);
    tick(); await flush(); stop(); reject(Error("IPC gone")); await flush();
    assert.deepEqual(messages.at(-1), { stop: true });
    resolve({ ok: true }); await flush();
    assert.equal(warnings.filter(w => w.includes("Unknown")).length, 1);
});
