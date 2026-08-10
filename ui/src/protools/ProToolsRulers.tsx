import type { KeyboardEvent, MouseEvent, RefObject } from "react";
import { useMemo } from "react";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import type { ProToolsRuler, ProToolsRulersVisible } from "./proToolsState";
import {
  barsBeatsRulerTicks,
  formatMinutesSeconds,
  formatSamples,
  formatTimecode,
  linearRulerTicks,
  secondsAtClientX,
  secondsAtScrollLeft,
  timelinePxPerSecond,
  timelineSeconds,
  type ProToolsRulerTick,
} from "./layout";
import { numberedMemoryLocations } from "./memoryLocations";
import { useProTools } from "./proToolsState";

type Props = {
  snapshot: Snapshot;
  rulersVisible: ProToolsRulersVisible;
  contentWidth: number;
  fieldRef: RefObject<HTMLDivElement>;
  getScrollLeft: () => number;
};

type RulerSpec = {
  id: ProToolsRuler;
  label: string;
  hint: string;
};

const RULERS: readonly RulerSpec[] = [
  { id: "markers", label: "Markers", hint: "saved Memory Locations" },
  { id: "barsBeats", label: "Bars+Beats", hint: "musical bars and beats" },
  { id: "timecode", label: "Timecode", hint: "30 frames per second" },
  { id: "minutesSeconds", label: "Minutes:Seconds", hint: "elapsed minutes and seconds" },
  { id: "samples", label: "Samples", hint: "audio samples" },
];

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
  const requestNewMemoryLocation = useProTools((state) => state.requestNewMemoryLocation);
  const requestEditMemoryLocation = useProTools((state) => state.requestEditMemoryLocation);
  const totalSeconds = timelineSeconds(snapshot);
  const pxPerSecond = timelinePxPerSecond(contentWidth, totalSeconds);
  const ticks = useMemo<Record<ProToolsRuler, ProToolsRulerTick[]>>(() => ({
    markers: [],
    barsBeats: barsBeatsRulerTicks(snapshot, contentWidth),
    timecode: linearRulerTicks(totalSeconds, contentWidth, formatTimecode, 102),
    minutesSeconds: linearRulerTicks(totalSeconds, contentWidth, formatMinutesSeconds, 96),
    samples: linearRulerTicks(
      totalSeconds,
      contentWidth,
      (seconds) => formatSamples(seconds, snapshot.session.sampleRate),
      92,
    ),
  }), [contentWidth, snapshot, totalSeconds]);
  const memoryLocations = useMemo(() => numberedMemoryLocations(snapshot), [snapshot]);
  const visible = RULERS.filter((ruler) => rulersVisible[ruler.id]);
  const seek = (position: number) => {
    void exec("set_transport", { position: Math.max(0, Math.min(totalSeconds, position)) });
  };

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    const position = event.detail === 0
      ? secondsAtScrollLeft(getScrollLeft(), contentWidth, totalSeconds)
      : secondsAtClientX(
          event.clientX,
          event.currentTarget.getBoundingClientRect().left,
          contentWidth,
          totalSeconds,
        );
    seek(position);
  };

  const onKeyDown = (ruler: ProToolsRuler, event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const position = useStore.getState().transport.position;
    if (event.key === "Home") return seek(0);
    if (event.key === "End") return seek(totalSeconds);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = nearestKeyboardTick(ticks[ruler], position, direction);
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
              aria-label={`${ruler.label} ruler, ${ruler.hint}. Click to place the playhead; use Left, Right, Home, or End to seek.`}
              onClick={onClick}
              onKeyDown={(event) => onKeyDown(ruler.id, event)}
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
        </div>
      </div>
    </section>
  );
}
