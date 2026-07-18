// The right rail: the MOSH card (the live WebGL character + a status line) and the
// COLLABORATORS card (peers + invite). It's a symmetric push-dock — collapsed it's a
// vertical pull-tab carrying the minimized Moshi mark (so the character is always present),
// open it expands its column. Moshi self-wires from the store, so the card just frames him.
// The status line narrates the agent's last move (agentUtter.say) with a transport/render
// fallback ladder. Video tiles land in the collaborators slice.

import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { useShell } from "./shellState";
import { Moshi } from "../ui/Moshi";
import { MoshMark } from "./MoshMark";
import { IconCamera, IconCameraOff, IconChevronLeft, IconSpark, IconUsers } from "../ui/icons";
import { useVideo } from "../webrtc/useVideo";
import { VideoTile } from "../ui/VideoTile";
import { PresenceMeter } from "./PresenceMeter";
import { Inspector } from "./inspector/Inspector";
import { MultiplayerLauncher } from "./MultiplayerLauncher";
import { builtinEntry, installedEntry, matchEntry, type PluginEntry } from "../ui/pluginBrowserUtil";
import type { Plugin } from "../types";

export function RightRail() {
  const open = useShell((s) => s.rightOpen);
  const setOpen = useShell((s) => s.setRightOpen);
  const toggle = useShell((s) => s.toggleRight);

  return (
    <div className={`v2-dock v2-dock-right${open ? " open" : ""}`} data-testid="v2-right-dock">
      {open ? (
        <aside className="v2-rail" data-testid="v2-rail">
          <MoshCard onCollapse={() => setOpen(false)} />
          <Inspector />
          <MasterCard />
          <CollaboratorsCard />
        </aside>
      ) : (
        /* the pull-tab — the minimized Moshi keeps the character present even when parked */
        <button className="v2-dock-tab v2-dock-tab-mosh" data-testid="v2-right-pull" aria-expanded={false}
          aria-label="Open agent panel" title="Mosh — agent · inspector · collaborators" onClick={toggle}>
          <MoshMark size={30} />
          <span className="v2-dock-tab-label">MOSH</span>
        </button>
      )}
    </div>
  );
}

function MoshCard({ onCollapse }: { onCollapse: () => void }) {
  return (
    <section className="v2-card v2-mosh-card" data-testid="v2-mosh-card">
      <div className="v2-card-head">
        <span>Mosh</span>
        <span className="v2-mosh-head-r">
          <span className="v2-live"><span className="led" /> Live</span>
          <button className="v2-rail-collapse" data-testid="v2-rail-collapse" aria-label="Hide agent panel"
            title="Hide" onClick={onCollapse}><IconChevronLeft size={14} /></button>
        </span>
      </div>
      <div className="v2-mosh-stage"><Moshi /></div>
      <MoshStatusLine />
    </section>
  );
}

function MoshStatusLine() {
  const say = useStore((s) => s.agentUtter?.say);
  const recording = useStore((s) => s.transport.recording);
  const playing = useStore((s) => s.transport.playing);
  const rendering = useStore((s) => Object.keys(s.renderProgress).length > 0);
  const text = say || (recording ? "recording…" : rendering ? "rendering…" : playing ? "listening" : "ready when you are");
  return (
    <div className="v2-mosh-status" role="status" aria-live="polite" data-testid="v2-mosh-status">
      <span className="wave" aria-hidden><IconSpark size={13} /></span>
      <span>{text}</span>
    </div>
  );
}

// CONF-MASTER-VOL — the master bus fader/pan. set_master_volume/set_master_pan have
// existed natively (and agent-callable) since Wave 5 with no UI surface anywhere in
// v2; this is that surface. Lives in the rail next to the per-track Inspector Mix tab
// (the closest thing v2 has to a mixer strip) rather than the TopBar, which stays
// dedicated to transport/project chrome. Reuses the Inspector's .v2-mix/.v2-field
// layout verbatim so a master fader reads as the same control family as a track one.
export function MasterCard() {
  const exec = useStore((s) => s.exec);
  const master = useStore((s) => s.snapshot?.master);
  const plugins = master?.plugins ?? [];
  return (
    <section className="v2-card v2-master-card" data-testid="v2-master-card">
      <div className="v2-card-head"><span>Master</span></div>
      <div className="v2-mix v2-master-body">
        <label className="v2-field">
          <span>Vol</span>
          <input type="range" min={-48} max={6} step={0.5} value={master?.volumeDb ?? 0}
            aria-label="Master volume" data-testid="v2-master-volume"
            onChange={(e) => void exec("set_master_volume", { db: Number(e.target.value) })} />
          <span className="v2-val">{(master?.volumeDb ?? 0).toFixed(1)}</span>
        </label>
        <label className="v2-field">
          <span>Pan</span>
          <input type="range" min={-1} max={1} step={0.02} value={master?.pan ?? 0}
            aria-label="Master pan" data-testid="v2-master-pan"
            onChange={(e) => void exec("set_master_pan", { pan: Number(e.target.value) })} />
          <span className="v2-val">{Math.round((master?.pan ?? 0) * 100)}</span>
        </label>
        <MasterPluginRack plugins={plugins} />
      </div>
    </section>
  );
}

// Master-bus plugins (limiter, bus EQ, …) — hosted via getMasterPluginList(), the SAME
// load/remove/reorder/bypass/param/edit command seam the per-track FX rack uses
// (TrackFxDrawer / Dock's Rack+PluginCard), one level up (no trackId). Kept as its own
// small, self-contained rack here — rather than generalizing the shared per-track Rack
// component to a "master" mode — so the dark v2-card visual language and the widely-used
// classic Rack stay decoupled; the row shape (bypass dot · name · move · edit · remove)
// and the picker's underlying plugin-catalog utilities (pluginBrowserUtil) are the real
// reuse. exec() is the same execute_command seam either way.
function MasterPluginRack({ plugins }: { plugins: Plugin[] }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div className="v2-master-rack" data-testid="v2-master-rack">
      <div className="v2-master-rack-head">
        <span>Plugins</span>
        <button className="v2-btn icon" data-testid="v2-master-add-plugin" aria-expanded={pickerOpen}
          title="Add a plugin to the master bus" onClick={() => setPickerOpen((v) => !v)}>+ Plugin</button>
      </div>
      {plugins.length === 0 && <div className="v2-master-empty">No master-bus plugins yet.</div>}
      {plugins.map((p) => <MasterPluginRow key={p.index} plugin={p} />)}
      {pickerOpen && <MasterPluginPicker onClose={() => setPickerOpen(false)} />}
    </div>
  );
}

function MasterPluginRow({ plugin }: { plugin: Plugin }) {
  const exec = useStore((s) => s.exec);
  return (
    <div className={`v2-master-plugin-row${plugin.enabled ? "" : " bypassed"}`} data-testid="v2-master-plugin-row" data-plugin-index={plugin.index}>
      <button className={`v2-master-plugin-dot${plugin.enabled ? " on" : ""}`} title={plugin.enabled ? "Bypass" : "Enable"}
        aria-pressed={!plugin.enabled}
        onClick={() => void exec("bypass_master_plugin", { index: plugin.index, bypassed: plugin.enabled })} />
      <span className="v2-master-plugin-name" title={plugin.name}>{plugin.name}</span>
      <button className="v2-btn icon" title="Move earlier in the chain" aria-label={`Move ${plugin.name} earlier`}
        onClick={() => void exec("reorder_master_plugin", { index: plugin.index, toIndex: plugin.index - 1 })}>‹</button>
      <button className="v2-btn icon" title="Move later in the chain" aria-label={`Move ${plugin.name} later`}
        onClick={() => void exec("reorder_master_plugin", { index: plugin.index, toIndex: plugin.index + 1 })}>›</button>
      <button className="v2-btn icon" title="Open plugin window" aria-label={`Open ${plugin.name}`}
        onClick={() => void exec("open_master_plugin_editor", { index: plugin.index })}>⤢</button>
      <button className="v2-btn icon" title="Remove" aria-label={`Remove ${plugin.name}`}
        onClick={() => void exec("remove_master_plugin", { index: plugin.index })}>✕</button>
    </div>
  );
}

// Compact inline picker (search + load) — reuses the plugin-catalog utilities the real
// plugin browser (PluginBrowser.tsx) is built from, so master-bus plugin availability
// (installed VST3/AU + built-ins) is always identical to the per-track picker's.
function MasterPluginPicker({ onClose }: { onClose: () => void }) {
  const availablePlugins = useStore((s) => s.availablePlugins);
  const availableBuiltins = useStore((s) => s.availableBuiltins);
  const ensureCatalog = useStore((s) => s.ensurePluginCatalog);
  const exec = useStore((s) => s.exec);
  const [q, setQ] = useState("");
  useEffect(() => { ensureCatalog(); }, [ensureCatalog]);

  const entries = useMemo(() => {
    const all: PluginEntry[] = [...availableBuiltins.map(builtinEntry), ...availablePlugins.map(installedEntry)];
    return all.filter((e) => matchEntry(e, q, "all")).sort((a, b) => a.name.localeCompare(b.name));
  }, [availableBuiltins, availablePlugins, q]);

  const load = (e: PluginEntry) => {
    if (e.loadKind === "builtin") void exec("load_master_builtin", { type: e.loadKey });
    else void exec("load_master_plugin", { pluginId: e.loadKey });
    onClose();
  };

  return (
    <div className="v2-master-picker" data-testid="v2-master-plugin-picker">
      <label className="v2-pb-search">
        <span className="v2-pb-search-label">Search</span>
        <input aria-label="Search master-bus plugins" placeholder="Search by name or vendor..."
          value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <div className="v2-master-picker-list">
        {entries.length === 0 && (
          <div className="v2-master-empty">{q ? `Nothing matches "${q}".` : "No plugins here yet."}</div>
        )}
        {entries.map((e) => (
          <button key={e.uid} className="v2-pb-add" data-testid="v2-master-picker-row" onClick={() => load(e)} title={`Add ${e.name}`}>
            <span className={`v2-pb-kind ${e.isInstrument ? "inst" : "fx"}`}>{e.isInstrument ? "INST" : "FX"}</span>
            <span className="v2-pb-copy">
              <span className="v2-pb-name">{e.name}</span>
              <span className="v2-pb-meta">{e.meta}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function CollaboratorsCard() {
  const mp = useStore((s) => s.mp);
  const peers = useStore((s) => s.peers);
  const cameraOn = useVideo((s) => s.cameraOn);
  const localStream = useVideo((s) => s.localStream);
  const remoteStreams = useVideo((s) => s.remoteStreams);
  const toggleCamera = useVideo((s) => s.toggleCamera);
  const setHidden = useVideo((s) => s.setHidden);
  const teardown = useVideo((s) => s.teardown);
  const others = mp.active ? Object.entries(peers).filter(([id]) => id !== mp.selfPeer) : Object.entries(peers);
  const collaborationActive = mp.active || cameraOn || !!localStream || others.length > 0;

  // Release the camera on unmount + when the WebView is hidden (the light must not
  // stay on behind an invisible window) — mirrors the legacy Participants rail.
  useEffect(() => () => teardown(), [teardown]);
  useEffect(() => {
    const onVis = () => void setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [setHidden]);

  return (
    <section className="v2-card v2-collab-card" data-testid="v2-collaborators" data-active={collaborationActive ? "true" : "false"}>
      <div className="v2-card-head">
        <span>Collaborators</span>
        {collaborationActive ? (
          <button className={`v2-cam${cameraOn ? " on" : ""}`} data-testid="v2-camera-toggle" aria-pressed={cameraOn}
            title={cameraOn ? "Turn camera off" : "Share your camera"} onClick={() => void toggleCamera()}>
            {cameraOn ? <IconCamera size={15} /> : <IconCameraOff size={15} />}
          </button>
        ) : (
          <span className="v2-collab-kicker">Invite when ready</span>
        )}
      </div>
      <div className="v2-presence">
        {!collaborationActive ? (
          <div className="v2-collab-empty" data-testid="v2-collab-empty">
            <div className="v2-collab-empty-icon" aria-hidden><IconUsers size={18} /></div>
            <div className="v2-collab-empty-copy">
              <strong>Share when you need a second seat.</strong>
              <span>Camera stays off until you explicitly join collaboration.</span>
            </div>
            <MultiplayerLauncher
              className="v2-invite"
              testId="v2-invite"
              ariaLabel="Create or join a multiplayer session"
              label={<><IconUsers size={15} /><span>Invite collaborator</span></>}
            />
          </div>
        ) : (
          <>
            {cameraOn && localStream && (
              <div className="v2-pcard" data-testid="v2-collab-self">
                <VideoTile stream={localStream} muted label="Your camera" />
                <div className="v2-pcard-meta">
                  <span className="dot" />
                  <span className="nm">You</span>
                </div>
              </div>
            )}
            {others.map(([id, p]) => {
              const stream = remoteStreams[id];
              const offline = p.online === false;
              return (
                <div className="v2-pcard" key={id} data-testid="v2-collab-peer" data-cam={stream ? "on" : "off"}>
                  {stream
                    ? <VideoTile stream={stream} label={`${p.name}'s camera`} />
                    : <span className="v2-pcard-av" style={{ background: p.color }}>{(p.name || "?").charAt(0).toUpperCase()}</span>}
                  <div className="v2-pcard-meta">
                    <span className={`dot${offline ? " off" : ""}`} />
                    <span className="nm" title={p.name}>{p.name}</span>
                    {stream && <PresenceMeter stream={stream} />}
                  </div>
                </div>
              );
            })}
            <div className="v2-collab-actions">
              <MultiplayerLauncher
                className="v2-invite"
                testId="v2-invite"
                ariaLabel={mp.active ? "Multiplayer session — view room code" : "Create or join a multiplayer session"}
                label={<><IconUsers size={15} /><span>{mp.active ? "Share session" : "Invite collaborator"}</span></>}
              />
              {!cameraOn && <span className="v2-collab-hint">Camera stays off until you decide to share it.</span>}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
