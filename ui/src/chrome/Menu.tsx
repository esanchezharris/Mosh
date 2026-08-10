// The chrome seam (pilot, 2026-08-06 — see docs/2026-08-06-prebuilt-ui-components-spike.md).
//
// Mosh's hand-rolled overlays kept re-learning the same lessons (measured-rect placement
// in anchorPanel.ts, the scroll-race of #615, the backdrop-filter containing-block portal
// workaround in TopbarTools, the shared Escape stack). Base UI already solved all of them
// — placement via Floating UI, focus/keyboard/typeahead, layer stacking — so generic chrome
// (menus, tooltips, popovers, dialogs) routes through THIS thin wrapper and the library
// never touches the app anywhere else. Musical surfaces stay custom.
//
// Everything visual still comes from Mosh tokens: the library owns BEHAVIOUR, the CSS
// classes passed here own the skin, and the two never mix. If Base UI is ever swapped,
// this file is the only edit site.

import type { ReactElement, ReactNode } from "react";
import { useState } from "react";
import { Menu } from "@base-ui/react/menu";

export type MoshMenuProps = {
  /** The always-rendered trigger element (a plain <button> — props and ref are merged on). */
  trigger: ReactElement;
  /** Accessible name for the menu popup (it carries role="menu"). */
  label: string;
  /** Edge alignment against the trigger. Default "start". */
  align?: "start" | "center" | "end";
  children: ReactNode;
};

/**
 * A dropdown action menu. Replaces the useAnchoredPanel pattern: Floating UI's Positioner
 * flips above the trigger when there is no room below and clamps into the viewport —
 * sideOffset 8 and collisionPadding 8 are the old anchorPanel.ts kPanelGap/kViewportMargin.
 * Escape closes it, clicking an item closes it, scroll re-anchors it to the trigger
 * (the panel follows instead of being dismissed — it can no longer detach).
 */
export function MoshMenu({ trigger, label, align = "start", children }: MoshMenuProps) {
  // WKWebView desync guard (2026-08-06, reproduced live in the packaged app): Base
  // UI's uncontrolled Root keeps per-root open/trigger state across a close. When an
  // async re-render lands inside the close sequence — the native bridge's snapshot
  // push after a pick, a timing the synchronous mock (and Chromium) never produces —
  // the Root can be left believing it is OPEN with nothing rendered: the next click
  // then "closes" an invisible menu, and the popup appears to never reopen (verified
  // on a stuck instance: click 1 nothing, click 2 opened — a hidden toggle). Nothing
  // in the library re-asserts the state, so it survives indefinitely. Remounting the
  // Root on every close makes cross-close residue impossible by construction; the
  // trigger re-renders identically, so the remount is invisible to the user.
  const [closeCycle, setCloseCycle] = useState(0);
  return (
    <Menu.Root key={closeCycle} onOpenChange={(open) => { if (!open) setCloseCycle((c) => c + 1); }}>
      <Menu.Trigger render={trigger} />
      <Menu.Portal>
        <Menu.Positioner side="bottom" align={align} sideOffset={8} collisionPadding={8}>
          <Menu.Popup className="v2-menu-panel-floating" aria-label={label}>
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export type MoshMenuItemProps = {
  onPick: () => void;
  testId?: string;
  /** Required when the visible content is split across spans/icons (screen readers
   *  would otherwise announce the row unnamed). */
  ariaLabel?: string;
  children: ReactNode;
};

/** One action row. Renders a real <button> so the existing .v2-menu styles apply;
 *  the library adds role="menuitem", keyboard highlight, and typeahead. */
export function MoshMenuItem({ onPick, testId, ariaLabel, children }: MoshMenuItemProps) {
  return (
    <Menu.Item
      render={<button type="button" />}
      nativeButton
      data-testid={testId}
      aria-label={ariaLabel}
      onClick={onPick}
    >
      {children}
    </Menu.Item>
  );
}
