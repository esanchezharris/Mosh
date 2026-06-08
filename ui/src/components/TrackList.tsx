/**
 * TrackList — the left column of track headers.
 *
 * Per track: rename, gain fader, mute/solo/arm, plugin slot list with an add
 * affordance, and delete. A "+ Track" button at the bottom. Every control is a
 * command; selection is UI-local.
 */

import { useState } from "react";
import { executeCommand, type TrackState } from "../bridge";
import { useStore } from "../store";

function PluginSlots({ track }: { track: TrackState }) {
  const [adding, setAdding] = useState(false);

  const addVst = () => {
    void executeCommand("load_plugin", {
      track: track.id,
      type: "vst3",
      name: "VST3 FX",
    });
    setAdding(false);
  };
  const addNeural = () => {
    void executeCommand("add_neural_insert", {
      track: track.id,
      model: "NAM",
    });
    setAdding(false);
  };

  const toggleBypass = (pluginId: string, bypassed: boolean) => {
    void executeCommand("bypass_plugin", { plugin: pluginId, bypassed: !bypassed });
  };
  const remove = (pluginId: string) => {
    void executeCommand("remove_plugin", { plugin: pluginId });
  };

  return (
    <div className="plugin-slots">
      {track.plugins.map((p) => (
        <div
          key={p.id}
          className={`plugin-chip ${p.bypassed ? "bypassed" : ""} type-${p.type}`}
        >
          <span
            className="plugin-name"
            title={`${p.type} · ${p.bypassed ? "bypassed" : "active"}`}
            onClick={() => toggleBypass(p.id, p.bypassed)}
          >
            {p.name}
          </span>
          <button
            className="plugin-x"
            title="Remove plugin"
            onClick={() => remove(p.id)}
          >
            ×
          </button>
        </div>
      ))}
      {adding ? (
        <div className="plugin-add-menu">
          <button onClick={addVst}>+ VST3</button>
          <button onClick={addNeural}>+ Neural</button>
          <button className="cancel" onClick={() => setAdding(false)}>
            ×
          </button>
        </div>
      ) : (
        <button
          className="plugin-add"
          title="Add plugin"
          onClick={() => setAdding(true)}
        >
          + insert
        </button>
      )}
    </div>
  );
}

function TrackHeader({ track }: { track: TrackState }) {
  const selectedTrack = useStore((s) => s.selectedTrack);
  const selectTrack = useStore((s) => s.selectTrack);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(track.name);

  const selected = selectedTrack === track.id;

  const commitName = () => {
    if (nameDraft.trim() && nameDraft !== track.name) {
      void executeCommand("rename_track", { track: track.id, name: nameDraft.trim() });
    }
    setRenaming(false);
  };

  return (
    <div
      className={`track-header ${selected ? "selected" : ""}`}
      onMouseDown={() => selectTrack(track.id)}
    >
      <div className="track-header-top">
        {renaming ? (
          <input
            className="track-name-input"
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <span
            className="track-name"
            onDoubleClick={() => {
              setNameDraft(track.name);
              setRenaming(true);
            }}
            title="Double-click to rename"
          >
            {track.name}
          </span>
        )}
        <button
          className="track-del"
          title="Delete track"
          onClick={(e) => {
            e.stopPropagation();
            void executeCommand("delete_track", { track: track.id });
          }}
        >
          ×
        </button>
      </div>

      <div className="track-controls">
        <button
          className={`mini ${track.mute ? "on mute" : ""}`}
          title="Mute"
          onClick={(e) => {
            e.stopPropagation();
            void executeCommand("set_track_mute", { track: track.id });
          }}
        >
          M
        </button>
        <button
          className={`mini ${track.solo ? "on solo" : ""}`}
          title="Solo"
          onClick={(e) => {
            e.stopPropagation();
            void executeCommand("set_track_solo", { track: track.id });
          }}
        >
          S
        </button>
        <button
          className={`mini ${track.armed ? "on arm" : ""}`}
          title="Arm for record"
          onClick={(e) => {
            e.stopPropagation();
            void executeCommand("arm_track", { track: track.id });
          }}
        >
          ●
        </button>
      </div>

      <div className="track-gain">
        <span className="gain-label">gain</span>
        <input
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          value={track.gain}
          onChange={(e) =>
            void executeCommand("set_track_gain", {
              track: track.id,
              gain: Number.parseFloat(e.target.value),
            })
          }
          onMouseDown={(e) => e.stopPropagation()}
        />
        <span className="gain-value">{track.gain.toFixed(2)}</span>
      </div>

      <PluginSlots track={track} />
    </div>
  );
}

export default function TrackList() {
  const snapshot = useStore((s) => s.snapshot);

  const addTrack = () => {
    void executeCommand("create_track", {});
  };

  return (
    <div className="track-list">
      <div className="track-list-head">
        <span>Tracks</span>
        <button className="add-track" onClick={addTrack} title="Add track">
          + Track
        </button>
      </div>
      <div className="track-headers">
        {snapshot?.tracks.map((t) => (
          <TrackHeader key={t.id} track={t} />
        ))}
        {snapshot && snapshot.tracks.length === 0 && (
          <div className="empty-hint">
            No tracks yet. Click <b>+ Track</b> to start.
          </div>
        )}
      </div>
    </div>
  );
}
