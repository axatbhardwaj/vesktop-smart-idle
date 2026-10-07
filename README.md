# Vesktop SmartIdle

Experimental Vencord userplugin for **Vesktop on Hyprland, using XWayland**.
Keep the screen awake for video, camera, screen sharing, or an unmuted,
undeafened voice connection. Otherwise allow ordinary idle behavior while
remaining connected. The Vencord plugin toggle is the only setting.

This is a source plugin compiled into Vencord, not a JavaScript file you can
load directly. No daemon, permanent window rule, profile edits, account data,
or extra IPC service is needed.

## Build and install

Requires Linux, Git, Node.js 24+, npm/npx, and internet access for the build.
The script creates a **new** checkout at an explicit absolute path whose
parent already exists. It refuses existing directories. Choose a dedicated
build location; it never updates or overwrites your existing Vencord checkout.

```sh
git clone https://github.com/axatbhardwaj/vesktop-smart-idle.git
cd vesktop-smart-idle
npm test
npm run build -- "$PWD/.build"
```

The build checks out Vencord
`3374b8a9d8f6b051c64204917360293aad7f5d75`, **copies** the plugin to
`src/userplugins/smartIdle.vesktop`, and runs upstream's frozen dependency
install and normal desktop build using `npx --yes pnpm@11.9.0`. It does not
install pnpm system-wide or fetch an unpinned latest revision. A local
reference clone can be selected explicitly with `VENCORD_SOURCE`; the exact
revision is still checked. Vencord source and build outputs are not vendored.

In Vesktop, open **Settings → Vesktop Settings → Developer Options →
Vencord Location** and choose the new checkout's `dist` directory. Use the
existing picker; do not edit `settings.json`. The picker persists
`state.store.vencordDir` and requires these four files:

- `vencordDesktopMain.js`
- `vencordDesktopPreload.js`
- `vencordDesktopRenderer.js`
- `vencordDesktopRenderer.css`

Fully quit Vesktop, then launch it with:

```sh
vesktop --ozone-platform=x11
```

Enable **SmartIdle** under Vencord Plugins. Keep the main window visible and
mapped. Native Wayland is unsupported; SmartIdle cannot remove Chromium's
native Wayland call inhibitor. Other compositors and window classes besides
the exact `vesktop` class are unsupported. An ambiguous initial window match
is refused. Unsupported control produces an actionable notification.

On distributions whose Vesktop launcher reads `~/.config/vesktop-flags.conf`,
you may persist the X11 flag manually. First make a new backup that does not
overwrite an existing backup, then edit the original file, preserving every
other flag. Add `--ozone-platform=x11` only once and remove conflicting
`--ozone-platform=wayland` entries deliberately. For example, if the file
already exists:

```sh
cp -n ~/.config/vesktop-flags.conf ~/.config/vesktop-flags.conf.before-smart-idle
```

If that backup name already exists, choose another unused name before editing.
Skip the copy if the original does not exist and create the flag file in your editor.
A direct launch with the flag is sufficient; this repository edits no flags.

## Policy and limitations

`keep = video || sharing || (connected && !selfMuted && !selfDeaf)`.
Camera transmission counts as video. Media wins over mute/deafen, including
muted playing video elements. Push-to-talk silence and server mute do not
permit idle; self mute or self deafen does when no media needs protection.

The renderer polls every two seconds. It reads
`SelectedChannelStore.getVoiceChannelId`, `MediaEngineStore.isSelfMute`,
`isSelfDeaf`, `isVideoEnabled`, `isScreenSharing`, and
`ApplicationStreamingStore.getCurrentUserActiveStream`. It observes playing
main-document `<video>` elements without reading tracks or account/session
identifiers. It never infers watching from advertised remote streams.
Selected voice-channel membership conservatively includes join/reconnect
transitions; it does not prove a connected voice transport.

Missing, malformed, or throwing store getters **warn and keep awake** while
the renderer remains healthy. Main-document iframes and detected Discord
popouts also keep awake conservatively. The sole iframe exception is a hidden,
readable `about:blank` document with absent `src`/`srcdoc`, only its normal
head/body elements, and no content in either. It is checked again each poll;
media, navigation, visible styling, or unavailable DOM restores protection.
Playback inside other frames or popouts remains uncertain. Hidden/autoplay
videos, unrelated embeds, or paused popouts may therefore over-inhibit. Undetected playback in other windows or documents is
not covered. Notifications are deduplicated for each condition until the
plugin is enabled again.

The native helper accepts only a boolean update or stop message, from the
exact Discord origin and authenticated main frame of one bound BrowserWindow.
It uses its own process PID, exact window class, validated compositor address,
and `xwayland: true`; it revalidates before each dispatch. No focused-window
selection, renderer-supplied address/PID/command, shell, or focus stealing.
Updates are serialized and read back through `inhibitingIdle`; a command's
`ok` response alone is insufficient. This requires Hyprland's Lua dispatcher
`hl.dsp.window.set_prop` with string values `"1"` and `"0"` for `idle_inhibit`.
Older dispatcher generations are unsupported and warn.

**Do not combine SmartIdle with Vesktop idle-inhibit window rules or another
controller of the same property.** Disabling/crashing or losing the renderer
heartbeat for six seconds releases only the owned window's property to `0`.
That value means **none**, not restoration of an arbitrary previous rule.
An ordinary XWayland call may therefore idle and lock during a renderer hang
or after disable. Cleanup failures warn in the main-process log and retry;
a property can remain until commands recover or Vesktop fully exits. No
external watchdog runs. Window replacement or address reuse is refused;
fully exit and restart to establish a new binding.

**Tray-hidden/unmapped operation is unsupported and unverified.** Keep the
main window mapped for protection. Screen sharing under X11 ozone, real
Discord stream playback semantics, and actual desktop idle actions need
live verification; a source build and mock-boundary tests do not prove them.
On Omarchy, check the current Quickshell idle service and its
`respectInhibitors` setting, not an obsolete hypridle configuration.

## Update and rollback

Keep both the current working build and its previous build until you verify
an update. Update this plugin checkout deliberately, run `npm test`, and
build into another **new** directory. Select that directory's `dist` with the
Vencord Location picker, fully exit/relaunch with X11, and enable SmartIdle.
The Vencord pin stays fixed until an explicit compatibility change. Avoid
Vencord's Git updater for these managed builds; update through this recipe.

To roll back, disable SmartIdle, use the Vencord Location picker's reset
button to restore Vesktop's bundled Vencord (or select your previous `dist`),
and fully quit/relaunch. Restore only the flag changes you made, using your
backup as a reference. Fully exiting destroys the temporary window property.
You may then delete only the dedicated builds you created. No Hyprland rule,
account state, or system installation needs removal.

## Verification

`npm test` runs zero-dependency Node tests through the production renderer,
plugin entry point, IPC controller, and mocked Electron/compositor boundaries.
CI also runs the pinned upstream build and checks all four desktop artifacts.
The reference Vesktop revision is
`a02035be2083e09666ed250bd977325c35f5be95`. Build compatibility is established
for the Vencord pin above; real Discord/Vesktop runtime compatibility remains
unverified. Hyprland's actual idle timing is also unverified.

Before relying on protection, check in your own session:

1. Unmuted voice stays awake; self mute/deafen permits idle without leaving.
2. Camera, sharing, and watched/played video stay awake even while muted.
3. Stop media, leave voice, or disable the plugin and confirm ordinary idle.
4. Check actual desktop idle actions, X11 screen capture, and any popouts.
5. Keep the main window mapped; do not assume tray behavior works.

Licensed GPL-3.0-or-later; see [LICENSE](LICENSE).
