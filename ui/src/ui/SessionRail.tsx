// The right rail in the redesign shell: a "Session / people" panel. Participants
// (Moshi + collaborators) on top, the selected-track Inspector below. Open by
// default so the agent + room are present; collapsible for more arrange space.
import type { Snapshot } from "../types";
import { Participants } from "./Participants";
import { Inspector } from "./Inspector";

export function SessionRail({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="session-rail" data-testid="session-rail">
      <Participants />
      <Inspector snapshot={snapshot} />
    </div>
  );
}
