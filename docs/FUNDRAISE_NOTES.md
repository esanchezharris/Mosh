# Fundraise notes — licence obligations that trigger on the round, not on revenue

*Owner-facing. Created by FS-K4 so the thresholds in
[`DEPENDENCY_BOM.md`](DEPENDENCY_BOM.md) §2 are recorded **where they will actually be read** —
at raise close — rather than only in a dependency table. The BOM stays the single source of
truth; this file points at it and says what to do on the day.*

---

## The one thing that surprises people

**JUCE and Tracktion count FUNDING as well as revenue.** Both licences define the tier by
"revenue **or** funding" in the trailing 12 months. A pre-revenue company that closes a round is
immediately in a paid tier — there is no grace period tied to shipping or earning anything.

Stability AI is the opposite: the Stable Audio 3 Community License caps on **revenue only**, so a
raise does **not** trip it. Do not conflate the two.

## Trigger table

| Round closes at | What becomes due | Cost | Notes |
|---|---|---|---|
| **≥ $20K** | JUCE 8 Indie | $40/mo or **$800 perpetual** | Prefer perpetual — see below |
| **≥ $50K** | Tracktion Engine Indie | $35/mo | Subscription only |
| **≥ $200K** | Tracktion Pro 1 | $50/mo | up to $400K |
| **≥ $300K** | **JUCE Pro** | **$3,500 perpetual** per seat, or $175/mo | Solo dev = 1 seat |
| **≥ $400K** | **Tracktion Pro 2** | $150/mo, 12-month commitment | up to $2M |
| **> $2M** | Tracktion Pro 3 | $300/mo | up to $10M |
| **> $1M revenue** | Stability AI Enterprise | negotiate | **revenue only — a raise does not trip this** |

Year-one licensing at a ~$1M raise lands around **$3.6–5.3K** depending on JUCE perpetual vs
subscription. Put it in the round's use-of-funds.

## Prefer the JUCE perpetual

JUCE's EULA §1.10 requires subscription seats to **stay active for as long as you distribute**.
A lapsed subscription does not just stop new builds — it undermines the licence covering the
copies already in users' hands. The $3,500 perpetual escapes that rule entirely. At Pro tier the
perpetual pays for itself in 20 months and removes a standing liability; buy it.

Tracktion has no perpetual option at any tier, so its subscription must simply stay live.

## The (A)GPL fallback is not an option

Worth stating explicitly so it is never re-litigated under time pressure: both JUCE and Tracktion
are dual-licensed with (A)GPL, and taking that branch would capture the whole conveyed
application. It is also self-defeating — the bundled model weights (CC BY-NC for RAVE, the
Stability Community License for SA3) are not GPL-compatible, so the copyleft branch cannot
lawfully ship the product anyway. Buy commercial.

## Day-of-close checklist

1. Purchase per the trigger table above, at the tier the **round size** puts you in.
2. Update the `Ship status` cells in [`DEPENDENCY_BOM.md`](DEPENDENCY_BOM.md) §1 with the purchase
   date and seat count — that table is what `service/scripts/packaging_check.py` generates the
   shipped `NOTICES.txt` from, so it is the thing that must stay true.
3. Re-run `python3 service/scripts/packaging_check.py --emit-notices` and ship a build, so the
   notices in users' hands match the licences actually held.
4. Confirm the two attribution lines are still required at the new tier. **Tracktion's free tiers
   require "Powered by Tracktion Engine"; the Pro tiers make it optional.** The packaging check
   asserts both attributions unconditionally today — if a Pro purchase makes one optional and you
   want it gone, that is an edit to `REQUIRED_ATTRIBUTIONS`, not something to quietly delete from
   the NOTICES file.

## Not funding-triggered, but adjacent

- **O4 / Stability registration.** SA3 commercial use must be registered at stability.ai (free) and
  the proxy must hold a *commercial* API key. That is what makes the "Powered by Stability AI"
  notice legally true rather than merely present. Independent of any raise; do it before external
  distribution.
- **JUCE splash screen.** JUCE 7's free tier required a splash; whether JUCE 8 Starter/Indie does
  was **not verified** in the BOM (§5 caveat). Check before shipping under a free tier — it is a
  branding change, not a packaging one.
