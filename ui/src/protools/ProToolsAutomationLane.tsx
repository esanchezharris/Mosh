import { useMemo } from "react";
import type { CSSProperties } from "react";
import { useStore } from "../store";
import type { Track } from "../types";
import { ProToolsAutomationCurve } from "./ProToolsAutomationCurve";
import { firstAutomationTarget } from "./automationEditing";
import { useProToolsAutomationLane } from "./useProToolsAutomationLane";

type Props = {
  readonly track: Track;
  readonly width: number;
};

type LaneStyle = CSSProperties & { "--pt-track-color": string };

export function ProToolsAutomationLane({ track, width }: Props) {
  const pxPerSec = useStore((state) => state.pxPerSec);
  const position = useStore((state) => state.transport.position);
  const target = useMemo(() => firstAutomationTarget(track), [track.plugins, track.mixerPlugins]);
  const snapshotPoints = target?.points ?? [];
  const interaction = useProToolsAutomationLane({
    trackId: track.id,
    target,
    snapshotPoints,
    pxPerSec,
    position,
  });
  const laneStyle: LaneStyle = { "--pt-track-color": track.color ?? "var(--pt-selected)" };
  const selectionStyle: CSSProperties | undefined = interaction.selection ? {
    left: interaction.selection.start * pxPerSec,
    width: Math.max(0, (interaction.selection.end - interaction.selection.start) * pxPerSec),
  } : undefined;

  return (
    <div className="pt-automation-lane-frame" style={laneStyle}>
      <button type="button" className="pt-automation-lane"
        data-testid="protools-automation-lane" data-track-id={track.id} disabled={!target}
        aria-keyshortcuts="Enter Space Escape"
        aria-label={target
          ? `${track.name} automation, ${target.paramName}. Drag the lower area to select, drag the upper area to trim, or press Enter or Space to add a breakpoint at the playhead. Plus or Minus nudges selected points.`
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
        pxPerSec={pxPerSec} width={width} />
    </div>
  );
}
