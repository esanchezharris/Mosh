import type { RefObject } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { MoshMenu, MoshMenuItem } from "../chrome/Menu";
import { MoshTip } from "../chrome/Tooltip";
import { secondsToBBSMap, tempoMapFrom } from "../time";
import type { Snapshot } from "../types";
import { IconList, IconMore, IconPause, IconPlay, IconSettings, IconSpark, IconStop } from "../ui/icons";
import { useTransportControls } from "../v2/useTransportControls";
import { ProToolsSessionMenu } from "./ProToolsSessionMenu";
import { ProToolsPunchControls } from "./ProToolsPunchControls";
import { ProToolsZoomControls } from "./ProToolsZoomControls";
import { useProTools, type ProToolsEditMode, type ProToolsRuler } from "./proToolsState";
import type { ProToolsTool } from "./smartTool";

const MODES: readonly { id: ProToolsEditMode; key: string; label: string }[] = [
  { id: "shuffle", key: "F1", label: "Shuffle" },
  { id: "slip", key: "F2", label: "Slip" },
  { id: "spot", key: "F3", label: "Spot" },
  { id: "grid", key: "F4", label: "Grid" },
];

const TOOLS: readonly { id: ProToolsTool; key: string; label: string; glyph: string }[] = [
  { id: "zoomer", key: "F5", label: "Zoomer", glyph: "⌕" },
  { id: "trimmer", key: "F6", label: "Trimmer", glyph: "⇥" },
  { id: "selector", key: "F7", label: "Selector", glyph: "│" },
  { id: "grabber", key: "F8", label: "Grabber", glyph: "✥" },
  { id: "scrubber", key: "F9", label: "Scrubber", glyph: "↝" },
  { id: "pencil", key: "F10", label: "Pencil", glyph: "⌁" },
];

const RULERS: readonly { id: ProToolsRuler; label: string }[] = [
  { id: "markers", label: "Markers" },
  { id: "barsBeats", label: "Bars+Beats" },
  { id: "timecode", label: "Timecode" },
  { id: "minutesSeconds", label: "Minutes:Seconds" },
  { id: "samples", label: "Samples" },
];

export function ProToolsToolbar({ snapshot, onOpenSettings, moshiOpen, onToggleMoshi, moshiButtonRef }: {
  snapshot: Snapshot;
  onOpenSettings: () => void;
  moshiOpen: boolean;
  onToggleMoshi: () => void;
  moshiButtonRef: RefObject<HTMLButtonElement>;
}) {
  const exec = useStore((s) => s.exec);
  const transportState = useStore((s) => s.transport);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const editMode = useProTools((s) => s.editMode);
  const setEditMode = useProTools((s) => s.setEditMode);
  const activeTool = useProTools((s) => s.activeTool);
  const setActiveTool = useProTools((s) => s.setActiveTool);
  const smartToolEnabled = useProTools((s) => s.smartToolEnabled);
  const toggleSmartTool = useProTools((s) => s.toggleSmartTool);
  const tabToTransient = useProTools((s) => s.tabToTransient);
  const setTabToTransient = useProTools((s) => s.setTabToTransient);
  const rulersVisible = useProTools((s) => s.rulersVisible);
  const toggleRuler = useProTools((s) => s.toggleRuler);
  const clipListOpen = useProTools((s) => s.clipListOpen);
  const setClipListOpen = useProTools((s) => s.setClipListOpen);
  const nudgeValue = useProTools((s) => s.nudgeValue);
  const setNudgeValue = useProTools((s) => s.setNudgeValue);
  const classicTheme = useProTools((s) => s.classicTheme);
  const toggleClassicTheme = useProTools((s) => s.toggleClassicTheme);
  const memoryLocationsOpen = useProTools((s) => s.memoryLocationsOpen);
  const setMemoryLocationsOpen = useProTools((s) => s.setMemoryLocationsOpen);
  const setShell = useSettings((s) => s.set);
  const fallbackTrackId = selectedTrackId
    ?? snapshot.tracks.find((track) => track.type === "audio")?.id
    ?? snapshot.tracks[0]?.id;
  const transport = useTransportControls({
    exec,
    anyArmed: snapshot.tracks.some((track) => track.armed),
    fallbackTrackId,
  });

  const chooseTool = (tool: ProToolsTool) => {
    setActiveTool(tool);
    if (smartToolEnabled) toggleSmartTool();
  };

  return (
    <header className="pt-toolbar" data-testid="pt-toolbar">
      <div className="pt-toolbar-group pt-session-group" aria-label="Session">
        <span className="pt-toolbar-label">File</span>
        <ProToolsSessionMenu />
      </div>
      <div className="pt-toolbar-group pt-mode-group" role="group" aria-label="Edit Modes">
        <span className="pt-toolbar-label">Edit Modes</span>
        {MODES.map((mode) => (
          <MoshTip key={mode.id} side="bottom" label={`${mode.label} mode · ${mode.key}`}>
            <button type="button" className="pt-mode-button" data-mode={mode.id}
              aria-pressed={editMode === mode.id} onClick={() => setEditMode(mode.id)}>
              <span>{mode.label}</span><kbd>{mode.key}</kbd>
            </button>
          </MoshTip>
        ))}
      </div>

      <ProToolsZoomControls />

      <div className="pt-toolbar-group pt-tool-group" role="group" aria-label="Edit Tools">
        <span className="pt-toolbar-label">Edit Tools</span>
        {TOOLS.map((tool) => (
          <MoshTip key={tool.id} side="bottom" label={`${tool.label} · ${tool.key}`}>
            <button type="button" className="pt-tool-button" data-tool={tool.id}
              aria-label={tool.label} aria-pressed={!smartToolEnabled && activeTool === tool.id}
              onClick={() => chooseTool(tool.id)}>
              <span aria-hidden="true">{tool.glyph}</span><kbd>{tool.key}</kbd>
            </button>
          </MoshTip>
        ))}
        <MoshTip side="bottom" label="Smart Tool · contextual Trim, Selector, Grabber, fades, velocity, and automation">
          <button type="button" className="pt-smart-button" data-testid="pt-smart-tool"
            aria-pressed={smartToolEnabled} onClick={toggleSmartTool}>Smart</button>
        </MoshTip>
      </div>

      <div className="pt-toolbar-group pt-transport-group" role="group" aria-label="Transport">
        <span className="pt-main-counter" data-testid="pt-main-counter">
          {secondsToBBSMap(tempoMapFrom(snapshot.session), transportState.position)}
        </span>
        <button type="button" aria-label={transportState.playing ? "Pause" : "Play"}
          aria-pressed={transportState.playing} onClick={() => void transport.togglePlay()}>
          {transportState.playing ? <IconPause size={13} /> : <IconPlay size={13} />}
        </button>
        <button type="button" aria-label="Stop" onClick={() => void transport.stop()}><IconStop size={13} /></button>
        <button type="button" className="pt-record-button" aria-label="Record"
          aria-pressed={transportState.recording} onClick={() => void transport.record()}><span /></button>
        <ProToolsPunchControls snapshot={snapshot} />
      </div>

      <div className="pt-toolbar-group pt-grid-group">
        <label className="pt-nudge-control">Nudge
          <select aria-label="Nudge value" value={nudgeValue}
            onChange={(e) => setNudgeValue(Number(e.target.value))}>
            <option value={0.001}>1 ms</option><option value={0.01}>10 ms</option>
            <option value={0.1}>100 ms</option><option value={0.25}>250 ms</option>
            <option value={1}>1 sec</option>
          </select>
        </label>
        <button type="button" className="pt-transient-button" aria-pressed={tabToTransient}
          onClick={() => setTabToTransient(!tabToTransient)}>Tab to Transients</button>
      </div>

      <div className="pt-toolbar-group pt-moshi-group">
        <span className="pt-toolbar-label">Assistant</span>
        <MoshTip side="bottom" label={moshiOpen ? "Close Moshi" : "Ask Moshi without changing the Edit Window layout"}>
          <button ref={moshiButtonRef} type="button" className="pt-moshi-button" data-testid="pt-ask-moshi"
            aria-expanded={moshiOpen} aria-controls={moshiOpen ? "pt-moshi-drawer" : undefined}
            aria-pressed={moshiOpen} onClick={onToggleMoshi}>
            <IconSpark size={13} /><span>Ask Moshi</span>
          </button>
        </MoshTip>
      </div>

      <div className="pt-toolbar-spacer" />
      <div className="pt-toolbar-group pt-view-group">
        <button type="button" className="pt-view-button" data-testid="pt-memory-toggle"
          aria-expanded={memoryLocationsOpen} aria-controls="pt-memory-locations"
          aria-pressed={memoryLocationsOpen}
          onClick={() => setMemoryLocationsOpen(!memoryLocationsOpen)}>Memory</button>
        <MoshMenu label="Visible rulers" align="end" trigger={
          <button type="button" className="pt-view-button" aria-label="Visible rulers">Rulers</button>}>
          <div className="pt-menu" role="menu">
            {RULERS.map((ruler) => (
              <MoshMenuItem key={ruler.id} ariaLabel={`Toggle ${ruler.label} ruler`}
                onPick={() => toggleRuler(ruler.id)}>
                <span>{rulersVisible[ruler.id] ? "✓" : "·"}</span> {ruler.label}
              </MoshMenuItem>
            ))}
          </div>
        </MoshMenu>
        <MoshTip side="bottom" label={clipListOpen ? "Hide Clip List" : "Show Clip List"}>
          <button type="button" aria-label="Toggle Clip List" aria-pressed={clipListOpen}
            onClick={() => setClipListOpen(!clipListOpen)}><IconList size={13} /></button>
        </MoshTip>
        <button type="button" className="pt-classic-button" aria-pressed={classicTheme}
          onClick={toggleClassicTheme}>Classic</button>
        <button type="button" aria-label="Settings" onClick={onOpenSettings}><IconSettings size={13} /></button>
        <MoshMenu label="Interface options" align="end" trigger={
          <button type="button" aria-label="Interface options"><IconMore size={13} /></button>}>
          <div className="pt-menu" role="menu">
            <MoshMenuItem onPick={() => setShell("uiShell", "live")}>Switch to Live (clone)</MoshMenuItem>
            <MoshMenuItem onPick={() => setShell("uiShell", "v2")}>Switch to Mosh (new)</MoshMenuItem>
            <MoshMenuItem onPick={() => setShell("uiShell", "classic")}>Switch to Classic</MoshMenuItem>
          </div>
        </MoshMenu>
      </div>
    </header>
  );
}
