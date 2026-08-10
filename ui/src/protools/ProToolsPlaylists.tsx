import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import type { ClipTake, CommandResult, Track } from "../types";
import { ClipWave } from "../ui/clipRenderers";
import { PROTOOLS_PLAYLIST_ROW_HEIGHT, proToolsPlaylistRowCount } from "./trackViews";

type TakesInfo = {
  readonly takes: readonly ClipTake[];
  readonly currentTakeIndex: number;
};

type TakesData = {
  readonly takes?: ClipTake[];
  readonly currentTakeIndex?: number;
};

function takesData(result: CommandResult): TakesData | null {
  return result.ok && typeof result.data === "object" && result.data !== null
    ? result.data as TakesData
    : null;
}

export function ProToolsPlaylists({ track }: { readonly track: Track }) {
  const pxPerSec = useStore((state) => state.pxPerSec);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const setLastError = useStore((state) => state.setLastError);
  const clips = useMemo(() => track.clips.filter((clip) =>
    clip.type === "wave" && (clip.numTakes ?? 0) > 1), [track.clips]);
  const signature = clips.map((clip) =>
    `${clip.id}:${clip.numTakes}:${clip.currentTakeIndex ?? 0}`).join("|");
  const rows = proToolsPlaylistRowCount(track);
  const [infoByClip, setInfoByClip] = useState<Readonly<Record<string, TakesInfo>>>({});

  useEffect(() => {
    let cancelled = false;
    const epoch = projectEpoch;
    setInfoByClip({});
    void (async () => {
      const next: Record<string, TakesInfo> = {};
      for (const clip of clips) {
        const result = await useStore.getState().exec("list_takes", { clipId: clip.id });
        if (cancelled || useStore.getState().projectEpoch !== epoch) return;
        const data = takesData(result);
        if (!data?.takes) {
          if (!result.ok) setLastError(result.error ?? `Could not load playlists for ${clip.name}.`);
          continue;
        }
        next[clip.id] = {
          takes: data.takes,
          currentTakeIndex: data.currentTakeIndex ?? clip.currentTakeIndex ?? 0,
        };
      }
      if (!cancelled && useStore.getState().projectEpoch === epoch) setInfoByClip(next);
    })();
    return () => { cancelled = true; };
  }, [clips, projectEpoch, setLastError, signature]);

  const selectTake = async (clipId: string, takeIndex: number) => {
    const epoch = useStore.getState().projectEpoch;
    const result = await useStore.getState().exec("set_current_take", { clipId, takeIndex });
    if (useStore.getState().projectEpoch !== epoch) return;
    if (!result.ok) {
      setLastError(result.error ?? "The playlist could not be made current.");
      return;
    }
    setInfoByClip((current) => {
      const info = current[clipId];
      return info ? { ...current, [clipId]: { ...info, currentTakeIndex: takeIndex } } : current;
    });
  };

  if (rows === 0) return (
    <div className="pt-playlists is-empty" data-testid="pt-playlists" role="status">
      No alternate playlists on {track.name}
    </div>
  );

  return (
    <div className="pt-playlists" data-testid="pt-playlists" role="group"
      aria-label={`${track.name} playlists`}>
      {Array.from({ length: rows }, (_, takeIndex) => (
        <div key={takeIndex} className="pt-playlist-row" data-testid="pt-playlist-row"
          style={{ height: PROTOOLS_PLAYLIST_ROW_HEIGHT }}>
          {clips.filter((clip) => takeIndex < (clip.numTakes ?? 0)).map((clip) => {
            const info = infoByClip[clip.id];
            const take = info?.takes.find((candidate) => candidate.index === takeIndex);
            const currentTakeIndex = info?.currentTakeIndex ?? clip.currentTakeIndex ?? 0;
            const current = currentTakeIndex === takeIndex;
            const label = take?.description?.trim() || `Playlist ${takeIndex + 1}`;
            return (
              <button key={`${clip.id}:${takeIndex}`} type="button" className="pt-playlist-bar"
                data-testid="pt-playlist-bar" data-playlist-clip-id={clip.id}
                data-take-index={takeIndex} data-current={current}
                aria-pressed={current}
                aria-label={`${label} on ${track.name}${current ? ", current" : ""}`}
                title={current ? `${label} — current` : `Make ${label} current`}
                style={{ left: clip.start * pxPerSec, width: Math.max(32, clip.length * pxPerSec) }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => { if (!current) void selectTake(clip.id, takeIndex); }}>
                {take?.peaks && take.peaks.length > 0 && (
                  <span className="pt-playlist-wave" aria-hidden="true">
                    <ClipWave peaks={take.peaks} width={Math.max(24, clip.length * pxPerSec - 8)} />
                  </span>
                )}
                <span className="pt-playlist-label">{takeIndex + 1} · {label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
