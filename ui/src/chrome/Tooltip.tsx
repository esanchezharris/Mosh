// Themed tooltip — the other half of the chrome seam (see Menu.tsx for the rationale).
//
// Replaces native `title=""` attributes, which in a WebView are slow (OS delay), unstyled,
// and unreadable against Mosh's dark panels. Skin comes from the --tip-* tokens (mosh.css
// :root, re-pinned under .v2-shell) — the same dual-shell discipline as the --pr-* family.
//
// Usage:   <MoshTip label="What this does"><button …/></MoshTip>
// …and DELETE the title attribute — otherwise the native tooltip shows on top of this one.

import type { ReactElement, ReactNode } from "react";
import { Tooltip } from "@base-ui/react/tooltip";

/** One shared provider per shell root (AppV2 / AppLegacy): groups delays so sweeping
 *  across a toolbar shows the first tip after a beat and the rest instantly. */
export const MoshTipProvider = Tooltip.Provider;

export type MoshTipProps = {
  label: ReactNode;
  /** Where the tip opens relative to the trigger. Default "top". */
  side?: "top" | "bottom" | "left" | "right";
  /** A single element child — props and ref are merged onto it. */
  children: ReactElement;
};

export function MoshTip({ label, side = "top", children }: MoshTipProps) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={6} collisionPadding={8}>
          <Tooltip.Popup className="mosh-tip">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
