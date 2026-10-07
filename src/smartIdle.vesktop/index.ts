// SPDX-License-Identifier: GPL-3.0-or-later
import { showNotification } from "@api/Notifications";
import definePlugin, { type PluginNative } from "@utils/types";
import { ApplicationStreamingStore, MediaEngineStore, SelectedChannelStore } from "@webpack/common";

import { observe, startRenderer } from "./renderer.ts";

const Native = VencordNative.pluginHelpers.SmartIdle as PluginNative<typeof import("./native")>;
let stop: (() => void) | undefined;
export default definePlugin({
    name: "SmartIdle",
    description: "Voice and media aware idle control for Hyprland XWayland Vesktop.",
    authors: [],
    start() {
        stop?.();
        stop = startRenderer(
            () => observe({ SelectedChannelStore, MediaEngineStore, ApplicationStreamingStore }, document),
            message => Native.update(message),
            reason => {
                console.warn("[SmartIdle]", reason);
                showNotification({ title: "SmartIdle needs attention", body: reason });
            }
        );
    },
    stop() { stop?.(); stop = undefined; }
});
