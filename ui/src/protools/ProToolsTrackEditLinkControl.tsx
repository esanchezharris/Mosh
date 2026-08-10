import { MoshTip } from "../chrome/Tooltip";
import { useProTools } from "./proToolsState";
import { toggleProToolsTrackEditLink } from "./proToolsTrackEditSelection";

export function ProToolsTrackEditLinkControl() {
  const linked = useProTools((state) => state.trackEditLinked);
  const tip = linked
    ? "Unlink track selection from the Edit selection · Shift+T"
    : "Link the selected track to the current Edit selection · Shift+T";
  return (
    <MoshTip side="bottom" label={tip}>
      <button type="button" className="pt-smart-button" data-testid="pt-track-edit-link"
        aria-label="Link Track and Edit Selection" aria-pressed={linked}
        onClick={toggleProToolsTrackEditLink}>Link Tr/E</button>
    </MoshTip>
  );
}
