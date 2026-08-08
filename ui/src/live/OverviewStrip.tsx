// The arrangement overview strip (WIDGETS.md §1: ~11pt, between the control bar and
// the bar ruler — missing from SPEC §1 entirely). A read-only mini-arrangement:
// each clip is a solid colour block (track colour) on the dark strip; a hairline
// playhead tracks transport. Click jumps the playhead there AND scrolls the lanes
// to it — the one gesture Live's overview owns.

import { useStore } from "../store";
import { contentSeconds } from "../v2/timeline/geom";
import type { Snapshot } from "../types";

export function OverviewStrip({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const total = contentSeconds(snapshot);
  const tracks = snapshot.tracks.filter((t) => !t.isGroup && !t.isReturn);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sec = Math.max(0, Math.min(total, ((e.clientX - rect.left) / rect.width) * total));
    void exec("set_transport", { position: sec });
    const sc = document.querySelector<HTMLElement>(".live-lanes-scroll");
    if (sc) {
      const pps = useStore.getState().pxPerSec;
      sc.scrollLeft = Math.max(0, sec * pps - sc.clientWidth * 0.1);
    }
  };

  return (
    <div
      className="live-overview"
      data-testid="live-overview"
      role="button"
      tabIndex={0}
      aria-label="Arrangement overview — jump to a position"
      title="Overview — click to jump the playhead and the view"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const pos = useStore.getState().transport.position;
        const step = total / 100;
        void exec("set_transport", { position: Math.max(0, Math.min(total, pos + (e.key === "ArrowRight" ? step : -step))) });
      }}
    >
      {tracks.map((t, i) =>
        t.clips.filter((c) => !c.hidden).map((c) => (
          <div
            key={c.id}
            className="live-ov-block"
            data-testid="live-ov-block"
            data-clip-start={c.start}
            style={{
              left: `${(c.start / total) * 100}%`,
              width: `${Math.max(0.4, (c.length / total) * 100)}%`,
              top: `${(i / tracks.length) * 100}%`,
              height: `${100 / tracks.length}%`,
              background: t.color ?? "var(--live-text-dim)",
            }}
          />
        )),
      )}
      <OverviewPlayhead total={total} />
    </div>
  );
}

function OverviewPlayhead({ total }: { total: number }) {
  const pos = useStore((s) => s.transport.position);
  return (
    <div
      className="live-ov-play"
      data-testid="live-ov-playhead"
      style={{ left: `${Math.min(100, (pos / total) * 100)}%` }}
    />
  );
}
