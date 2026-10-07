// SPDX-License-Identifier: GPL-3.0-or-later
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron";
import type { Message, Result } from "./renderer.ts";

type Host = {
    warn(reason: string): void; pid: number; available(): boolean; now(): number;
    windows(): BrowserWindow[]; fromWebContents(sender: WebContents): BrowserWindow | undefined | null;
    run(args: string[]): Promise<string>;
    setInterval(fn: () => void, ms: number): any; clearInterval(id: any): void;
};
type Client = { pid: number; class: string; xwayland: boolean; address: string; inhibitingIdle: boolean };
const origins = new Set(["https://discord.com", "https://canary.discord.com", "https://ptb.discord.com"]);
function discord(url: string) {
    try { const u = new URL(url); return origins.has(u.origin) && !u.username && !u.password; } catch { return false; }
}

function validMessage(message: unknown): message is Message {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const keys = Object.keys(message);
    return keys.length === 1 && (
        keys[0] === "keep" && "keep" in message && typeof message.keep === "boolean" ||
        keys[0] === "stop" && "stop" in message && message.stop === true
    );
}

export function createController(host: Host) {
    let sender: WebContents | undefined;
    let address: string | undefined;
    let active = false;
    let keep = false;
    let heartbeat = 0;
    let version = 0;
    let timer: any;
    let running: Promise<Result> | undefined;
    const owned = (c: Client) => c.pid === host.pid && c.class === "vesktop" && c.xwayland === true && /^0x[0-9a-fA-F]+$/.test(c.address);
    const clients = async (): Promise<Client[]> => {
        const data = JSON.parse(await host.run(["-j", "clients"]));
        if (!Array.isArray(data)) throw Error("Invalid compositor response");
        return data;
    };
    const failure = (error: string): Result => ({ ok: false, error });
    const retire = () => {
        address = undefined;
        if (timer !== undefined) host.clearInterval(timer);
        timer = undefined;
    };
    const apply = async (): Promise<Result> => {
        if (!active && !address) { retire(); return { ok: true }; }
        if (!host.available()) return failure("Unsupported: requires Hyprland and XWayland Vesktop.");
        let list = await clients();
        if (!address) {
            if (!active) return { ok: true };
            const matches = list.filter(owned);
            if (matches.length !== 1) return failure("Unsupported: expected one exact vesktop XWayland client owned by this process.");
            address = matches[0].address;
        }
        // Revalidate the bound address immediately before dispatch; never choose focus.
        list = await clients();
        const matches = list.filter(c => c.address === address && owned(c));
        if (matches.length !== 1) return failure("Owned window disappeared or changed; no mutation performed.");
        const uncertain = active && host.windows().some(w => !w.isDestroyed() && w.webContents !== sender && discord(w.webContents.mainFrame.url));
        const desired = active && (keep || uncertain);
        if (typeof matches[0].inhibitingIdle !== "boolean") return failure("Compositor idle readback unavailable.");
        // Always write on release: 0 relinquishes our property, even if currently unmapped.
        if (!active || matches[0].inhibitingIdle !== desired) {
            await host.run(["dispatch", `hl.dsp.window.set_prop({window="address:${address}", prop="idle_inhibit", value="${desired ? "1" : "0"}"})`]);
            const after = (await clients()).filter(c => c.address === address && owned(c));
            if (after.length !== 1 || after[0].inhibitingIdle !== desired) return failure("Idle property did not take effect; keep the main window mapped and check for competing rules.");
        }
        // Stop may arrive during an enabling dispatch. Retain ownership until 0 drains.
        if (!active && !desired) retire();
        return { ok: true, uncertain };
    };
    const drain = async (): Promise<Result> => {
        try {
            let result: Result;
            let observed: number;
            do {
                observed = version;
                try { result = await apply(); } catch { result = failure("Hyprland command failed or timed out; awake protection may be lost."); }
            } while (observed !== version);
            return result;
        } finally { running = undefined; }
    };
    const schedule = () => { version++; return running ??= drain(); };
    const cleanup = () => { void schedule().then(result => { if (!result.ok) host.warn(result.error!); }); };
    const release = () => { active = false; keep = false; cleanup(); };
    return {
        async update(event: IpcMainInvokeEvent, message: unknown): Promise<Result> {
            if (!validMessage(message)) return failure("Invalid SmartIdle message.");
            const frame = event.senderFrame;
            const win = host.fromWebContents(event.sender);
            if (!frame || event.sender.isDestroyed() || frame !== event.sender.mainFrame || frame.parent || frame.name ||
                !discord(frame.url) || !win || win.isDestroyed() || win.webContents !== event.sender) return failure("Unauthorized SmartIdle sender.");
            if (sender && sender !== event.sender) return failure("SmartIdle is bound to another renderer.");
            if (!sender) {
                const primary = host.windows().filter(w => !w.isDestroyed() && !w.webContents.mainFrame.name && discord(w.webContents.mainFrame.url));
                if (primary.length !== 1 || primary[0].webContents !== event.sender) return failure("Ambiguous main renderer.");
                sender = event.sender;
                sender.on("destroyed", release);
                sender.on("render-process-gone", release);
            }
            if ("stop" in message) active = false;
            else { active = true; keep = message.keep; heartbeat = host.now(); }
            if (active && timer === undefined) timer = host.setInterval(() => {
                if (active && host.now() - heartbeat >= 6000) release();
                else if (!active && address) cleanup();
            }, 1000);
            return schedule();
        }
    };
}
