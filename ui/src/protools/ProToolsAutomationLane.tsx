import { useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useStore } from "../store";
import type { Track } from "../types";
import { ProToolsAutomationCurve } from "./ProToolsAutomationCurve";
import { ProToolsAutomationMenu } from "./ProToolsAutomationMenu";
import { automationTargetByName, firstAutomationTarget } from "./automationEditing";
import { useProToolsAutomationLane } from "./useProToolsAutomationLane";

type Props = {
  readonly track: Track;
  readonly width: number;
  readonly primary?: boolean;
  readonly targetName?: string;
};

type LaneStyle = CSSProperties & { "--pt-track-color": string };

export function ProToolsAutomationLane({ track, width, primary = false, targetName }: Props) {
  const pxPerSec = useStore((state) => state.pxPerSec);
  const position = useStore((state) => state.transport.position);
  const target = useMemo(
    () => targetName ? automationTargetByName(track, targetName) : firstAutomationTarget(track),
    [targetName, track.plugins, track.mixerPlugins],
  );
  const graphTopPx = primary ? 6 : 3;
  const graphHeightPx = primary ? 80 : 20;
  const snapshotPoints = target?.points ?? [];
  const interaction = useProToolsAutomationLane({
    trackId: track.id,
    target,
    snapshotPoints,
    pxPerSec,
    position,
    graphTopPx,
    graphHeightPx,
  });
  const laneRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const closeMenu = () => {
    setMenu(null);
    laneRef.current?.focus();
  };
  const laneStyle: LaneStyle = { "--pt-track-color": track.color ?? "var(--pt-selected)" };
  const selectionStyle: CSSProperties | undefined = interaction.selection ? {
    left: interaction.selection.start * pxPerSec,
    width: Math.max(0, (interaction.selection.end - interaction.selection.start) * pxPerSec),
  } : undefined;

  return (
    <>
      <div className="pt-automation-lane-frame" style={laneStyle}
        data-testid="pt-automation-lane-frame" data-primary={primary}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.ctrlKey) return;
          setMenu({ x: event.clientX, y: event.clientY });
        }}>
      <button ref={laneRef} type="button" className="pt-automation-lane"
        data-testid="protools-automation-lane" data-track-id={track.id} disabled={!target}
        data-mosh-edit-owner="protools-automation"
        aria-keyshortcuts="Enter Space Escape Meta+C Meta+X Meta+V"
        aria-label={target
          ? `${track.name} automation, ${target.paramName}. Drag the lower area to select, drag the upper area to trim, Control-drag to draw a line, Control-Command-drag to draw freehand, or press Enter or Space to add a breakpoint at the playhead. Plus or Minus nudges selected points.`
          : `${track.name} automation, no target`}
        onPointerMove={interaction.onPointerMove}
        onPointerLeave={() => interaction.setHoveredIntent(null)}
        onPointerDown={interaction.onPointerDown}
        onPointerUp={interaction.onPointerUp}
        onPointerCancel={interaction.onPointerCancel}
        onKeyDown={interaction.onKeyDown}>
        {interaction.selection && interaction.selection.end > interaction.selection.start && (
          <span className="pt-automation-selection" data-testid="pt-automation-selection"
            style={selectionStyle} aria-hidden="true" />
        )}
        <span className="pt-automation-label">{target?.paramName ?? "Automation"}</span>
        {interaction.trimReadout !== null && (
          <span className="pt-automation-trim-readout" aria-live="polite">
            {interaction.trimReadout >= 0 ? "+" : ""}{interaction.trimReadout.toFixed(2)}
          </span>
        )}
      </button>
      <ProToolsAutomationCurve trackId={track.id} target={target}
        points={interaction.renderedPoints} selection={interaction.selection}
        pxPerSec={pxPerSec} width={width} onEditKeyDown={interaction.onEditKeyDown}
        graphTopPx={graphTopPx} graphHeightPx={graphHeightPx} />
      </div>
      {menu && (
        <ProToolsAutomationMenu x={menu.x} y={menu.y} label={target?.paramName ?? "Automation"}
          canCopy={interaction.clipboard.canCopy} canPaste={interaction.clipboard.canPaste}
          onCut={interaction.clipboard.cut} onCopy={interaction.clipboard.copy}
          onPaste={interaction.clipboard.paste} onClose={closeMenu} />
      )}
    </>
  );
}
