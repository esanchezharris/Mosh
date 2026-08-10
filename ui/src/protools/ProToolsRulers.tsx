import type { KeyboardEvent, MouseEvent, RefObject } from "react";
import { useCallback, useMemo } from "react";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import type { ProToolsRuler, ProToolsRulersVisible } from "./proToolsState";
import {
  barsBeatsRulerTicks,
  formatMinutesSeconds,
  formatSamples,
  formatTimecode,
  linearRulerTicks,
  timelineSeconds,
  type ProToolsRulerTick,
} from "./layout";
import { numberedMemoryLocations } from "./memoryLocations";
import { ProToolsRulerSelectionOverlay } from "./ProToolsRulerSelectionOverlay";
import { PRO_TOOLS_RULER_SPECS } from "./proToolsRulerSpecs";
import {
  extendedProToolsSelection,
  proToolsSelectionSecondAt,
} from "./proToolsEditSelection";
import { useProTools } from "./proToolsState";
import { useProToolsEditSelection } from "./useProToolsEditSelection";
import { useProToolsTimelineSelectionModel } from "./proToolsTimelineSelection";

type Props = {
  snapshot: Snapshot;
  rulersVisible: ProToolsRulersVisible;
  contentWidth: number;
  fieldRef: RefObject<HTMLDivElement>;
  getScrollLeft: () => number;
};

const nearestKeyboardTick = (
  ticks: readonly ProToolsRulerTick[],
  position: number,
  direction: -1 | 1,
) => {
  if (direction > 0) return ticks.find((tick) => tick.seconds > position + 1e-6)?.seconds;
  return [...ticks].reverse().find((tick) => tick.seconds < position - 1e-6)?.seconds;
};

export function ProToolsRulers({
  snapshot,
  rulersVisible,
  contentWidth,
  fieldRef,
  getScrollLeft,
}: Props) {
  const exec = useStore((state) => state.exec);
  const pxPerSecond = useStore((state) => state.pxPerSec);
  const requestNewMemoryLocation = useProTools((state) => state.requestNewMemoryLocation);
  const requestEditMemoryLocation = useProTools((state) => state.requestEditMemoryLocation);
  const editMode = useProTools((state) => state.editMode);
  const activeTool = useProTools((state) => state.activeTool);
  const smartToolEnabled = useProTools((state) => state.smartToolEnabled);
  const { range, setRange, setDragging: setRangeDragging, target } =
    useProToolsTimelineSelectionModel();
  const totalSeconds = timelineSeconds(snapshot);
  const logicalTimelineWidth = Math.max(1, totalSeconds * pxPerSecond);
  const ticks = useMemo<Record<ProToolsRuler, ProToolsRulerTick[]>>(() => ({
    markers: [],
    barsBeats: barsBeatsRulerTicks(snapshot, logicalTimelineWidth),
    timecode: linearRulerTicks(totalSeconds, logicalTimelineWidth, formatTimecode, 102),
    minutesSeconds: linearRulerTicks(totalSeconds, logicalTimelineWidth, formatMinutesSeconds, 96),
    samples: linearRulerTicks(
      totalSeconds,
      logicalTimelineWidth,
      (seconds) => formatSamples(seconds, snapshot.session.sampleRate),
      92,
    ),
  }), [logicalTimelineWidth, snapshot, totalSeconds]);
  const memoryLocations = useMemo(() => numberedMemoryLocations(snapshot), [snapshot]);
  const visible = PRO_TOOLS_RULER_SPECS.filter((ruler) => rulersVisible[ruler.id]);
  const selectorEnabled = smartToolEnabled || activeTool === "selector";
  const seek = useCallback((position: number) => {
    void exec("set_transport", { position: Math.max(0, Math.min(totalSeconds, position)) });
  }, [exec, totalSeconds]);
  const positionAt = useCallback((element: HTMLElement, clientX: number, bypassSnap: boolean) => {
    const state = useStore.getState();
    return proToolsSelectionSecondAt({
      clientX,
      rectLeft: element.getBoundingClientRect().left,
      pxPerSecond,
      totalSeconds,
      editMode,
      bypassSnap,
      session: snapshot.session,
      snapDivision: state.effectiveSnapDivision(),
      snapTriplet: state.snapTriplet,
    });
  }, [editMode, pxPerSecond, snapshot.session, totalSeconds]);
  const editSelection = useProToolsEditSelection({
    enabled: selectorEnabled,
    positionAt,
    onPlaceCursor: seek,
    target,
  });

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (editSelection.consumePointerClick(event)) return;
    const position = event.detail === 0
      ? Math.max(0, Math.min(totalSeconds, getScrollLeft() / pxPerSecond))
      : positionAt(event.currentTarget, event.clientX, event.altKey);
    setRangeDragging(false);
    setRange(null);
    seek(position);
  };

  const onKeyDown = (ruler: ProToolsRuler, event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && range) {
      event.preventDefault();
      event.stopPropagation();
      setRangeDragging(false);
      setRange(null);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const position = useStore.getState().transport.position;
    const direction: -1 | 1 = event.key === "ArrowLeft" || event.key === "Home" ? -1 : 1;
    const edge = range ? (direction > 0 ? range.end : range.start) : position;
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? totalSeconds
        : nearestKeyboardTick(ticks[ruler], edge, direction);
    if (event.shiftKey && selectorEnabled && next !== undefined) {
      setRangeDragging(false);
      setRange(extendedProToolsSelection(range, position, next, direction));
      return;
    }
    setRangeDragging(false);
    setRange(null);
    if (next !== undefined) seek(next);
  };

  if (visible.length === 0) return null;
  return (
    <section className="pt-rulers" aria-label="Timeline rulers">
      <div className="pt-ruler-label-stack">
        {visible.map((ruler) => ruler.id === "markers" ? (
          <span className="pt-ruler-label pt-marker-label" key={ruler.id}>
            <span aria-hidden="true">{ruler.label}</span>
            <button type="button" data-testid="pt-memory-ruler-add"
              aria-label="Add Memory Location at the playhead"
              onClick={() => requestNewMemoryLocation(useStore.getState().transport.position)}>+</button>
          </span>
        ) : (
          <span className="pt-ruler-label" aria-hidden="true" key={ruler.id}>{ruler.label}</span>
        ))}
      </div>
      <div className="pt-ruler-viewport">
        <div
          ref={fieldRef}
          className="pt-ruler-field"
          style={{
            width: Math.max(1, contentWidth),
            transform: `translate3d(${-Math.max(0, getScrollLeft())}px, 0, 0)`,
          }}
        >
          {visible.map((ruler) => ruler.id === "markers" ? (
            <div className="pt-ruler-row pt-marker-ruler" data-ruler="markers"
              role="group" aria-label="Marker ruler with saved Memory Locations" key={ruler.id}>
              {memoryLocations.map((location) => (
                <button type="button" className="pt-marker-flag"
                  data-testid={`pt-memory-marker-${location.annotation.id}`}
                  key={location.annotation.id}
                  aria-label={`Memory Location ${location.number}: ${location.annotation.text}`}
                  title={`${location.number} · ${location.annotation.text} — double-click to edit; Option-click to remove`}
                  style={{
                    left: location.seconds * pxPerSecond,
                    "--pt-marker-color": location.annotation.color ?? "var(--pt-selected)",
                  } as React.CSSProperties}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    requestEditMemoryLocation(location.annotation.id);
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (event.altKey) {
                      void exec("remove_annotation", { annotationId: location.annotation.id });
                      return;
                    }
                    seek(location.seconds);
                  }}>
                  <span>{location.number}</span><span>{location.annotation.text}</span>
                </button>
              ))}
            </div>
          ) : (
            <button
              type="button"
              className="pt-ruler-row"
              data-ruler={ruler.id}
              key={ruler.id}
              aria-label={`${ruler.label} ruler, ${ruler.hint}. Click to place the playhead; drag with the Selector to make an Edit selection; use Shift plus Left or Right to extend it.`}
              onClick={onClick}
              onKeyDown={(event) => onKeyDown(ruler.id, event)}
              onPointerDown={(event) => {
                if (!editSelection.begin(event)) return;
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerMove={(event) => {
                if (!editSelection.move(event)) return;
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerUp={(event) => {
                if (!editSelection.finish(event)) return;
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerCancel={(event) => {
                if (!editSelection.cancel(event)) return;
                event.preventDefault();
                event.stopPropagation();
              }}
              onLostPointerCapture={(event) => {
                if (!editSelection.cancel(event)) return;
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {ticks[ruler.id].map((tick) => (
                <span
                  aria-hidden="true"
                  className={`pt-ruler-tick${tick.major ? " is-major" : " is-minor"}`}
                  key={`${ruler.id}-${tick.seconds}`}
                  style={{ left: tick.seconds * pxPerSecond }}
                >
                  {tick.label && <span className="pt-ruler-tick-label">{tick.label}</span>}
                </span>
              ))}
            </button>
          ))}
          <ProToolsRulerSelectionOverlay
            visibleRulers={visible.map((ruler) => ruler.id)}
            pxPerSecond={pxPerSecond}
            recordArmed={snapshot.tracks.some((track) => track.armed)} />
        </div>
      </div>
    </section>
  );
}
