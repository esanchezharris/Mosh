export const meta = {
  name: 'polish-loop',
  description: 'Autonomous UI POLISH loop: self-identify genuinely-natural micro-polishes (conservative, taste-gated), implement each in an isolated worktree, open ONE PR per polish, and — when armed — auto-merge to main on a green cheap gate + a hostile adversarial review. Frontend-only, fail-closed, bounded.',
  whenToUse: 'Run locally (the owner triggers it) to polish the v2 UI a few PRs at a time. dryRun:true rehearses (identify→implement→PR→gate→review, NO merge); flip dryRun:false to arm auto-merge. Halt with docs/polish-loop/STOP.',
  phases: [
    { title: 'Identify', detail: 'scout fan-out → conservative curator (rubric + dedupe; STOP when nothing is genuinely natural)' },
    { title: 'Implement', detail: 'isolated worktree: minimal frontend-only polish + a test guard → cheap checks → draft PR' },
    { title: 'Merge', detail: 'serial queue: rebase + cheap gate (typecheck+vitest+e2e) + finalize/reject' },
    { title: 'Review', detail: 'hostile adversarial gatekeeper: a genuine in-scope polish, no scope-creep, no regressions' },
  ],
}

// ── config (override via Workflow args) ─────────────────────────────────────────
// args may arrive as an object OR a JSON-encoded string; accept both.
let _args = args
if (typeof _args === 'string') { try { _args = JSON.parse(_args) } catch (e) { _args = {} } }
const cfg = Object.assign({
  cycles: 3,           // hard cap on identify→ship cycles this run
  maxPerCycle: 1,      // polishes implemented per cycle (one polish = one PR)
  maxMerges: 3,        // hard cap on merges this run
  scouts: 4,           // parallel scout lenses per identify pass
  scope: 'visual-ux',  // 'a11y' | 'visual-ux' | 'discretion' — rubric breadth
  dryRun: true,        // true = identify+implement+PR+gate+review but DO NOT merge (rehearsal). FLIP to false to arm.
  ts: 'unset',         // caller-supplied timestamp (Date.now is banned in workflows)
}, (_args && typeof _args === 'object') ? _args : {})

const ROOT = 'scripts/auto-loop'                          // reuse the proven harness (worktrees, gate, merge-queue)
const RUN = 'cd "$(git rev-parse --show-toplevel)" &&'    // agents run shell from repo root
const slugOf = (s) => ('polish-' + String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).slice(0, 44)

// ── the rubric (the "don't go overboard" gate) ──────────────────────────────────
const SCOPE_NOTE = cfg.scope === 'a11y'
  ? 'SCOPE THIS RUN: a11y + objectively-missing states ONLY (focus-visible, reduced-motion, aria/label, disabled/active).'
  : cfg.scope === 'discretion'
  ? 'SCOPE THIS RUN: any genuinely-natural micro-polish under the rubric (curator discretion).'
  : 'SCOPE THIS RUN: visual + UX micro-polish — missing states (focus/hover/empty/loading/error), reduced-motion, aria, PLUS --v2-* token / spacing / radius / alignment consistency and subtle affordance tidies.'

const RUBRIC = `NATURAL-POLISH RUBRIC (the full text is docs/polish-loop/RUBRIC.md — obey it strictly).
${SCOPE_NOTE}
ALLOW (a "natural" polish): a SMALL, obviously-correct improvement to the EXISTING v2 UI (ui/src/v2/**) — a
missing-but-expected interactive/a11y state; an aria-label/role on an icon-only control; finishing an unfinished
empty/loading/error state; replacing a hardcoded value with the clearly-intended --v2-* token; an obvious
alignment / overflow / spacing nit.
DENY (going overboard — REJECT): any new feature / command / behavior change; backend / C++ / service change;
refactor / rename / file-move; dependency / build change; touching the hard-exclusion list (CMake, MoshEngine,
src/state, CLAUDE.md, specs 00-06, .github, deploy, relay/auth, gate scripts, docs/polish-loop/RUBRIC.md);
subjective redesign (new colours / layout / type); anything REDUNDANT with an existing affordance; > ~60 changed
lines or > 3 files; anything not provable by the cheap gate (typecheck + vitest + e2e).
Every polish is FRONTEND-ONLY (touch ui/ only) — the swappable seam: the C++ binary must stay byte-identical.
When in doubt, PREFER STOPPING over shipping a marginal/subjective change.`

const PRIME = `PRIME DIRECTIVES (never violate): the swappable seam — the UI couples to the backend ONLY via execute_command + snapshot/events; a UI-only change must NOT alter the C++ binary (touch ui/ only). Never weaken a gate (no deleted/skipped/.only tests, no lowered assertions). Never edit the loop's own rulebook (CLAUDE.md, specs 00-06, gate scripts, dependency pins, CI, docs/polish-loop/RUBRIC.md).`

// ── schemas ─────────────────────────────────────────────────────────────────────
const CAND = { type: 'object', required: ['title', 'files', 'why'], properties: {
  title: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
  why: { type: 'string', description: 'why this is a NATURAL micro-polish (not a feature/refactor/redundant)' },
  estLines: { type: ['integer', 'null'] }, acceptance: { type: 'string' } } }
const SCOUT_SCHEMA = { type: 'object', required: ['candidates'], properties: {
  candidates: { type: 'array', items: CAND } } }
const CURATE_SCHEMA = { type: 'object', required: ['stop', 'items'], properties: {
  stop: { type: 'boolean', description: 'true if NOTHING clears the rubric with high confidence (or the STOP sentinel is present)' },
  reason: { type: 'string' },
  items: { type: 'array', items: { type: 'object', required: ['id', 'title', 'files', 'acceptance'], properties: {
    id: { type: 'string' }, title: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'string' }, why: { type: 'string' } } } } } }
const IMPLEMENT_SCHEMA = { type: 'object', required: ['id', 'slug', 'ready'], properties: {
  id: { type: 'string' }, slug: { type: 'string' }, ready: { type: 'boolean', description: 'true iff a DRAFT PR was opened and the cheap checks pass' },
  prNumber: { type: ['integer', 'null'] }, summary: { type: 'string' }, reason: { type: 'string' } } }
const PREPARE_SCHEMA = { type: 'object', required: ['ready'], properties: {
  ready: { type: 'boolean' }, class: { type: 'string' }, excluded: { type: 'boolean' },
  baseSha: { type: ['string', 'null'] }, headSha: { type: ['string', 'null'] },
  reason: { type: 'string' }, gateSummary: { type: 'string' }, conflict: { type: 'boolean' } } }
const REVIEW_SCHEMA = { type: 'object', required: ['verdict', 'blockers'], properties: {
  verdict: { enum: ['APPROVE', 'REJECT'] }, blockers: { type: 'integer' }, reasons: { type: 'array', items: { type: 'string' } } } }
const FINAL_SCHEMA = { type: 'object', required: ['merged'], properties: {
  merged: { type: 'boolean' }, merge_sha: { type: ['string', 'null'] }, reason: { type: 'string' } } }

// ── prompt builders ─────────────────────────────────────────────────────────────
const SCOUT_LENSES = [
  'MISSING INTERACTIVE & A11Y STATES — controls with :hover but no :focus-visible; icon-only buttons without aria-label/title; missing disabled/active styling; tab/radio groups without focus indication.',
  '--v2-* TOKEN / SPACING CONSISTENCY — hardcoded px/colour/radius/font-size that should use an existing --v2-* design token in ui/src/v2/shell.css; values that break the established spacing rhythm.',
  'UNFINISHED EMPTY / LOADING / ERROR STATES — placeholders, lanes, drawers, lists or panels whose empty/loading/error state looks unfinished or terse vs the rest of the shell.',
  'REDUCED-MOTION & ALIGNMENT NITS — animations/transitions/transforms without a prefers-reduced-motion fallback; small alignment, overflow, or truncation glitches.',
]
function scoutPrompt(lens) {
  return `You are a tasteful UI polish SCOUT for the Mosh v2 shell (ui/src/v2/**). READ-ONLY.
Lens: ${lens}
${RUBRIC}
Inspect ui/src/v2/ (shell.css + the components: TopBar, Composer, RightRail, inspector/Inspector, lanes/TrackLaneList,
PluginBrowser, LeftDrawer, timeline/*, MoshMark, etc.) with grep/read. Propose 0–3 candidate polishes that fit your lens
AND clear the rubric. Be conservative — propose nothing rather than something marginal/subjective/redundant.
Report JSON ONLY: {candidates:[{title, files:[...], why, estLines, acceptance}]}. (acceptance = the automated check that would prove it: a vitest/e2e assertion.)`
}

function curatePrompt(candidatesJson, shippedTitles, maxPick) {
  return `You are the conservative CURATOR + de-duper for the Mosh autonomous POLISH loop. READ-ONLY.
Your job: from the scout candidates, pick AT MOST ${maxPick} genuinely-natural micro-polish(es) to ship as individual PRs —
or return stop:true when nothing clears the bar. Going overboard is the failure mode; STOPPING is always acceptable.
${RUBRIC}
${PRIME}

DEDUPE — do NOT pick anything already shipped or in flight. Check:
 - ${RUN} test -e docs/polish-loop/STOP && echo STOP || true   (if STOP is printed → return stop:true)
 - ${RUN} cat docs/polish-loop/polish-log.jsonl 2>/dev/null     (already-shipped polishes)
 - ${RUN} git log --oneline -40 | grep -i polish                (merged polish commits)
 - ${RUN} gh pr list --state all --search "polish in:title" --limit 30 --json number,title,state   (open/merged polish PRs)
 Already shipped this RUN (do not repeat): ${shippedTitles.length ? shippedTitles.join(' | ') : '(none yet)'}.

REJECT, with a one-line reason each, anything that: is a feature/refactor/behaviour change; touches the exclusion list
or anything outside ui/; is redundant with an existing affordance (e.g. a per-element drop hint when a full-surface
.v2-drop overlay already covers it); is subjective; exceeds ~60 lines / 3 files; or is a duplicate.

Candidates from the scouts:
${candidatesJson}

Rank the survivors by value/effort and return the top ${maxPick}. Report JSON ONLY:
{stop:<true if nothing qualifies / STOP present>, reason:"<why these / why stop>", items:[{id:"<short-kebab>", title, files:[...], acceptance, why}]}.`
}

function implementPrompt(item) {
  const slug = slugOf(item.id || item.title)
  return `You are implementing a single NATURAL UI POLISH for the Mosh v2 shell.
${PRIME}
${RUBRIC}

POLISH: "${item.title}"
Why it's natural: ${item.why || '(see title)'}
Acceptance (prove it with an automated check): ${item.acceptance || '(add a vitest/e2e assertion that fails before, passes after)'}
Likely files: ${(item.files || []).join(', ') || '(discover them under ui/src/v2/)'}

PROTOCOL:
 1. ${RUN} WT=$(${ROOT}/new-worktree.sh ${slug}); echo "$WT"  — your ISOLATED worktree (branch claude/auto-${slug}). Work ONLY there.
 2. ORIENT: read the target files; confirm the polish is real + not already present + NOT redundant with an existing affordance.
    If it turns out redundant/subjective/out-of-scope, STOP and report ready:false (reason). Going overboard is failure.
 3. Make the MINIMAL frontend-only change (touch ui/ ONLY — never compiled/CMake/native paths, never the exclusion list).
 4. Add a SMALL guard that proves it: a vitest unit or a Playwright e2e assertion (red before, green after). Do not weaken any test.
 5. CHEAP CHECKS:  cd "$WT/ui" && npm run typecheck && npm test && npm run test:e2e  — fix until all green.
 6. Self-review the diff against the rubric + prime directives; keep it within ~60 lines / ≤3 files.
 7. Commit on branch claude/auto-${slug} (message: "polish(v2/...): <what>"). Push: git -C "$WT" push -u origin claude/auto-${slug}.
 8. Open a DRAFT PR:  gh pr create --draft --base main --head claude/auto-${slug} --title "polish(v2/...): ${item.title}" --body "<what + why it's a natural polish, the guard, gate summary>".
Report JSON ONLY: {id:"${item.id}", slug:"${slug}", ready:true|false, prNumber:<n|null>, summary:"<1-2 lines>", reason:"<if not ready, why>"}.`
}

const preparePrompt = (it) => `${RUN} ${ROOT}/merge-one.sh prepare ${it.slug} ${it.prNumber} origin/main
Run EXACTLY that command. It rebases the branch onto origin/main, checks the hard-exclusion list, and runs the
authoritative CHEAP gate (typecheck + vitest + e2e). Return its JSON verbatim:
{ready, class, excluded, baseSha, headSha, reason, gateSummary, conflict}. Do not edit any files.`

function reviewPrompt(it, prep) {
  return `You are a HOSTILE release gatekeeper for an ${cfg.dryRun ? 'AUTO-MERGE REHEARSAL of' : 'UNATTENDED AUTO-MERGE to main of'} PR #${it.prNumber}
(polish: "${it.title}"). Find a reason to REJECT; assume guilty until proven safe. READ-ONLY (git show / git diff only).
${PRIME}
${RUBRIC}

Inspect the rebased diff:  ${RUN} git -C .claude/worktrees/auto-${it.slug} diff origin/main...HEAD
The cheap gate already passed: ${prep.gateSummary || '(see prepare)'}.

REJECT on ANY of: (1) NOT a genuine natural polish — it's a feature / behaviour change / refactor / redundant with an
existing affordance / subjective redesign; (2) touches anything outside ui/ (the swappable seam — a UI change must not
alter the C++ binary); (3) scope creep beyond the stated polish, or > ~60 lines / >3 files; (4) gate-weakening
(tests deleted/skipped/.only, assertions downgraded); (5) any added secret/token. DEFAULT TO REJECT on uncertainty —
a false reject just routes to a human (cheap); a bad auto-merge to main is costly. "Approve with fixes" = REJECT.
Return JSON ONLY: {verdict:"APPROVE"|"REJECT", blockers:<int>, reasons:[...]}.`
}

const finalizePrompt = (it, prep) => `${RUN} ${ROOT}/merge-one.sh finalize ${it.slug} ${it.prNumber} ${prep.baseSha} "APPROVE (polish-loop adversarial review)"
Run EXACTLY that command. It re-checks the kill switch + that origin/main is unmoved since ${prep.baseSha}, then
waits for main's required "cheap gate" status check and squash-merges (gh pr merge --squash — NOT
--admin, which cannot bypass a required check while enforce_admins is on), appends the shared ledger,
and removes the worktree. A red or absent check is fail-closed: finalize refuses to merge.
Return its JSON verbatim: {merged, merge_sha, reason}.`

const rejectAction = (it, sublabel, reason) =>
  agent(`${RUN} ${ROOT}/merge-one.sh reject ${it.slug} ${it.prNumber} ${sublabel} ${JSON.stringify(reason)}
Run EXACTLY that command (labels needs-human + ${sublabel}, comments, ledgers a REJECTED entry). Return its JSON.`,
    { label: `reject:${it.id}`, phase: 'Merge' })

// ════════════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ════════════════════════════════════════════════════════════════════════════════
let merges = 0, cycle = 0, dryRuns = 0, consecutiveFailures = 0
const merged = [], rejected = [], halts = [], shippedTitles = []

async function stopRequested() {
  const r = await agent(`${RUN} (test -e docs/polish-loop/STOP || test -e docs/auto-loop/STOP) && echo true || echo false
Report JSON: {stop:<true|false>}.`, { schema: { type: 'object', required: ['stop'], properties: { stop: { type: 'boolean' } } }, label: 'stop-check', phase: 'Identify' })
  return !!(r && r.stop)
}

// Process ONE drafted polish PR through the serial merge-queue. Returns 'merged'|'rejected'|'dry'.
async function mergeQueueOne(item) {
  const prep = await agent(preparePrompt(item), { schema: PREPARE_SCHEMA, phase: 'Merge', label: `prepare:${item.id}` })
  if (!prep) { await rejectAction(item, 'gate-red', 'prepare agent died'); rejected.push(item.id); return 'rejected' }
  if (prep.conflict) { await rejectAction(item, 'rebase-conflict', prep.reason || 'rebase conflict'); rejected.push(item.id); return 'rejected' }
  if (prep.excluded) { await rejectAction(item, 'out-of-scope', prep.reason || 'touches exclusion list / not ui-only'); rejected.push(item.id); return 'rejected' }
  if (!prep.ready) { await rejectAction(item, 'gate-red', prep.reason || 'cheap gate failed'); rejected.push(item.id); return 'rejected' }

  const review = await agent(reviewPrompt(item, prep), { schema: REVIEW_SCHEMA, phase: 'Review', label: `review:${item.id}`, effort: 'high' })
  if (!review || review.verdict !== 'APPROVE' || review.blockers !== 0) {
    await rejectAction(item, 'review-reject', (review && review.reasons ? review.reasons.join('; ') : 'review rejected / died'))
    rejected.push(item.id); return 'rejected'
  }

  if (cfg.dryRun) { log(`DRY-RUN: ${item.id} would MERGE (cheap gate green + review APPROVE). Draft PR #${item.prNumber} left open.`); dryRuns++; return 'dry' }

  const fin = await agent(finalizePrompt(item, prep), { schema: FINAL_SCHEMA, phase: 'Merge', label: `finalize:${item.id}` })
  if (fin && fin.merged) { merges++; consecutiveFailures = 0; merged.push(item.id); return 'merged' }
  await rejectAction(item, 'gate-red', fin ? (fin.reason || 'finalize failed') : 'finalize died')
  consecutiveFailures++; rejected.push(item.id); return 'rejected'
}

while (cycle < cfg.cycles && merges < cfg.maxMerges) {
  cycle++
  phase('Identify')
  if (await stopRequested()) { log('STOP sentinel present — halting gracefully.'); halts.push('stop-sentinel'); break }

  // SCOUT — parallel lenses over ui/src/v2 (read-only). Each proposes 0–3 candidates.
  const lenses = SCOUT_LENSES.slice(0, Math.max(1, cfg.scouts))
  const scouted = (await parallel(lenses.map((lens, i) =>
    () => agent(scoutPrompt(lens), { schema: SCOUT_SCHEMA, phase: 'Identify', label: `scout:c${cycle}.${i}` })
  ))).filter(Boolean).flatMap(r => r.candidates || [])
  log(`cycle ${cycle}: scouts proposed ${scouted.length} candidate(s)`)
  if (scouted.length === 0) { log('no candidates surfaced — nothing natural to do. Stopping.'); halts.push('nothing-found'); break }

  // CURATE — one conservative agent picks ≤ maxPerCycle or stops.
  const curated = await agent(curatePrompt(JSON.stringify(scouted, null, 0), shippedTitles, cfg.maxPerCycle),
    { schema: CURATE_SCHEMA, phase: 'Identify', label: `curate:c${cycle}`, effort: 'high' })
  if (!curated) { halts.push('curate-died'); break }
  if (curated.stop || !(curated.items || []).length) {
    log(`curator STOP: ${curated.reason || 'nothing clears the rubric'} — not going overboard. Halting.`)
    halts.push('curator-stop'); break
  }
  const picked = curated.items.slice(0, cfg.maxPerCycle).map(it => Object.assign({}, it, { slug: slugOf(it.id || it.title) }))
  picked.forEach(p => shippedTitles.push(p.title))
  log(`cycle ${cycle}: shipping ${picked.map(p => p.id).join(', ')}`)

  // IMPLEMENT — each agent makes its own worktree + draft PR.
  phase('Implement')
  const built = (await parallel(picked.map(it => () =>
    agent(implementPrompt(it), { schema: IMPLEMENT_SCHEMA, phase: 'Implement', label: `impl:${it.id}` })
      .then(r => r ? Object.assign({}, it, r) : null)
  ))).filter(Boolean)

  // SERIAL MERGE-QUEUE
  phase('Merge')
  for (const it of built) {
    if (await stopRequested()) { halts.push('stop-sentinel'); break }
    if (!it.ready || !it.prNumber) { log(`${it.id}: not ready (${it.reason || 'no PR'}) — skipping.`); continue }
    await mergeQueueOne(it)
    if (consecutiveFailures >= 3) { log('circuit-breaker: 3 consecutive merge failures — halting.'); halts.push('circuit-breaker'); break }
    if (merges >= cfg.maxMerges) break
  }
  if (halts.length) break
}

log(`polish-loop done. merged=${merged.length} rejected=${rejected.length} dryRuns=${dryRuns} cycles=${cycle} halts=${halts.join(',') || 'none'}`)
return { merged, rejected, dryRuns, cycles: cycle, halts, dryRun: cfg.dryRun, scope: cfg.scope }
