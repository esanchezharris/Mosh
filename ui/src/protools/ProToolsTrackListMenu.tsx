import { MoshMenu, MoshMenuItem } from "../chrome/Menu";
import type { Track } from "../types";
import { IconCheck, IconLayers } from "../ui/icons";
import { useProTools } from "./proToolsState";

export function ProToolsTrackListMenu({ tracks }: { readonly tracks: readonly Track[] }) {
  const trackVisibility = useProTools((state) => state.trackVisibility);
  const setTrackShown = useProTools((state) => state.setTrackShown);

  return (
    <MoshMenu label="Track visibility" align="start" trigger={
      <button type="button" className="pt-track-list-menu-trigger"
        data-testid="pt-track-visibility-menu" aria-label="Track visibility"
        disabled={tracks.length === 0}>
        <IconLayers size={12} />
      </button>}>
      <div className="pt-menu pt-track-visibility-menu" data-testid="pt-track-visibility-options">
        {tracks.map((track) => {
          const shown = trackVisibility[track.id] !== false;
          return (
            <MoshMenuItem key={track.id} testId={`pt-track-visibility-${track.id}`}
              ariaLabel={`${shown ? "Hide" : "Show"} ${track.name} track`}
              onPick={() => setTrackShown(track.id, !shown)}>
              <span className="pt-track-visibility-state" data-shown={shown} aria-hidden="true">
                {shown ? <IconCheck size={12} /> : null}
              </span>
              <span className="pt-track-visibility-name">{track.name}</span>
            </MoshMenuItem>
          );
        })}
      </div>
    </MoshMenu>
  );
}
