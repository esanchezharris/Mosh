# YingMusic-Singer-Plus — License Review

**Date:** 2026-08-14

**Status:** factual review complete; **not legal advice**. Distribution requires sign-off from someone qualified to give it.

**Trigger:** the owner's Round-3 decision recorded the YingMusic posture as *"potential product backend — promotion-eligible if quality passes, with a formal license review before distribution."* This is that review, done up front so a Phase-1 quality pass does not walk into a licensing surprise.

**Scope:** what the licenses say, what obligations attach, and what would have to be true to ship. It does not decide whether to ship.

---

## 1. The two licenses

Verified against the upstream repository, not a secondary summary.

| Component | License | Source |
| --- | --- | --- |
| Code and model weights | **CC BY 4.0** | `github.com/ASLP-lab/YingMusic-Singer-Plus`: *"The code and model weights in this project are licensed under CC BY 4.0"* |
| The VAE — weights **and** inference code, at `src/YingMusic-Singer/utils/stable-audio-tools` | **Stability AI Community License** | same repo: *"derived from Stable Audio Open by Stability AI, and are licensed under the Stability AI Community License"* |

**The project contradicts itself about which Stability model the VAE comes from, and this is unresolved.**

- The README says the VAE is *"derived from Stable Audio Open by Stability AI"*, and the repo ships `LICENSE-STABILITY` — verbatim *"STABILITY AI COMMUNITY LICENSE AGREEMENT, Last Updated: July 5, 2024"*, which is the licence Stable Audio Open 1.0 is released under.
- But `initialization.py` names the checkpoint **`stable_audio_2_0_vae_20hz_official.ckpt`**.

Those are different releases. Stable Audio Open 1.0's weights are publicly released under the Community License. **Stable Audio 2.0's are not released on that footing.** If the shipped VAE is genuinely from Stable Audio 2.0, the README's licence claim may not cover it — which would be an upstream problem rather than one Mosh created, but Mosh would inherit the exposure by distributing it.

Benign readings exist: the filename may be a misnomer, or may refer to the architecture lineage (both are built on the `stable-audio-tools` codebase) rather than the 2.0 release weights. I could not resolve it from the repository alone.

**Status: open, and it is now the review's most material unknown.** It does not affect Phase 1, which is internal research use. It must be resolved before distribution — by asking the upstream authors directly which checkpoint the VAE derives from, and getting the answer in writing.

*(This supersedes an earlier note in this document that "corrected" the component name to Stable Audio Open. That correction was premature — it trusted the README over the code.)*

**The VAE is not severable.** It is 156.1M of the model's 727.3M parameters (CFM 453.6M, VAE 156.1M, melody extractor 117.6M). There is no "ship the permissive part only" option — the VAE is how audio is encoded and decoded. The Stability terms therefore govern any shipped build, and they are the binding constraint. CC BY 4.0 is the *looser* of the two and is not what to plan around.

## 2. What the Stability AI Community License actually requires

Verified against the license text distributed with Stable Audio Open (agreement last updated 2024-07-05).

**Revenue gate.** Free for research, non-commercial, **and commercial** use *"unless you're using the Core Models for a commercial purpose and you or your organization generate over USD $1M (or local currency equivalent) of annual revenue, **regardless of the source of that revenue**."* Above that, an Enterprise license and registration with Stability AI are required.

Read that clause carefully: the trigger is **total organizational revenue from any source**, not revenue attributable to Mosh or to this feature. A profitable unrelated business line puts you over the line even if Mosh earns nothing.

**Attribution, on every distribution.** Two distinct obligations:

1. Retain, in a `NOTICE` text file distributed with the work: *"This Stability AI Model is licensed under the Stability AI Community License, Copyright © Stability AI Ltd. All Rights Reserved"*
2. *"prominently display 'Powered by Stability AI' on a related website, user interface, blogpost, about page, or product documentation."*

Obligation 2 is a **product-surface requirement**, not a legal-boilerplate one. Shipping this backend means "Powered by Stability AI" appears somewhere a user can see. That is a product decision, not only a compliance checkbox.

**Distributing a Derivative Work** additionally requires providing the full agreement to third parties, including the notice file, and — if the model is modified — adding your own attributions, marking which apply to the original materials, and documenting the changes.

**Outputs.** You own them and may use them at your discretion, with two limits: they may not be used to *"create or improve any foundational generative AI model (excluding the Models or Derivative Works)"*, and they remain subject to Stability's Acceptable Use Policy.

## 3. What CC BY 4.0 adds

CC BY 4.0 does not restrict commercial use. It requires attribution to the ASLP-lab authors, a link to the license, and an indication of whether changes were made. It is satisfied by ordinary third-party attribution in the app's licenses screen.

Worth noting rather than acting on: applying CC BY 4.0 to *model weights* is an unusual fit — the license was written for creative works and its notions of "adapted material" map awkwardly onto fine-tunes and quantizations. This creates ambiguity about whether a fine-tuned or quantized derivative must itself carry CC BY 4.0. It is not a blocker; it is a question to put to counsel if Mosh ever fine-tunes these weights rather than shipping them as-is.

## 4. Interaction with the "cloud qualify, local ship" decision

The owner's compute decision was: rent a box to qualify, but **only a local or owner-PC path may become the product backend.** That decision maximizes the licensing surface.

- **Phase 1 as planned — a rented box, internal evaluation, no distribution.** Comfortably inside the license. Nothing here needs resolving before Task 4.
- **Shipping locally — the intended end state.** Mosh would distribute the weights to end users. Full obligations attach: `NOTICE` file, "Powered by Stability AI" on a user-visible surface, the full agreement passed downstream, plus the revenue gate.
- **A hosted service instead.** Would avoid distributing weights, but the "Powered by Stability AI" display obligation still attaches to commercial use, and the revenue gate is unaffected.

There is no configuration in which the Stability attribution obligation disappears while the model is in the product.

## 5. What would have to be true to ship

Nothing here blocks Phase 1. All of it blocks distribution.

1. **Confirm Mosh's total annual revenue is under USD $1M**, counting all sources. If it is over — or expected to cross during the product's life — an Enterprise license and registration are required, and their cost is unknown and must be obtained from Stability before this backend is committed to.
2. **Accept "Powered by Stability AI" on a user-visible surface.** A product call, not a legal one.
3. **Ship a `NOTICE` file** carrying the required copyright line, and pass the full agreement downstream.
4. **Attribute ASLP-lab under CC BY 4.0** in the licenses screen, indicating any changes.
5. **The Acceptable Use Policy has now been reviewed — it does not block this feature.** See §5a.
6. **Have counsel confirm all of the above**, and specifically the CC-BY-4.0-on-weights ambiguity in §3 if Mosh fine-tunes rather than ships as-is.

## 5a. Acceptable Use Policy — reviewed, does not block

The AUP (as published, last updated 2025-07-31) is incorporated by reference and binds both use and outputs. It was the item most likely to contain a surprise. It does not.

**It contains no provision addressing voice cloning, voice synthesis, or generating a person's voice or likeness**, and no restriction specific to music, singing, or audio generation. The nearest applicable clause is the impersonation prohibition: *"Impersonation of others without consent or legal right, including defamatory content"*, together with a requirement to *"appropriately disclose when someone is interacting with AI where it is not apparent."*

For the feature as scoped, that clause is satisfied by construction. The scope lock is a performer completing **their own** vocal, from **their own** enrollment clip — the consent question the impersonation clause exists to police does not arise. Two things follow rather than block:

- **Keep the scope lock enforced in the product, not just the plan.** The AUP's protection here comes entirely from the fact that the voice is the user's own. A future feature that let a user enroll *someone else's* voice would land squarely inside the impersonation prohibition and would need its own consent mechanism.
- **The disclosure clause is live.** Rendered vocals should be identifiable as AI-rendered where that is not otherwise apparent. This is cheap to honor and is an ordinary product affordance.

Standing caveat: AUPs are updated unilaterally and this one is notably thin on voice — a domain regulators are actively moving on. Re-read it before shipping rather than relying on this snapshot.

## 6. Open questions

- **Enterprise license cost** is unpublished; only Stability can quote it.
- **Which entity's revenue counts** — the individual owner, a company, or both — is a fact about Mosh's structure, not about the license.
- The upstream README documents **Linux and Windows** environments and Python 3.10. It states no macOS or Apple Silicon path. That is an engineering constraint rather than a licensing one, but it bears on "local ship": the local target would be the owner's Windows/NVIDIA machine, not the canonical Apple Silicon build.

## 7. Bottom line

The licensing is **workable but not free of obligations**, and none of the obligations are hidden. Below $1M organizational revenue this is usable commercially, at the price of a visible "Powered by Stability AI" credit, a notice file, and downstream delivery of the agreement. Above $1M it requires a commercial negotiation whose cost is currently unknown.

The item that could have changed the answer — the Acceptable Use Policy's treatment of voice synthesis — has now been read, and does not block the feature as scoped (§5a). What remains is commercial and structural: confirm the revenue position, accept the visible credit, and have counsel sign off.

## Sources

- [YingMusic-Singer-Plus repository](https://github.com/ASLP-lab/YingMusic-Singer-Plus) — license statements for code, weights, and the VAE component
- [Stability AI license overview](https://stability.ai/license) — revenue threshold and commercial-use terms
- [Stable Audio Open license text](https://huggingface.co/stabilityai/stable-audio-open-1.0/blob/main/LICENSE.md) — attribution, notice, and Derivative Work obligations
- [Stability AI Acceptable Use Policy](https://stability.ai/use-policy) — impersonation and disclosure clauses (§5a)
