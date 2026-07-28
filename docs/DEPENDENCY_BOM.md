# Mosh — Dependency & License BOM

**Status: VERIFIED 2026-07-12 against primary sources (EULA pages, LICENSE files, Hugging Face model
cards). Owned by Lane K (K4 of the First-Stranger Program spec). Not legal advice — counsel-check
items in §5. Prices and thresholds re-confirm at purchase. Longer clause excerpts live in the
2026-07-12 verification report (chat artifact); this doc carries paraphrase + pinpoint citations.**

---

## §0. The two facts that matter most

1. **A fundraise trips the audio-engine licenses even at $0 revenue.** Tracktion Engine (EULA
   definition 12.15 + tier text, engine.tracktion.com/agreement) and JUCE 8 (EULA §1.2.1,
   juce.com/legal/juce-8-licence) both define their tier caps over total money received by the whole
   entity — the operative phrase in both is "revenue or funding," and Tracktion's definition sweeps
   in anything "raised, donated towards, earned, or otherwise received." Stability's $1M cap, by
   contrast, is revenue-only (§2). Consequence: license upgrades are a line item in any raise's
   use-of-funds, triggered the day the round closes.

2. **RAVE cannot ship; keeping it in-tree is fine.** The RAVE repo LICENSE file
   (github.com/acids-ircam/RAVE) and the official pretrained-model cards are CC BY-NC 4.0. The
   NonCommercial test turns on whether the *use* is primarily directed toward commercial advantage —
   a VC-track startup's distributed app fails that test even if the app is free. CC obligations
   attach on *sharing*, so private, undistributed integration behind `-DMOSH_ENABLE_ANIRA=OFF`
   carries no obligation at all. Commercial path if ever wanted: license from IRCAM / IRCAM Amplify
   — real precedent exists (Qosmo licenses RAVE from IRCAM for Neutone).

---

## §1. Verified inventory

| Dependency | License (source read) | Ship status | Threshold trigger | Obligations |
|---|---|---|---|---|
| Tracktion Engine | Dual GPLv3 / commercial EULA (engine.tracktion.com/agreement + pricing page) | OK — Personal tier (≤$50K revenue-or-funding) | ≥$50K → Indie $35/mo · ≥$200K → Pro 1 $50/mo (≤$400K) · ≥$400K → Pro 2 $150/mo (≤$2M) · >$2M → Pro 3 $300/mo. Per seat; 12-mo commitment; subscription-only, no perpetual | Free tiers require "Powered by Tracktion Engine" display (Pro tiers optional). May ship apps; may never distribute the engine standalone |
| JUCE 8 | Dual AGPLv3 / JUCE 8 EULA (juce.com/legal/juce-8-licence, last mod 2025-07-17; live plan table) | OK — Starter (≤$20K revenue-or-funding) | ≥$20K → Indie $40/mo or $800 perpetual (≤$300K) · ≥$300K → Pro $175/mo or **$3,500 perpetual/seat** | §1.10: subscription seats must stay active while distributing → prefer perpetual at Pro. §1.12 "Products That Create Products" → counsel-check (§5). **JUCE 8 Indie caps at $300K; the $500K figure in older notes is JUCE 7 — stale** |
| RAVE (code + official weights) | CC BY-NC 4.0 (repo LICENSE; HF model cards) | **EXCLUDED from all distributed builds** (spec §1.11) | n/a | None while undistributed. K1 packaging check asserts absence of anira/RAVE artifacts and weights |
| Stable Audio 3 (small / medium / sfx) | Stability AI Community License + **Gemma Terms pass-through** for the T5Gemma component (HF model cards + stability.ai/community-license-agreement) | OK, with obligations met | **Revenue-only** (not funding) > $1M → license terminates; negotiate Enterprise *before* crossing | Register commercial use (free); bundle the Stability NOTICE text; display "Powered by Stability AI" (UI/about/docs); comply with Gemma use restrictions; outputs are fine to ship; may not use model/outputs to build competing foundation models (LoRAs/finetunes fine). **Verify the local MLX checkpoint descends from an official stabilityai release, not a third-party conversion** |
| ACE-Step 1.5 | MIT (HF card `ACE-Step/Ace-Step1.5` + repo LICENSE) | OK | none | Retain MIT notice. Card is explicitly commercial-friendly with licensed/royalty-free/synthetic training-data statement; responsible-use language is advisory. **Version note: ACE-Step v1 (3.5B) is Apache-2.0 — record which version ships** |
| SoulX-Singer | Apache-2.0 (HF card `Soul-AILab/SoulX-Singer` + repo) | OK | none | Retain LICENSE/NOTICE. Consent language advisory — Mosh's own-voice-only design complies in spirit; keep a voice-consent line in the tester agreement |
| Qwen3-30B-A3B | Apache-2.0 (HF card + repo LICENSE) | OK (adapter is local tooling; not bundled in the app) | none | Retain notices if a derivative ever distributes. **Not all Qwen generations are Apache — re-check the license field before adopting any other Qwen variant** |
| Sparkle 2 | MIT (sparkle-project.org + repo) | OK | none | Notice retention. **Actually ships as of FS-K2** — `Contents/Frameworks/Sparkle.framework` 2.9.4, pinned in `scripts/release/sparkle-pin.env`. This row's obligation is now live rather than hypothetical, and the framework carries no LICENSE file of its own, so the MIT text has to come from the NOTICES surface K4 generates from this table |
| sentry-native SDK | MIT (repo LICENSE). SDK only — Sentry *server* licensing differs and is irrelevant here | OK | none | Notice retention. Hosted sentry.io = standard SaaS; configure PII scrubbing on crash payloads before external builds |
| Opus (libopus) | 3-clause BSD + royalty-free patent grants (opus-codec.org/license) | OK | none | Notice retention. Do not copy code from the GPLv2 `opusinfo` tool |
| Supabase client libraries | MIT/Apache (clients) | OK | none | Nothing unusual |
| Cloudflare R2 / Workers | Standard commercial SaaS terms | OK | none | Nothing unusual for serving audio; zero-egress is the point |
| Anthropic / OpenAI APIs | Commercial Terms / Services Agreement | OK — token proxy is the intended model | n/a | §3 |

**Unverified — must not ship until a row exists here:** the parked FMS-stack models and tooling
(RMVPE, Seed-VC, RVC, g2p/CMUdict artifacts). FMS is parked, so this should be vacuous; the K1
packaging enumeration of the bundled `service/` payload is what keeps it vacuous.

---

## §2. Funding-trigger math (owner, at raise close)

- Raise ≥ **$300K** → **JUCE Pro.** Prefer $3,500 perpetual per seat (one-time) over $175/mo — the
  perpetual escapes the seats-must-stay-active-while-distributing rule. Solo dev = 1 seat.
- Raise ≥ **$400K** → **Tracktion Pro 2** ($150/mo, subscription-only, 12-month commitment).
  Raise > **$2M** → Pro 3 ($300/mo, ≤$10M).
- Year-one licensing at a ~$1M raise ≈ **$3.6–5.3K** depending on JUCE perpetual vs. subscription.
  Put it in the round's use-of-funds; it is funding-triggered, not revenue-triggered.
- **The (A)GPL fallback is non-viable** — copyleft would capture the whole conveyed app, and the
  bundled weights (CC BY-NC, Stability Community License) are not GPL-compatible. Buy commercial.

---

## §3. Provider API terms — the T1 token proxy

Serving many end users through the developer's own key via a proxy is expressly permitted by both
Anthropic (Commercial Terms §A.1: services may power products made available to the customer's own
users) and OpenAI (Services Agreement §2.2: the API may be integrated into customer applications
made available to end users). Conditions, wired into Lane T1:

1. The proxy holds a **commercial API key** — never a consumer subscription (Claude Pro/Max,
   ChatGPT). Routing third-party traffic through a consumer plan is prohibited.
2. Never hand the key itself to third parties; do not resell raw API access. A product built on the
   API is fine — that is the whole point of the terms.
3. Pass a **hashed, non-PII per-end-user identifier** on each call — Anthropic `metadata.user_id`,
   OpenAI `safety_identifier`. Recommended rather than mandatory, but it is the abuse-attribution
   mechanism that protects the account; the hashed T1 per-install UUID is exactly this. PII in these
   fields is rejected/prohibited.
4. Surface the provider output-reliability notice in Mosh's terms; bind testers to provider usage
   policies (one line in the tester agreement suffices at this stage).

---

## §4. Enforcement hooks (wired in Lane K)

> **WIRED 2026-07-27 (FS-K4).** Hooks 1 and 2 are now a blocking script, not a note:
> `service/scripts/packaging_check.py`, run fail-closed at the end of `./run-mosh.sh deploy`
> and before signing in `./run-mosh.sh release` (warn-only on the non-distributable
> `deploy-anira`). It generates `Contents/Resources/NOTICES.txt` **from the §1 table below**,
> so the shipped notices cannot drift from this document. Hermetic tests:
> `service/scripts/packaging_check_test.py`. Hook 4's thresholds are mirrored for the owner in
> [`FUNDRAISE_NOTES.md`](FUNDRAISE_NOTES.md).
>
> One caveat the check records rather than hides: `Contents/Resources/ui` ships third-party JS
> (React et al., inlined into `index.html` by Vite) with no §1 row. Those deps are MIT/BSD with
> no threshold or attribution condition, which is presumably why §1 was scoped to the
> licence-risky deps — but hook 2 says *anything* shipped needs a row, and this does not. Adding
> an npm-inventory row is BOM work, not packaging-check work.

1. **K1 packaging check (scripted, blocking):** no RAVE/anira artifacts or weights in the bundle;
   NOTICE/acknowledgements present for every §1 row that ships; "Powered by Stability AI" and
   "Powered by Tracktion Engine" visible on the acknowledgements surface.
2. **K1 payload enumeration:** list what the packaged `service/` payload actually bundles (weights,
   venvs, tools); anything shipped must have a §1 row.
3. **Owner (O4):** register SA3 commercial use at stability.ai (free); confirm the proxy key is a
   commercial API key.
4. **At-raise:** execute §2 the day the round closes; update this doc's tier rows with purchase
   dates and seat counts.

---

## §5. Counsel-check + caveats

- **JUCE 8 EULA §1.12 ("Products That Create Products"):** audio/MIDI files are exempt static
  content under the EULA's own definitions, so an agent-hosting DAW whose output is audio reads as
  out of scope — but the clause wording is broad. Get a written read before the raise closes. The
  risk edge would only appear if Mosh ever emits distributable *software* (e.g., generated plugins).
- **RAVE NonCommercial:** a judgment call, conservatively resolved as do-not-ship. Minor source
  discrepancy noted (repo LICENSE = BY-NC; the ACIDS projects page says BY-NC-SA) — moot while
  excluded; clarify with IRCAM if ever licensing.
- **JUCE free-tier splash:** JUCE 7 required a splash/watermark on free tiers; whether any such
  requirement survives in JUCE 8 Starter/Indie was not verified — confirm on juce.com during K1.
- **SA3 checkpoint provenance:** confirm the MLX weights in use descend from an official
  `stabilityai/stable-audio-3-*` release (Community License) rather than an unlicensed conversion.
- Prices/thresholds are as read on 2026-07-12; EULAs change — re-confirm at purchase. This document
  is verification and operations, not legal advice; §5 items go to counsel before the raise closes.
