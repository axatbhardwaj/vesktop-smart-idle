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

// Inert topology fixture: derives children and selector results from one tree.
function element(tagName: string, ...nodes: any[]): any {
    return { tagName, childNodes: nodes, get children() { return this.childNodes.filter((n: any) => n?.tagName); } };
}
function blankFrame(scripts = 0) {
    const style = { display: "block", visibility: "hidden" };
    const root = element("HTML", element("HEAD", ...Array.from({ length: scripts }, () => element("SCRIPT"))), element("BODY"));
    const child = {
        URL: "about:blank", documentElement: root,
        get head() { return root.children.find((n: any) => n.tagName === "HEAD") ?? null; },
        get body() { return root.children.find((n: any) => n.tagName === "BODY") ?? null; },
        querySelectorAll(selector: string) {
            const hits: any[] = [];
            const visit = (node: any) => { for (const n of node.children) { if (selector.split(",").includes(n.tagName.toLowerCase())) hits.push(n); visit(n); } };
            visit(root); return hits;
        }
    };
    const attributes = new Map<string, string>();
    const frame = {
        getAttribute: (name: string) => attributes.get(name) ?? null,
        getBoundingClientRect: () => ({ width: 1, height: 1 }),
        ownerDocument: { defaultView: { getComputedStyle: () => style } },
        contentDocument: child
    };
    return { frame, style, child, attributes, root };
}

test("hidden 1x1 accessible blank implementation frame allows idle without overriding voice or media", () => {
    const { frame } = blankFrame();
    const s = state(); s.connected = false; s.muted = true; s.deaf = true;
    const doc = dom([], [frame]);
    assert.deepEqual(observe(stores(s), doc), { keep: false, uncertain: false });
    s.connected = true;
    assert.deepEqual(observe(stores(s), doc), { keep: false, uncertain: false });
    s.muted = false; s.deaf = false;
    assert.equal(observe(stores(s), doc).keep, true);
    s.muted = true; s.camera = true;
    assert.equal(observe(stores(s), doc).keep, true);
    s.camera = false; s.sharing = true;
    assert.equal(observe(stores(s), doc).keep, true);
    s.sharing = false;
    assert.equal(observe(stores(s), dom([{ paused: false, ended: false, muted: true }], [frame])).keep, true);
});

test("only proven hidden blank frames are exempt; changes to media, navigation or visibility re-inhibit", () => {
    const s = state(); s.connected = false;
    const cases: Array<(f: ReturnType<typeof blankFrame>) => void> = [
        f => { f.style.visibility = "visible"; },
        f => { f.attributes.set("src", "https://video.example/embed"); },
        f => { f.attributes.set("src", ""); },
        f => { f.attributes.set("srcdoc", "<video autoplay></video>"); },
        f => { f.child.URL = "https://discord.com/media"; },
        f => { f.child.body.childNodes.push(element("VIDEO")); },
        f => { f.child.body.childNodes.push(element("AUDIO")); },
        f => { f.child.body.childNodes.push(element("IFRAME")); },
        f => { f.child.body.childNodes.push(element("OBJECT")); },
        f => { f.child.head.childNodes.push(element("STYLE")); },
        f => { f.root.childNodes.push(element("VIDEO")); }
    ];
    for (const change of cases) {
        const f = blankFrame(); const doc = dom([], [f.frame]);
        assert.deepEqual(observe(stores(s), doc), { keep: false, uncertain: false });
        change(f);
        assert.deepEqual(observe(stores(s), doc), { keep: true, uncertain: true });
    }
    const f = blankFrame(); f.style.display = "none"; f.style.visibility = "visible";
    assert.deepEqual(observe(stores(s), dom([], [f.frame])), { keep: false, uncertain: false });
    f.child.body.childNodes.push(element("VIDEO"));
    assert.deepEqual(observe(stores(s), dom([], [f.frame])), { keep: true, uncertain: true });
});

test("unreadable child documents, unavailable styles, and DOM failures conservatively protect", () => {
    const s = state(); s.connected = false;
    const cases: Array<(f: ReturnType<typeof blankFrame>) => void> = [
        f => { (f.frame as any).contentDocument = null; },
        f => { Object.defineProperty(f.frame, "contentDocument", { get() { throw Error("cross-origin"); } }); },
        f => { (f.frame.ownerDocument as any).defaultView = null; },
        f => { f.frame.ownerDocument.defaultView.getComputedStyle = () => { throw Error("style unavailable"); }; },
        f => { Object.defineProperty(f.child, "body", { value: null }); }
    ];
    for (const change of cases) {
        const f = blankFrame(); change(f);
        assert.deepEqual(observe(stores(s), dom([], [f.frame])), { keep: true, uncertain: true });
    }
    assert.deepEqual(observe(stores(s), { querySelectorAll() { throw Error("DOM unavailable"); } } as any), { keep: true, uncertain: true });
});


test("script-only hidden blank frames allow idle at every count and preserve all voice/media decisions", () => {
    for (const count of [0, 1, 2, 3]) {
        const f = blankFrame(count);
        // SCRIPT text is allowed, as are harmless root whitespace/comments.
        for (const script of f.child.head.children) script.childNodes.push({ nodeType: 3, textContent: "inert" });
        f.root.childNodes.push({ nodeType: 8 }, { nodeType: 3, textContent: " " });
        for (let bits = 0; bits < 64; bits++) {
            const [connected, muted, deaf, camera, sharing, video] = Array.from({ length: 6 }, (_, n) => Boolean(bits & (1 << n)));
            const s = { connected, muted, deaf, camera, sharing, stream: null };
            assert.deepEqual(observe(stores(s), dom(video ? [{ paused: false, ended: false, muted: true }] : [], [f.frame])),
                { keep: camera || sharing || video || (connected && !muted && !deaf), uncertain: false }, `scripts ${count}, state ${bits}`);
        }
        const s = state(); s.muted = true; s.stream = {};
        assert.deepEqual(observe(stores(s), dom([], [f.frame])), { keep: true, uncertain: false });
    }
});

test("script descendants, direct media and substituted roots never bypass frame protection", () => {
    const media = ["VIDEO", "AUDIO", "IFRAME", "OBJECT", "EMBED"];
    const changes: Array<[string, (f: ReturnType<typeof blankFrame>) => void]> = [];
    for (const tag of media) {
        for (const where of ["head", "body"] as const)
            changes.push([`${where} ${tag}`, f => f.child[where].childNodes.push(element(tag))]);
        changes.push([`SCRIPT>${tag}`, f => f.child.head.children[0].childNodes.push(element(tag))],
            [`root ${tag}`, f => f.root.childNodes.push(element(tag))],
            [`replace HEAD ${tag}`, f => { f.root.childNodes[0] = element(tag); }],
            [`replace BODY ${tag}`, f => { f.root.childNodes[1] = element(tag); }],
            [`replacement HEAD>SCRIPT>${tag}`, f => { f.root.childNodes[0] = element("HEAD", element("SCRIPT", element(tag))); }]);
    }
    changes.push(["SCRIPT>DIV>VIDEO", f => f.child.head.children[0].childNodes.push(element("DIV", element("VIDEO")))],
        ["SVG root", f => { f.root.tagName = "SVG"; }], ["reversed root", f => f.root.childNodes.reverse()],
        ["stale head", f => Object.defineProperty(f.child, "head", { value: element("HEAD") })],
        ["stale body", f => Object.defineProperty(f.child, "body", { value: element("BODY") })],
        ["head whitespace", f => f.child.head.childNodes.push({ nodeType: 3 })],
        ["body comment", f => f.child.body.childNodes.push({ nodeType: 8 })]);
    for (const [name, change] of changes) for (const connected of [false, true]) {
        const s = state(); s.connected = connected; s.muted = true;
        const f = blankFrame(2); const doc = dom([], [f.frame]);
        assert.deepEqual(observe(stores(s), doc), { keep: false, uncertain: false }, `${name} before`);
        change(f);
        assert.deepEqual(observe(stores(s), doc), { keep: true, uncertain: true }, name);
    }
});

test("script frames retain navigation, visibility and unavailable DOM guards", () => {
    const changes: Array<(f: ReturnType<typeof blankFrame>) => void> = [
        f => { f.style.visibility = "visible"; }, f => f.attributes.set("src", ""), f => f.attributes.set("srcdoc", ""),
        f => { f.child.URL = "https://example.invalid/"; },
        f => { (f.frame as any).contentDocument = null; },
        f => Object.defineProperty(f.frame, "contentDocument", { get() { throw Error("cross-origin"); } }),
        f => { (f.frame.ownerDocument as any).defaultView = null; },
        f => { f.frame.ownerDocument.defaultView.getComputedStyle = () => { throw Error("style"); }; },
        f => Object.defineProperty(f.child, "head", { value: null }), f => Object.defineProperty(f.child, "body", { value: null }),
        f => { (f.child as any).documentElement = null; },
        f => Object.defineProperty(f.child.head, "childNodes", { get() { throw Error("DOM gone"); } }),
        f => { f.child.querySelectorAll = () => { throw Error("query unavailable"); }; }
    ];
    for (const change of changes) {
        const f = blankFrame(2); const s = state(); s.connected = false; change(f);
        assert.deepEqual(observe(stores(s), dom([], [f.frame])), { keep: true, uncertain: true });
    }
    const f = blankFrame(2); f.style.display = "none"; f.style.visibility = "visible";
    const s = state(); s.muted = true;
    assert.deepEqual(observe(stores(s), dom([], [f.frame])), { keep: false, uncertain: false });
});

test("polling does not flap with scripts and re-inhibits for inserted media or navigation", async () => {
    for (const tag of ["VIDEO", "AUDIO", "IFRAME", "OBJECT", "EMBED"]) {
        const f = blankFrame(); const s = state(); s.muted = true;
        let tick = () => {}; const messages: any[] = [];
        const stop = startRenderer(() => observe(stores(s), dom([], [f.frame])), async m => { messages.push(m); return { ok: true }; }, () => {},
            { setInterval: fn => { tick = fn; return 1; }, clearInterval() {} });
        await flush();
        for (let n = 0; n < 3; n++) { f.child.head.childNodes.push(element("SCRIPT")); tick(); await flush(); }
        f.child.head.children[0].childNodes.push(element(tag)); tick(); await flush();
        f.child.head.children[0].childNodes.pop(); tick(); await flush();
        f.child.URL = "https://example.invalid/"; tick(); await flush();
        f.child.URL = "about:blank"; f.child.head.childNodes.length = 0; tick(); await flush();
        stop(); await flush();
        assert.deepEqual(messages, [false, false, false, false, true, false, true, false].map(keep => ({ keep })).concat([{ stop: true }] as any), tag);
    }
});
