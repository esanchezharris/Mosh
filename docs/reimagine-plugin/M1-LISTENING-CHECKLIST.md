# Re-Imagine M1: listening checklist (owner, Live 12)

For your hands-on hours. Everything automated has run elsewhere. This checklist covers
what only your ears, your Mac and Live can answer. Write results into the "Log" column
and into [M1-GARY-COMPARISON.md](M1-GARY-COMPARISON.md). A blank means not done, not
"failed".

Before you start: the plug-in is installed from current `main`
(`scripts/install-owner-reimagine-plugin.sh`), the helper's SA3 is the local MLX
Medium, and Gary's own app is closed while Mosh renders (both load SA3).

## A. Set up (10 min)

| # | Step in Live | What to check | Log |
|---|---|---|---|
| A1 | New Set, 120 BPM, 4/4. Audio track with your 8-bar keys phrase (your own, authorized). Insert **Mosh Re-Imagine** on it. | Plug-in opens; window shows "Claude writes the prompt" beside the intention heading. | |
| A2 | Stopped: **Transfer**, then play the 8 bars, then stop. | Status says "Transfer ready". The region spans the 8 bars. | |
| A3 | Context: key (e.g. `F minor`), chords as `1:Fm7 3:Db 5:Ab 7:Eb` (yours), section `Verse`, protected `chord-change timing`. **Save context**. | No error. The report shows tempo 120.00 BPM (host). | |

## B. Template path, then Claude path (20 min each)

Do B1-B4 with the planner **off**, then repeat with it **on**. If you want the comparison
to be fair, alternate which goes first on your next session.

| # | Step | Listen for | Log |
|---|---|---|---|
| B1 | Type the request: "Turn these eight bars of keys into a hazy sampled-keyboard loop. Follow the supplied chord changes and make the performance less busy." 2 candidates, **Generate**. Stopwatch from click to the first candidate you can hear. | Seconds to first audible. Does the status say "Planned by claude-opus-5-5" (planner on) or "Prompt by: template" (off)? | seconds: |
| B2 | Play the region with each candidate selected (takes menu). Use **Dry A/B** to compare with your source at the same position. | Hazy/sampled texture? Fewer notes? Do the chord changes land where yours do? Any clicks at the region edges, timing drift by bar 8, level jump? | keep/reject per candidate: |
| B3 | Select the closer one. Revision: "Roughen the texture, but preserve the chord-change timing." From selected audio on. **Revise**. | Rougher? Changes still on the same bars? Did it drift away from B? | keep/reject per revision: |
| B4 | Report column (bottom right): read "Prompt by", "Planner: not enforceable", "Tempo conformance (technical)". | Does what Claude wrote (or the template) match what you asked? Is the not-enforceable list honest? | |

## C. Keep, export, conform, preview (10 min)

| # | Step | Check | Log |
|---|---|---|---|
| C1 | **Keep** your best version. **Drag WAV** into a new Live audio track at bar 1. | It lands where you drop it (placement is yours, not Mosh's). Mute the Mosh track and play both: same audio, no doubling while one is muted. | |
| C2 | **Export**. Open `~/Music/Mosh Exports`. | A WAV plus a JSON sidecar; the WAV plays in Finder. | |
| C3 | If a version reports "drifts N ms per bar", **Conform tempo**. | It makes a new version "conform of vN". Listen for SoundTouch artefacts (smearing, flamming). The end of the region is silent or music, never your dry source. | |
| C4 | Stop Live. **Free preview**. Then press Play in Live. | Preview is audible while stopped; it stops the moment Live plays; you never hear two copies. | |

## D. Save, reopen, safety (10 min)

| # | Step | Check | Log |
|---|---|---|---|
| D1 | Save the Set, quit Live, reopen. | Versions, the kept one, context and the planner switch come back; audio loads. | |
| D2 | Change the Set tempo to 100 BPM and play. | The region goes stale and plays dry (no stretched or misaligned version). Report says re-transfer. Set it back to 120. | |
| D3 | Change Live's buffer size or sample rate while a Transfer has just stopped. | The Transfer is still saved (status "Transfer ready"), not lost. | |

## E. What to send back

- The filled comparison sheet ([M1-GARY-COMPARISON.md](M1-GARY-COMPARISON.md)).
- `~/Library/Mosh/ReImagine/experience.jsonl` and
  `~/Library/Mosh/ReImagine/planner-ledger.jsonl` (no audio inside; check before sharing).
- One line per surprise: what you did, what you heard, what you expected.

What this cannot tell us yet: whether the planner is better than the template in
general (one session is an anecdote), or anything about M2 evaluators.
