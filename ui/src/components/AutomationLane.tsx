import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { Track, CommandResult } from "../types";

// An automation lane (Stage 22): the visible/editable curve under a track.
// Reads existing curves via get_automation; every edit commits the FULL point
// list through write_automation (lane-replace semantics — one undo step per
// gesture, same rule as the piano roll). Slides written in S20 show up here.

export type LaneTarget = {
  mixer?: "volume" | "pan";
  pluginIndex?: number;
  paramName?: string;
  label: string;
};

type Point = { beats: number; value: number; curve?: number };
type Lane = { mixer?: string; pluginIndex?: number; paramName?: string; label: string; points: Point[] };

export const AUTO_H = 56;

const targetKey = (t: LaneTarget) =>
  t.mixer ? `mixer:${t.mixer}` : `plug:${t.pluginIndex}:${t.paramName}`;

export function laneTargets(track: Track): LaneTarget[] {
  const out: LaneTarget[] = [
    { mixer: "volume", label: "volume" },
    { mixer: "pan", label: "pan" },
  ];
  for (const p of track.plugins ?? [])
    for (const prm of p.params)
      out.push({ pluginIndex: p.index, paramName: prm.name, label: `${p.name} · ${prm.name}` });
  return out;
}

export function AutomationLane({
  track,
  widthPx,
  pxPerSec,
  target,
}: {
  track: Track;
  widthPx: number;
  pxPerSec: number;
  target: LaneTarget;
}) {
  const exec = useStore((s) => s.exec);
  const secsPerBeat = useStore((s) => s.secsPerBeat);
  const snapshot = useStore((s) => s.snapshot);
  const [points, setPoints] = useState<Point[]>([]);
  const dragIdx = useRef<number | null>(null);
  const laneRef = useRef<HTMLDivElement>(null);

  const spb = secsPerBeat();
  const key = targetKey(target);

  const fetchLanes = useCallback(async () => {
    const res = (await exec("get_automation", { trackId: track.id })) as CommandResult<{ lanes: Lane[] }>;
    if (!res.ok || !res.data) return;
    const lane = res.data.lanes.find((l) =>
      target.mixer
        ? l.mixer === target.mixer
        : l.pluginIndex === target.pluginIndex && l.paramName === target.paramName,
    );
    setPoints(lane?.points ?? []);
  }, [exec, track.id, key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refetch when the snapshot changes (commands invalidate → curves may move).
  useEffect(() => {
    void fetchLanes();
  }, [fetchLanes, snapshot]);

  const commit = (pts: Point[]) => {
    const sorted = [...pts].sort((a, b) => a.beats - b.beats);
    setPoints(sorted);
    const targetArgs = target.mixer
      ? { mixer: target.mixer }
      : { pluginIndex: target.pluginIndex, paramName: target.paramName };
    if (sorted.length === 0) void exec("clear_automation", { trackId: track.id, ...targetArgs });
    else void exec("write_automation", { trackId: track.id, ...targetArgs, points: sorted });
  };

  const toXY = (p: Point) => ({ x: p.beats * spb * pxPerSec, y: (1 - p.value) * (AUTO_H - 8) + 4 });
  const fromXY = (x: number, y: number): Point => ({
    beats: Math.max(0, x / pxPerSec / spb),
    value: Math.max(0, Math.min(1, 1 - (y - 4) / (AUTO_H - 8))),
  });

  const onLaneDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== laneRef.current) return;
    const rect = laneRef.current.getBoundingClientRect();
    const p = fromXY(e.clientX - rect.left, e.clientY - rect.top);
    commit([...points, p]);
  };

  const onPointDown = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragIdx.current = i;
  };
  const onPointMove = (e: React.PointerEvent) => {
    const i = dragIdx.current;
    if (i == null || !laneRef.current) return;
    const rect = laneRef.current.getBoundingClientRect();
    const p = fromXY(e.clientX - rect.left, e.clientY - rect.top);
    setPoints((pts) => pts.map((pt, j) => (j === i ? { ...pt, ...p } : pt)));
  };
  const onPointUp = () => {
    if (dragIdx.current == null) return;
    dragIdx.current = null;
    commit(points);
  };

  const poly = points
    .map((p) => {
      const { x, y } = toXY(p);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div
      className="autolane"
      ref={laneRef}
      style={{ width: widthPx, height: AUTO_H }}
      onPointerDown={onLaneDown}
    >
      <svg className="autolane-svg" width={widthPx} height={AUTO_H}>
        {points.length > 0 && <polyline points={poly} fill="none" />}
      </svg>
      {points.map((p, i) => {
        const { x, y } = toXY(p);
        return (
          <span
            key={i}
            className="autopoint"
            style={{ left: x - 4, top: y - 4 }}
            title={`${p.beats.toFixed(2)}b · ${(p.value * 100).toFixed(0)}%`}
            onPointerDown={onPointDown(i)}
            onPointerMove={onPointMove}
            onPointerUp={onPointUp}
            onDoubleClick={(e) => {
              e.stopPropagation();
              commit(points.filter((_, j) => j !== i));
            }}
          />
        );
      })}
      {points.length === 0 && <span className="autolane-hint">click to add automation points</span>}
    </div>
  );
}
