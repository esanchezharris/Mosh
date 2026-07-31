export const meta = {
  name: 'stranger-loop',
  description: 'First-Stranger Program loop: drive the program lanes (T/K/S/B/ST) through worktrees — plan each lane, verify the gap, implement, run the full LOCAL gate + hostile review, then AUTO-MERGE only safe (docs/ui/service-py) diffs and route every high-stakes lane (engine/auth/packaging/relay/state) to an owner-merge PR. Fail-closed. Never auto-merges high-stakes work.',
  whenToUse: 'Run locally on the Mac to work docs/first-stranger-program/backlog.jsonl. Auto-merges ONLY safe classes to main; everything else becomes a gated, reviewed, owner-merge PR. Start planOnly:true or dryRun:true to rehearse.',
  phases: [
    { title: 'Preflight', detail: 'seed dep cache + (unless planOnly) selftest baseline on main' },
    { title: 'Load', detail: 'read ready program backlog + check STOP (program OR shared)' },
    { title: 'Plan', detail: 'per lane: verify the gap still exists + write a gate-registered plan (spec §0)' },
    { title: 'Implement', detail: 'parallel worktrees: §0-bound implement (may touch engine/auth) → draft PR' },
    { title: 'Merge', detail: 'serial queue: prepare + gate + review → auto-merge SAFE / route-owner HIGH-STAKES' },
    { title: 'Dashboard', detail: 'regenerate the owner-blocker STATUS.md' },
  ],
}

// ── config (override via Workflow args) ─────────────────────────────────────────
let _args = args
if (typeof _args === 'string') { try { _args = JSON.parse(_args) } catch (e) { _args = {} } }
const cfg = Object.assign({
  maxItems: 3,            // implement agents per cycle (≤ concurrency cap)
  maxNativeInFlight: 1,   // cap parallel native items (bounds the serial build queue)
  maxMerges: 8,           // hard cap on SAFE auto-merges this run
  maxCycles: 6,           // hard cap on cycles
  dryRun: true,           // true = gate + review but DO NOT finalize/route (rehearsal). FLIP to false to arm.
  planOnly: false,        // true = Preflight(light) → Load → Plan → Dashboard, then STOP (no implement/merge)
  allowNative: true,      // the program needs native gates; native lanes route to owner, never auto-merge
  baselineN: null,        // if set, skip the heavy preflight baseline build
  ts: 'unset',            // caller-supplied timestamp string (Date.now is banned in workflows)
}, (_args && typeof _args === 'object') ? _args : {})

const ROOT = 'scripts/auto-loop'
const PROG = 'docs/first-stranger-program'
// Point the shared scripts at the PROGRAM backlog + ledger, and enable stranger mode so
// merge-one.sh gates (rather than auto-rejects) exclusion-list diffs. Exported into every
// shell so discover.sh / merge-one.sh (which source lib.sh) pick them up.
const RUN = `cd "$(git rev-parse --show-toplevel)" && export MOSH_STRANGER_MODE=1 AL_BACKLOG_JSONL="$PWD/${PROG}/backlog.jsonl" AL_LEDGER="$PWD/${PROG}/LEDGER.md" AL_PROGRAM_STOP="$PWD/${PROG}/STOP" &&`

const slugOf = (id) => String(id).toLowerCase().replace(/[^a-z0-9._-]/g, '-')

// ── schemas ─────────────────────────────────────────────────────────────────────
const PREFLIGHT_SCHEMA = { type: 'object', required: ['ok', 'baseline'], properties: {
  ok: { type: 'boolean' }, baseline: { type: ['integer', 'null'] }, detail: { type: 'string' } } }

const READY_SCHEMA = { type: 'object', required: ['stop', 'items'], properties: {
  stop: { type: 'boolean' },
  items: { type: 'array', items: { type: 'object', required: ['id'], properties: {
    id: { type: 'string' }, title: { type: 'string' }, lane: { type: 'string' },
    class: { enum: ['cheap', 'native'] }, size: { type: 'string' }, order: { type: 'number' },
    ownerMerge: { type: 'boolean' }, blockedOn: { type: 'string' },
    acceptance: { type: 'string' }, notes: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    skills: { type: 'array', items: { type: 'string' } } } } } } }

const PLAN_SCHEMA = { type: 'object', required: ['id', 'planned', 'gapExists'], properties: {
  id: { type: 'string' }, planned: { type: 'boolean' }, gapExists: { type: 'boolean' },
  bucket: { enum: ['safe', 'owner'] }, planPath: { type: 'string' }, notes: { type: 'string' } } }

const IMPLEMENT_SCHEMA = { type: 'object', required: ['id', 'slug', 'ready'], properties: {
  id: { type: 'string' }, slug: { type: 'string' }, class: { enum: ['cheap', 'native'] },
  ready: { type: 'boolean' }, prNumber: { type: ['integer', 'null'] },
  summary: { type: 'string' }, reason: { type: 'string' } } }

const PREPARE_SCHEMA = { type: 'object', required: ['ready'], properties: {
  ready: { type: 'boolean' }, class: { type: 'string' }, excluded: { type: 'boolean' },
  baseSha: { type: ['string', 'null'] }, headSha: { type: ['string', 'null'] },
  reason: { type: 'string' }, gateSummary: { type: 'string' }, conflict: { type: 'boolean' } } }

const REVIEW_SCHEMA = { type: 'object', required: ['verdict', 'blockers'], properties: {
  verdict: { enum: ['APPROVE', 'REJECT'] }, blockers: { type: 'integer' },
  reasons: { type: 'array', items: { type: 'string' } } } }

const FINAL_SCHEMA = { type: 'object', required: ['merged'], properties: {
  merged: { type: 'boolean' }, mergeSha: { type: ['string', 'null'] }, reason: { type: 'string' } } }

const OK_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } }

// ── prompt builders ─────────────────────────────────────────────────────────────
const PRIME = `PRIME DIRECTIVES (never violate): one mutation path (every change is a MoshOps command); one undo system; the swappable seam (UI couples to the backend ONLY via execute_command + snapshot/events); the tier wall (no model on the audio thread / no RT allocation); ASTD clamps stay; cache by the FULL fingerprint.`

const S0 = `FIRST-STRANGER §0 RULES (bind every lane): one lane per worktree — never cross lanes in a branch; MoshOps is the SOLE mutation seam (incl. multiplayer/autosave); nothing a build reads may live under ~/Documents (new caches/artifacts under ~/Library/Mosh/); the verified build recipe is \`cmake --preset macos-arm64-release -DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/cpm-cache -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/tracktion_engine-src\`; keep the Info.plist TCC keys intact (MoshFixInfoPlist); DO NOT touch the parked threads (arena/, the SA3-LoRA branch, FMS spike worktrees, PROGRAM_STAGE1).`

// The loop can never edit its own rulebook or the spec.
const NEVER_TOUCH = `NEVER edit the loop's own rulebook: scripts/auto-loop/{gate,classify,merge-one,discover,lib}.sh, CLAUDE.md, docs specs 00–06, cmake/Dependencies.cmake + version pins, and .github/**. A diff touching any of these is a hard REJECT (needs-human), never an owner PR.`

function planPrompt(item) {
  const slug = slugOf(item.id)
  return `You are doing the FIRST-SESSION-PER-LANE planning for First-Stranger Program lane ${item.id} ("${item.title}") — spec §0 requires this before any code.
${PRIME}
Read this lane's section in ${PROG}/SPEC.md and the acceptance below. You are READ-MOSTLY: you write exactly ONE file, the lane plan.

Acceptance: ${item.acceptance || '(see SPEC.md)'}
Likely files: ${(item.files || []).join(', ') || '(discover them)'}
${item.blockedOn ? `Blocked-on-owner: ${item.blockedOn} — plan the implementable prep; note what the blocker gates.` : ''}

DO TWO THINGS:
 1. VERIFY THE GAP (spec §0): confirm the target gap STILL EXISTS in the current tree (grep the code — e.g. is there already autosave / schema-version / a brain-proxy URL / the packaging check?). If it is already closed, set gapExists:false and explain.
 2. WRITE THE GATE-REGISTERED PLAN to ${PROG}/lanes/${slug}.md in the repo's existing plan style: **Context**, the **exact gate(s)** that will prove it (reuse gates that already exist — specific --selftest checks, vitest, verify.py, a harness), the **files** to change, the **§0 rules** binding this lane, the expected merge **BUCKET** (safe = only ui/ + docs/ + service/**.py & not excluded & not ownerMerge; else owner-merge), and any **BLOCKED-ON-OWNER** dependency.

${S0}
${NEVER_TOUCH}
Do NOT implement anything.
Report JSON ONLY: {id:"${item.id}", planned:<wrote the doc>, gapExists:<bool>, bucket:"safe"|"owner", planPath:"${PROG}/lanes/${slug}.md", notes:"1-2 lines"}.`
}

function implementPrompt(item) {
  const slug = slugOf(item.id)
  const skills = (item.skills || []).join(', ') || 'test-driven-development'
  return `You are implementing First-Stranger Program lane ${item.id} ("${item.title}").
${PRIME}

Read its gate-registered plan at ${PROG}/lanes/${slug}.md first (written in the Plan phase). Acceptance: ${item.acceptance || '(see the plan)'}
Class: ${item.class || '(classify)'}. Likely files: ${(item.files || []).join(', ') || '(discover them)'}.

PROTOCOL (use the named superpowers skills): ${skills}, then verification-before-completion.
 1. ${RUN} WT=$(${ROOT}/new-worktree.sh ${slug}); echo "$WT" — your ISOLATED worktree. Do ALL work there.
 2. ORIENT: read the plan + named files; confirm the gap is still real before changing anything.
 3. TDD: write the FAILING gate/test FIRST (vitest for ui/, a python unit for service/relay, a Catch2/selftest check for src/). Confirm RED on the old code.
 4. Implement to GREEN, minimal + within this lane only. You MAY touch high-stakes paths this lane needs (MoshEngine, src/state, relay, auth/secrets, packaging, cmake) — the loop will NOT auto-merge those; it routes them to the OWNER to merge. But obey §0 and the never-touch rulebook.
${S0}
${NEVER_TOUCH}
 5. CHEAP CHECKS in the worktree (the merge-queue runs the authoritative gate — incl. native build — later):
      cd "$WT/ui" && npm run typecheck && npm test ${item.class === 'cheap' ? '&& npm run test:e2e' : ''}  (+ any python unit you added). Fix to green.
 6. SELF-REVIEW your diff against the prime directives + §0; fix issues.
 7. Commit on branch claude/auto-${slug} (clear message). Push: git -C "$WT" push -u origin claude/auto-${slug}.
 8. Open a DRAFT PR: gh pr create --draft --base main --head claude/auto-${slug} --title "auto(${item.id}): ${item.title}" --body "<what+why, acceptance, gate summary, expected bucket, any BLOCKED-ON-OWNER>".
Report JSON ONLY: {id:"${item.id}", slug:"${slug}", class:"${item.class || 'native'}", ready:true|false, prNumber:<n|null>, summary:"<1-2 lines>", reason:"<if not ready, why>"}.`
}

const preparePrompt = (it) => `${RUN} MOSH_SELFTEST_BASELINE=${baseline} ${ROOT}/merge-one.sh prepare ${slugOf(it.id)} ${it.prNumber} origin/main
Run EXACTLY that command (keep the MOSH_SELFTEST_BASELINE prefix — it enforces the native selftest floor;
MOSH_STRANGER_MODE=1 is exported, so an exclusion-list diff is GATED here and reported excluded:true rather
than auto-rejected). It rebases onto origin/main, classifies, and runs the authoritative gate. Return its
JSON verbatim: {ready, class, excluded, baseSha, headSha, reason, gateSummary, conflict}. Do not edit files.`

function reviewPrompt(it, prep) {
  const owner = !isSafe(prep, it)
  return `You are a HOSTILE release gatekeeper reviewing PR #${it.prNumber} (First-Stranger lane ${it.id}: "${it.title}").
${owner
  ? `This is a HIGH-STAKES lane — it will NOT be auto-merged; it will be routed to the OWNER to merge. Your verdict is ADVISORY but SURFACED on the PR: find every real concern so the owner sees it.`
  : `This is a SAFE lane that the loop will AUTO-MERGE to main unattended if you APPROVE. No human will see it first. Find a reason to REJECT; assume guilty until proven safe.`}
You are READ-ONLY (git show / git diff only).

${PRIME}
Inspect the rebased diff: ${RUN} git -C .claude/worktrees/auto-${slugOf(it.id)} diff origin/main...HEAD
The gate passed: ${prep.gateSummary || '(see prepare)'} (class ${prep.class}${prep.excluded ? ', excluded' : ''}).

Hunt for: (1) prime-directive / §0 violations; (2) gate-weakening (tests deleted/skipped/.only, a selftest check
removed, an assertion downgraded, the determinism bar or contract test neutered, check-count dropping);
(3) edits to the never-touch rulebook (${'scripts/auto-loop/*.sh, CLAUDE.md, specs 00–06, cmake pins, .github'}) — an automatic REJECT;
(4) correctness / data-loss / partial-mutation / use-after-free / races; (5) any added secret/token/credential
(the T-lane must ship NO bundled key). ${owner ? 'Report concerns as blockers even though this routes to the owner.' : 'DEFAULT TO REJECT on ANY uncertainty.'}
Return JSON ONLY: {verdict:"APPROVE"|"REJECT", blockers:<int>, reasons:[...]}. "Approve with fixes" = REJECT.`
}

const finalizePrompt = (it, prep) => `${RUN} ${ROOT}/merge-one.sh finalize ${slugOf(it.id)} ${it.prNumber} ${prep.baseSha} "APPROVE (adversarial self-review)"
Run EXACTLY that command. It re-checks the STOP switch + that origin/main has not advanced since ${prep.baseSha},
then waits for main's required "cheap gate" status check and squash-merges (NO --admin — it cannot
bypass a required check while enforce_admins is on), appends the program ledger, removes the worktree.
A red or absent check is fail-closed: finalize refuses to merge.
Return its JSON verbatim: {merged, mergeSha, reason}.`

// SAFE ⇔ auto-mergeable: cheap class AND not exclusion-list AND the item is not owner-taste-gated.
function isSafe(prep, item) {
  return prep && prep.class === 'cheap' && prep.excluded === false && !(item && item.ownerMerge)
}

const rejectAction = (it, sublabel, reason) =>
  agent(`${RUN} ${ROOT}/merge-one.sh reject ${slugOf(it.id)} ${it.prNumber} ${sublabel} ${JSON.stringify(reason)}
Run EXACTLY that command (labels needs-human + ${sublabel}, comments, ledgers a REJECTED entry). Return its JSON.`,
    { label: `reject:${it.id}`, phase: 'Merge' })

function routeToOwner(it, prep, review) {
  const approved = review && review.verdict === 'APPROVE' && review.blockers === 0
  const flagged = approved ? 0 : 1
  const note = review
    ? `${review.verdict}${(review.reasons && review.reasons.length) ? ' — ' + review.reasons.join('; ') : ''}`
    : 'review unavailable'
  return agent(`${RUN} ${ROOT}/merge-one.sh route-owner ${slugOf(it.id)} ${it.prNumber} ${it.lane || 'X'} ${JSON.stringify(prep.gateSummary || 'gate green')} ${JSON.stringify(note)} ${flagged}
Run EXACTLY that command (undrafts the PR, labels needs-owner-merge + program:${it.lane || 'X'}${flagged ? ' + review-flagged' : ''}, comments the gate + review, ledgers AWAITING-OWNER). It NEVER merges. Return its JSON.`,
    { label: `route-owner:${it.id}`, phase: 'Merge' })
}

async function agentSetStatus(items, status) {
  if (!items.length) return
  const cmds = items.map(it => `${ROOT}/discover.sh set-status ${it.id} ${status}`).join(' ; ')
  await agent(`${RUN} ${cmds}\nRun those, then report JSON {ok:true}.`, { schema: OK_SCHEMA, label: `status:${status}`, phase: 'Load' })
}

async function stopRequested() {
  const r = await agent(`${RUN} { test -e ${PROG}/STOP || test -e docs/auto-loop/STOP; } && echo true || echo false
Report JSON: {stop:<true|false>}.`, { schema: { type: 'object', required: ['stop'], properties: { stop: { type: 'boolean' } } }, label: 'stop-check', phase: 'Merge' })
  return !!(r && r.stop)
}

async function dashboard() {
  await agent(`${RUN} bash scripts/first-stranger/status.sh
Run that (regenerates ${PROG}/STATUS.md from the backlog + open PRs). Report JSON {ok:true}.`,
    { schema: OK_SCHEMA, label: 'dashboard', phase: 'Dashboard' })
}

// ════════════════════════════════════════════════════════════════════════════════
// PREFLIGHT
// ════════════════════════════════════════════════════════════════════════════════
phase('Preflight')
let baseline = cfg.baselineN
if (!cfg.planOnly && baseline == null) {
  const pf = await agent(
    `${RUN} ${ROOT}/seed-cache.sh
Then establish the selftest BASELINE on main: build the Release app from the MAIN worktree (reuse the seeded
dep-cache flags in ~/.mosh-auto-loop/auto-loop.env), and run \`Mosh --selftest\` ONCE (unique MOSH_SELFTEST_SESSION
+ MOSH_SERVICE_PORT). Parse "<N> checks passed, <F> failed". Report JSON: {ok:<F==0>, baseline:<N or null>, detail:"..."}.
Heavy (cold first build). Do not merge anything.`,
    { schema: PREFLIGHT_SCHEMA, phase: 'Preflight', label: 'preflight' })
  if (!pf || !pf.ok || pf.baseline == null) {
    log(`PREFLIGHT failed (${pf ? pf.detail : 'agent died'}). Halting — cannot establish a baseline.`)
    return { halted: 'preflight-failed', detail: pf }
  }
  baseline = pf.baseline
  log(`baseline selftest = ${baseline} checks on main (spec floor ≈1254–1260)`)
} else {
  log(cfg.planOnly ? 'planOnly: skipping the heavy baseline build.' : `baseline pinned to ${baseline}.`)
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ════════════════════════════════════════════════════════════════════════════════
let merges = 0, cycle = 0, dryRuns = 0, ownerRoutes = 0, planned = 0, consecutiveFailures = 0
const mergedIds = [], ownerIds = [], rejectedIds = [], halts = []

async function mergeQueueOne(item) {
  const prep = await agent(preparePrompt(item), { schema: PREPARE_SCHEMA, phase: 'Merge', label: `prepare:${item.id}` })
  if (!prep) { await rejectAction(item, 'gate-red', 'prepare agent died'); rejectedIds.push(item.id); return 'rejected' }
  if (prep.conflict) { await rejectAction(item, 'rebase-conflict', prep.reason || 'rebase conflict'); rejectedIds.push(item.id); return 'rejected' }
  if (!prep.ready) { await rejectAction(item, 'gate-red', prep.reason || 'gate failed'); rejectedIds.push(item.id); return 'rejected' }

  // Gate GREEN. Hostile review (gating for SAFE, advisory-but-surfaced for OWNER).
  const review = await agent(reviewPrompt(item, prep), { schema: REVIEW_SCHEMA, phase: 'Review', label: `review:${item.id}`, effort: 'high' })

  if (isSafe(prep, item)) {
    if (!review || review.verdict !== 'APPROVE' || review.blockers !== 0) {
      await rejectAction(item, 'review-reject', (review && review.reasons ? review.reasons.join('; ') : 'review rejected / died'))
      rejectedIds.push(item.id); return 'rejected'
    }
    if (cfg.dryRun) { log(`DRY-RUN: SAFE ${item.id} would AUTO-MERGE (gate green + APPROVE).`); dryRuns++; return 'dry' }
    const fin = await agent(finalizePrompt(item, prep), { schema: FINAL_SCHEMA, phase: 'Merge', label: `finalize:${item.id}` })
    if (fin && fin.merged) { merges++; consecutiveFailures = 0; mergedIds.push(item.id); return 'merged' }
    await rejectAction(item, 'gate-red', fin ? (fin.reason || 'finalize failed') : 'finalize died')
    consecutiveFailures++; rejectedIds.push(item.id); return 'rejected'
  }

  // OWNER bucket — high-stakes: NEVER auto-merge. Route to the owner (review surfaced).
  if (cfg.dryRun) { log(`DRY-RUN: OWNER ${item.id} would ROUTE-TO-OWNER (${prep.excluded ? 'excluded' : prep.class}${item.ownerMerge ? ', ownerMerge' : ''}).`); dryRuns++; return 'dry' }
  await routeToOwner(item, prep, review)
  ownerRoutes++; ownerIds.push(item.id); return 'owner'
}

while (cycle < cfg.maxCycles && merges < cfg.maxMerges) {
  cycle++
  phase('Load')
  const load = await agent(
    `${RUN} { test -e ${PROG}/STOP || test -e docs/auto-loop/STOP; } && echo STOP || echo GO ; ${ROOT}/discover.sh ready
Report JSON: {stop:<true if STOP printed>, items:<the ready array, verbatim>}.`,
    { schema: READY_SCHEMA, phase: 'Load', label: `load:c${cycle}` })

  if (!load) { halts.push('load-died'); break }
  if (load.stop) { log('STOP sentinel present — halting gracefully.'); halts.push('stop-sentinel'); break }

  let ready = (load.items || []).filter(Boolean)
  if (!cfg.allowNative) ready = ready.filter(it => it.class !== 'native')
  if (ready.length === 0) { log('program backlog dry (no ready, unblocked lanes) — stopping.'); halts.push('backlog-dry'); break }

  // pick ≤ maxItems, ordered by the spec Wk-map. The native-in-flight cap bounds the serial
  // BUILD queue — so it only applies when we actually implement; planOnly cycles (which build
  // nothing) plan every ready lane up to maxItems.
  const picked = []
  let nativeCount = 0
  for (const it of ready.sort((a, b) => (a.order || 0) - (b.order || 0))) {
    if (picked.length >= cfg.maxItems) break
    if (!cfg.planOnly && it.class === 'native') { if (nativeCount >= cfg.maxNativeInFlight) continue; nativeCount++ }
    picked.push(it)
  }
  log(`cycle ${cycle}: lanes ${picked.map(p => p.id).join(', ')}`)

  // PLAN (parallel, read-mostly): verify the gap + write the gate-registered plan (spec §0).
  phase('Plan')
  const plans = (await parallel(picked.map(it => () =>
    agent(planPrompt(it), { schema: PLAN_SCHEMA, phase: 'Plan', label: `plan:${it.id}` })
      .then(r => r ? Object.assign({}, it, { plan: r }) : Object.assign({}, it, { plan: null }))
  )))
  planned += plans.filter(p => p.plan && p.plan.planned).length

  // Lanes whose gap is already closed drop out (spec §0: report + skip).
  const live = plans.filter(p => p.plan && p.plan.gapExists !== false)
  const closed = plans.filter(p => p.plan && p.plan.gapExists === false)
  for (const c of closed) { log(`gap already closed for ${c.id} — skipping (${c.plan.notes || ''}).`); await agentSetStatus([c], 'gap-closed') }

  if (cfg.planOnly) {
    log(`planOnly: planned ${plans.filter(p => p.plan && p.plan.planned).length}/${picked.length} lane(s); not implementing.`)
    await agentSetStatus(live, 'ready')   // leave them ready for the real run
    halts.push('plan-only'); break
  }

  if (live.length === 0) { log('no live lanes after gap-verify — stopping.'); halts.push('all-gaps-closed'); break }

  // IMPLEMENT (parallel worktrees → draft PRs).
  phase('Implement')
  await agentSetStatus(live, 'in_progress')
  const built = (await parallel(live.map(it => () =>
    agent(implementPrompt(it), { schema: IMPLEMENT_SCHEMA, phase: 'Implement', label: `impl:${it.id}` })
      .then(r => r ? Object.assign({}, it, r) : null)
  ))).filter(Boolean)

  // SERIAL MERGE-QUEUE.
  phase('Merge')
  for (const it of built) {
    if (await stopRequested()) { halts.push('stop-sentinel'); break }
    if (!it.ready || !it.prNumber) { await agentSetStatus([it], 'blocked'); continue }
    const outcome = await mergeQueueOne(it)
    const nextStatus = outcome === 'merged' ? 'done'
      : outcome === 'owner' ? 'awaiting-owner'
      : outcome === 'dry' ? 'ready'
      : 'needs-human'
    await agentSetStatus([it], nextStatus)
    if (consecutiveFailures >= 3) { log('circuit-breaker: 3 consecutive merge failures — halting.'); halts.push('circuit-breaker'); break }
    if (merges >= cfg.maxMerges) break
  }
  if (halts.length) break
}

if (await stopRequested()) {
  log('STOP sentinel present — preserving the historical dashboard without refresh.')
} else {
  phase('Dashboard')
  await dashboard()
}

log(`stranger-loop done. planned=${planned} merged(safe)=${merges} routed(owner)=${ownerRoutes} rejected=${rejectedIds.length} dryRuns=${dryRuns} cycles=${cycle} halts=${halts.join(',') || 'none'}`)
return { planned, mergedSafe: mergedIds, routedOwner: ownerIds, rejected: rejectedIds, dryRuns, cycles: cycle, baseline, halts, dryRun: cfg.dryRun, planOnly: cfg.planOnly }
