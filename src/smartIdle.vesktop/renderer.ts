// SPDX-License-Identifier: GPL-3.0-or-later
export type Message = { keep: boolean } | { stop: true };
export type Result = { ok: boolean; error?: string; uncertain?: boolean };
type Sources = {
    SelectedChannelStore: { getVoiceChannelId(): unknown };
    MediaEngineStore: { isSelfMute(): unknown; isSelfDeaf(): unknown; isVideoEnabled(): unknown; isScreenSharing(): unknown };
    ApplicationStreamingStore: { getCurrentUserActiveStream(): unknown };
};

export function observe(stores: Sources, document: Pick<Document, "querySelectorAll">) {
    try {
        const channel = stores.SelectedChannelStore.getVoiceChannelId();
        const media = stores.MediaEngineStore;
        const [muted, deaf, camera, sharing] = [media.isSelfMute(), media.isSelfDeaf(), media.isVideoEnabled(), media.isScreenSharing()];
        const stream = stores.ApplicationStreamingStore.getCurrentUserActiveStream();
        if ((channel != null && typeof channel !== "string") ||
            [muted, deaf, camera, sharing].some(v => typeof v !== "boolean") ||
            (stream != null && typeof stream !== "object")) throw Error("Unknown store shape");
        const video = Array.from(document.querySelectorAll("video")).some(v => !v.paused && !v.ended);
        const uncertain = Array.from(document.querySelectorAll("iframe")).some(frame => {
            if (frame.getAttribute("src") !== null || frame.getAttribute("srcdoc") !== null) return true;
            const style = frame.ownerDocument.defaultView?.getComputedStyle(frame);
            const child = frame.contentDocument;
            // Discord inserts hidden blank implementation frames. Exempt only proven empty ones.
            const hidden = style?.display === "none" || style?.visibility === "hidden";
            return !(hidden && child?.URL === "about:blank" &&
                child.documentElement?.children.length === 2 &&
                child.head?.childNodes.length === 0 && child.body?.childNodes.length === 0);
        });
        return { keep: Boolean(video || camera || sharing || stream || (channel && !muted && !deaf) || uncertain), uncertain };
    } catch {
        return { keep: true, uncertain: true };
    }
}

export function startRenderer(
    read: () => { keep: boolean; uncertain: boolean },
    send: (message: Message) => Promise<Result>, warn: (reason: string) => void,
    clock: { setInterval(fn: () => void, ms: number): any; clearInterval(id: any): void } = globalThis
) {
    let stopped = false;
    let busy = false;
    let pending = false;
    const warned = new Set<string>();
    const warning = (reason: string) => { if (!warned.has(reason)) { warned.add(reason); warn(reason); } };
    const tick = async () => {
        if (busy) { pending = true; return; }
        busy = true;
        try {
            do {
                pending = false;
                const observation = stopped ? undefined : read();
                if (observation?.uncertain) warning("Unknown media/state; keeping awake conservatively.");
                const result = await send(observation ? { keep: observation.keep } : { stop: true });
                if (!result.ok) warning(result.error ?? "Native control unavailable.");
                if (result.uncertain) warning("Popout present; keeping awake conservatively.");
            } while (pending);
        } catch {
            warning("Native control failed; awake protection may be lost.");
            // Disable must still follow any failed in-flight heartbeat.
            if (stopped && pending) {
                pending = false;
                try { await send({ stop: true }); } catch { /* Native lease also expires. */ }
            }
        } finally { busy = false; }
    };
    const timer = clock.setInterval(() => { if (!stopped) void tick(); }, 2000);
    void tick();
    return () => {
        if (stopped) return;
        stopped = true;
        clock.clearInterval(timer);
        void tick();
    };
}
