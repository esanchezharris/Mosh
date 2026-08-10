import { MoshTip } from "../chrome/Tooltip";
import { useProTools } from "./proToolsState";
import { toggleProToolsTimelineEditLink } from "./proToolsTimelineSelection";

export function ProToolsSelectionLinkControl() {
  const linked = useProTools((state) => state.timelineEditLinked);
  const tip = linked
    ? "Unlink Timeline playback from Edit selection · Shift+/"
    : "Link Timeline playback to the current Edit selection · Shift+/";
  return (
    <MoshTip side="bottom" label={tip}>
      <button type="button" className="pt-smart-button" data-testid="pt-selection-link"
        aria-label="Link Timeline and Edit Selection" aria-pressed={linked}
        onClick={toggleProToolsTimelineEditLink}>Link T/E</button>
    </MoshTip>
  );
}
