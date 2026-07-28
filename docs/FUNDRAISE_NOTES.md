# Fundraise notes — licensing actions at raise close

*Owner-facing. Created by FS-K4 so the funding-triggered licensing obligations are recorded
**where you will actually look at raise time**, not only inside a dependency inventory.*

**The numbers live in [`DEPENDENCY_BOM.md`](DEPENDENCY_BOM.md) §1–§2 and are not duplicated here** —
duplicated thresholds drift, and the BOM is the verified, source-read document. This file is the
checklist that points at them.

---

## Why this exists

Two of Mosh's load-bearing dependencies are licensed on **funding**, not revenue. They are free
today and stop being free the day a round closes — with no product change, no usage change, and no
warning from the vendor. A raise that closes without these lines in the use-of-funds is a raise that
has quietly created an unbudgeted, immediate obligation.

The third (Stable Audio 3) is **revenue**-triggered, which is a different clock — do not fold it into
the raise math.

---

## At raise close — do these in order

- [ ] **Re-read [`DEPENDENCY_BOM.md`](DEPENDENCY_BOM.md) §2** before signing the round. It carries the
      current thresholds, the perpetual-vs-subscription math, and the year-one estimate.
- [ ] **JUCE** — crossing the §2 raise threshold moves the project off the free tier. §2 recommends
      the **perpetual** seat over the monthly one, specifically because a subscription seat must stay
      active for as long as you distribute; a perpetual licence does not. Solo dev = 1 seat.
- [ ] **Tracktion Engine** — crossing its §2 threshold moves to Pro, which is **subscription-only
      with a 12-month commitment**. There is no perpetual escape here, so it is a recurring line.
- [ ] **Put year-one licensing in the round's use-of-funds.** §2 sizes it. It is funding-triggered,
      so it is due because the round closed, not because Mosh started earning.
- [ ] **Do not consider the (A)GPL fallback.** §2 is explicit: copyleft would capture the whole
      conveyed app, and the bundled weights (CC BY-NC, Stability Community License) are not
      GPL-compatible. Buy the commercial licences.
- [ ] **Re-run the packaging check** after any tier change — `./run-mosh.sh deploy` runs it
      automatically, or `python3 service/scripts/packaging_check.py --bundle /Applications/Mosh.app`.
      Moving Tracktion to a Pro tier makes the *"Powered by Tracktion Engine"* credit optional rather
      than mandatory; the check reads the BOM, so **update the BOM row first** and the shipped
      NOTICES follow automatically.

## Not part of the raise math

- [ ] **Stable Audio 3 is revenue-triggered, not funding-triggered** (§1/§2). A large raise does not
      trip it; crossing the revenue cap does, and at that point the licence *terminates* — so
      negotiate Enterprise **before** crossing rather than after.
- [ ] **Register SA3 commercial use** at stability.ai (free, minutes) — this is owner task **O4** in
      the First-Stranger SPEC §3, and it is what makes the shipped *"Powered by Stability AI"* notice
      legally true. The packaging check can only assert the string is **present**; it cannot assert
      you registered.

---

## What is already automated

FS-K4 wired the compliance half into the deploy path, so the parts a script *can* own are not on this
list:

- `docs/DEPENDENCY_BOM.md` §1 is the single source of truth for shipped dependencies.
- `service/scripts/packaging_check.py --emit-notices` generates `Contents/Resources/NOTICES.txt`
  from that table during `bundle_service`, so acknowledgements cannot drift from the inventory.
- `packaging_check.py --bundle` then blocks `deploy` and `release` if a shipping row is
  unacknowledged, a mandatory attribution is missing, RAVE/anira artifacts are present (SPEC §1.11),
  or third-party payload ships with no BOM row.

**Licensing tiers are the part that cannot be automated** — they depend on a number only you know at
close. Hence this file.
