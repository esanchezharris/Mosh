// The bar-number ruler. Draws bar lines + numbers from the canonical tempo map
// (time.ts gridLines) and seeks on click. Shares the seconds x-axis with the lanes.

import { useStore } from "../../store";
import type { Snapshot } from "../../types";
import { tempoMapFrom, gridLines } from "../../time";
import { contentSeconds } from "./geom";

export function BarRuler({ snapshot, width }: { snapshot: Snapshot; width: number }) {
  const exec = useStore((s) => s.exec);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const map = tempoMapFrom(snapshot.session);
  const total = contentSeconds(snapshot);
  const { bars } = gridLines(map, 0, total);
  // Label every bar when zoomed in, else thin out so numbers don't collide.
  const stride = pxPerSec >= 60 ? 1 : pxPerSec >= 32 ? 2 : 4;

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sec = Math.max(0, (e.clientX - rect.left) / pxPerSec);
    void exec("set_transport", { position: sec });
  };

  return (
    <div className="v2-ruler" style={{ width }} onClick={seek} data-testid="v2-ruler">
      {bars.map((b, i) => (
        <div key={b.label} className="v2-ruler-bar" style={{ left: b.sec * pxPerSec }}>
          {i % stride === 0 && <span className="v2-ruler-num">{b.label}</span>}
        </div>
      ))}
    </div>
  );
}
