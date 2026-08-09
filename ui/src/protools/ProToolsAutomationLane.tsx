import { useMemo } from "react";
import { useStore } from "../store";
import type { Track } from "../types";
import { classifyProToolsIntent } from "./smartTool";
import { useProTools } from "./proToolsState";

interface Props {
  track: Track;
  width: number;
}

export function ProToolsAutomationLane({ track, width }: Props) {
  const exec = useStore((s) => s.exec);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const position = useStore((s) => s.transport.position);
  const smartToolEnabled = useProTools((s) => s.smartToolEnabled);
  const activeTool = useProTools((s) => s.activeTool);
  const setHoveredIntent = useProTools((s) => s.setHoveredIntent);
  const target = useMemo(() => {
    const plugin = [...(track.plugins ?? []), ...(track.mixerPlugins ?? [])]
      .find((candidate) => candidate.params.length > 0);
    const param = plugin?.params[0];
    return plugin && param ? { plugin, param } : null;
  }, [track.plugins, track.mixerPlugins]);

  const intentAt = (e: React.PointerEvent, gesture: "click" | "drag" = "drag") => {
    const rect = e.currentTarget.getBoundingClientRect();
    return classifyProToolsIntent({
      media: "automation",
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      edgeGrabPx: 0,
      meta: e.metaKey || e.ctrlKey,
      gesture,
      smartToolEnabled,
      activeTool,
    });
  };

  const addBreakpoint = (time: number, value: number) => {
    if (!target) return;
    void exec("add_automation_point", {
      trackId: track.id,
      pluginIndex: target.plugin.index,
      paramIndex: target.param.index,
      time,
      value,
    });
  };

  const addPointerBreakpoint = (e: React.PointerEvent<HTMLButtonElement>) => {
    const intent = intentAt(e, "click");
    setHoveredIntent(intent);
    if (intent !== "breakpoint" || !target) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const time = Math.max(0, (e.clientX - rect.left) / pxPerSec);
    const value = Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height));
    addBreakpoint(time, value);
  };

  const addKeyboardBreakpoint = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key !== "Enter" && e.key !== " ") || !target) return;
    e.preventDefault();
    setHoveredIntent("breakpoint");
    addBreakpoint(position, 0.5);
  };

  const points = (target?.param.points ?? []).slice().sort((a, b) => a.t - b.t);
  const path = points.map((point, index) => {
    const x = Math.max(0, point.t * pxPerSec);
    const y = 3 + (1 - point.v) * 20;
    return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");

  return (
    <button
      type="button"
      className="pt-automation-lane"
      data-testid="protools-automation-lane"
      data-track-id={track.id}
      disabled={!target}
      aria-keyshortcuts="Enter Space"
      aria-label={target
        ? `${track.name} automation, ${target.param.name}. Enter or Space adds a breakpoint at the playhead.`
        : `${track.name} automation, no target`}
      onPointerMove={(e) => setHoveredIntent(intentAt(e))}
      onPointerLeave={() => setHoveredIntent(null)}
      onPointerDown={addPointerBreakpoint}
      onKeyDown={addKeyboardBreakpoint}
      style={{ "--pt-track-color": track.color ?? "var(--pt-selected)" } as React.CSSProperties}
    >
      <svg width={width} height="100%" aria-hidden="true">
        {path && <path className="pt-automation-path" d={path} />}
        {points.map((point, index) => (
          <circle key={`${point.t}-${index}`} className="pt-automation-point"
            cx={point.t * pxPerSec} cy={3 + (1 - point.v) * 20} r="2.5" />
        ))}
      </svg>
      <span className="pt-automation-label">{target?.param.name ?? "Automation"}</span>
    </button>
  );
}
