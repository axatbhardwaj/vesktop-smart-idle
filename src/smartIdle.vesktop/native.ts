// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from "node:child_process";
import { BrowserWindow, type IpcMainInvokeEvent } from "electron";

import { createController } from "./controller.ts";

// Native modules load even while the plugin is disabled. Start lazily.
let controller: ReturnType<typeof createController> | undefined;
export function update(event: IpcMainInvokeEvent, message: unknown) {
    controller ??= createController({
        pid: process.pid,
        available: () => process.platform === "linux" && Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE),
        now: () => performance.now(),
        windows: () => BrowserWindow.getAllWindows(),
        fromWebContents: sender => BrowserWindow.fromWebContents(sender),
        setInterval, clearInterval,
        run: args => new Promise((resolve, reject) => {
            execFile("hyprctl", args, { timeout: 1000, maxBuffer: 1024 * 1024, shell: false, encoding: "utf8" },
                (error, stdout) => error ? reject(error) : resolve(stdout));
        })
    });
    return controller.update(event, message);
}
