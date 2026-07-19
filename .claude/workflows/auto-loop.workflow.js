export const meta = {
  name: 'auto-loop',
  description: 'Autonomous deferred-work loop: implement backlog items in parallel worktrees, open PRs, and auto-merge to main when the full gate + adversarial review pass (fail-closed).',
  whenToUse: 'Run locally on the Mac to work the docs/auto-loop backlog unattended. Auto-merges to main — start in dryRun:true to rehearse.',
  phases: [
    { title: 'Preflight', detail: 'seed dep cache + establish selftest baseline on main' },
    { title: 'Load', detail: 'read ready backlog + check kill switch' },
    { title: 'Implement', detail: 'parallel worktrees: TDD → cheap checks → draft PR' },
    { title: 'Merge', detail: 'serial queue: rebase + gate + finalize/reject' },
    { title: 'Review', detail: 'independent adversarial skeptic per PR' },
    { title: 'Refill', detail: 'bug-hunt fan-out → adversarial verify → backlog' },
  ],
}

// ── config (override via Workflow args) ─────────────────────────────────────────
// args may arrive as an object OR a JSON-encoded string (depending on the caller);
// accept both so config like {dryRun:false,maxCycles:1} actually applies.
let _args = args
if (typeof _args === 'string') { try { _args = JSON.parse(_args) } catch (e) { _args = {} } }
const cfg = Object.assign({
  maxItems: 3,            // implement agents per cycle (≤ concurrency cap)
  maxNativeInFlight: 1,   // cap parallel native items (bounds the serial build queue)
  maxMerges: 8,           // hard cap on merges this run
  maxCycles: 6,           // hard cap on cycles
  dryRun: true,           // true = prepare+review but DO NOT finalize (rehearsal). FLIP to false to arm auto-merge.
  allowNative: false,     // start cheap-only; flip on once the cheap lane is proven
  baselineN: null,        // if set, skip the heavy preflight baseline build
  refill: true,           // run auto-discovery when ready < maxItems
  ts: 'unset',            // caller-supplied timestamp string (Date.now is banned in workflows)
}, (_args && typeof _args === 'object') ? _args : {})

const ROOT = 'scripts/auto-loop'
const RUN = `cd "$(git rev-parse --show-toplevel)" &&`   // agents run shell from repo root

// ── schemas ─────────────────────────────────────────────────────────────────────
const PREFLIGHT_SCHEMA = { type: 'object', required: ['ok', 'baseline'], properties: {
  ok: { type: 'boolean' }, baseline: { type: ['integer', 'null'] }, detail: { type: 'string' } } }

const READY_SCHEMA = { type: 'object', required: ['stop', 'items'], properties: {
  stop: { type: 'boolean', description: 'true if docs/auto-loop/STOP exists' },
  items: { type: 'array', items: { type: 'object', required: ['id', 'class'], properties: {
    id: { type: 'string' }, title: { type: 'string' }, class: { enum: ['cheap', 'native'] },
    size: { type: 'string' }, order: { type: 'number' }, mode: { type: 'string' },
    branch: { type: 'string' }, acceptance: { type: 'string' }, notes: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    skills: { type: 'array', items: { type: 'string' } } } } } } }

const IMPLEMENT_SCHEMA = { type: 'object', required: ['id', 'slug', 'ready'], properties: {
  id: { type: 'string' }, slug: { type: 'string' }, class: { enum: ['cheap', 'native'] },
  ready: { type: 'boolean', description: 'true if a draft PR was opened and cheap checks pass' },
  prNumber: { type: ['integer', 'null'] }, summary: { type: 'string' }, reason: { type: 'string' } } }

const PREPARE_SCHEMA = { type: 'object', required: ['ready'], properties: {
  ready: { type: 'boolean' }, class: { type: 'string' }, excluded: { type: 'boolean' },
  baseSha: { type: ['string', 'null'] }, headSha: { type: ['string', 'null'] },
  reason: { type: 'string' }, gateSummary: { type: 'string' }, conflict: { type: 'boolean' } } }

const REVIEW_SCHEMA = { type: 'object', required: ['verdict', 'blockers'], properties: {
  verdict: { enum: ['APPROVE', 'REJECT'] }, blockers: { type: 'integer' },
  reasons: { type: 'array', items: { type: 'string' } } } }

const FINAL_SCHEMA = { type: 'object', required: ['merged'], properties: {
  merged: { type: 'boolean' }, mergeSha: { type: ['string', 'null'] }, reason: { type: 'string' } } }

// ── prompt builders ─────────────────────────────────────────────────────────────
const PRIME = `PRIME DIRECTIVES (never violate): one mutation path (every change is a MoshOps command); one undo system; the swappable seam (UI couples to the backend ONLY via execute_command + snapshot/events — a UI-only change must not alter the C++ binary); the tier wall (no model on the audio thread / no RT allocation); ASTD clamps stay (defeatable only in Lab mode); cache by the FULL fingerprint; never weaken a gate; never edit the loop's own rulebook (CLAUDE.md, specs 00–06, gate scripts, dependency pins, CI).`

const slugOf = (id) => String(id).toLowerCase().replace(/[^a-z0-9._-]/g, '-')

function implementPrompt(item) {
  const slug = slugOf(item.id)
  if (item.mode === 'merge-existing') {
    return `You are STAGING backlog item ${item.id} ("${item.title}") for the merge-queue. mode:merge-existing —
the work ALREADY EXISTS on branch ${item.branch}; you write no new code, you only stage it as a PR.
Run all commands from the repo root (cd "$(git rev-parse --show-toplevel)"). Steps:
 1. WT=$(${ROOT}/new-worktree.sh ${slug} origin/${item.branch})   # worktree branch claude/auto-${slug} carries the commit
 2. git -C "$WT" push -u origin claude/auto-${slug} --force-with-lease
 3. gh pr create --draft --base main --head claude/auto-${slug} --title "auto(${item.id}): ${item.title}" --body "Auto-loop warm-up: merge the already-deployed bootstrap-audio commit via the merge-queue."
 4. Capture the PR number from gh's output.
Report JSON ONLY: {id:"${item.id}", slug:"${slug}", class:"${item.class}", ready:<true if the draft PR opened>, prNumber:<n|null>, summary:"...", reason:"<if not ready, why>"}.`
  }
  const skills = (item.skills || []).join(', ') || 'test-driven-development'
  return `You are implementing backlog item ${item.id} ("${item.title}") for the Mosh autonomous loop.
${PRIME}

Acceptance: ${item.acceptance || '(see backlog)'}
Class: ${item.class}.  Likely files: ${(item.files || []).join(', ') || '(discover them)'}.

PROTOCOL (use the named superpowers skills): ${skills}, then verification-before-completion.
 1. ${RUN} WT=$(${ROOT}/new-worktree.sh ${slug}); echo "$WT" — your ISOLATED worktree. Do ALL work there.
 2. ORIENT: read the named files; confirm the bug/feature is real in THIS tree before changing anything.
 3. TDD: write the FAILING test first (vitest for ui/, a python unit for service/relay). Confirm it's RED on the old code.
 4. Implement to GREEN. Keep changes minimal + within this item's scope. Do NOT touch hard-exclusion paths
    (cmake pins, CMakeLists, deploy scripts, relay/Supabase auth, src/plugins/hosting, MoshEngine.{cpp,h}, src/state,
    CLAUDE.md, specs 00–06, .github). If the only correct fix needs those, STOP and report ready:false (needs-human).
 5. CHEAP CHECKS (parallel-safe — do NOT run a native build here; the merge-queue does that):
      cd "$WT/ui" && npm run typecheck && npm test ${item.class === 'cheap' ? '&& npm run test:e2e' : ''}
      (+ any python unit you added). Fix until green.
 6. SELF-REVIEW your diff against the prime directives; fix issues.
 7. Commit on branch claude/auto-${slug} (clear message). Push: git -C "$WT" push -u origin claude/auto-${slug}.
 8. Open a DRAFT PR:  gh pr create --draft --base main --head claude/auto-${slug} --title "auto(${item.id}): ${item.title}" --body "<what+why, acceptance, gate summary>".
Report JSON ONLY: {id:"${item.id}", slug:"${slug}", class:"${item.class}", ready:true|false, prNumber:<n|null>, summary:"<1-2 lines>", reason:"<if not ready, why>"}.`
}

const preparePrompt = (it) => `${RUN} MOSH_SELFTEST_BASELINE=${baseline} ${ROOT}/merge-one.sh prepare ${slugOf(it.id)} ${it.prNumber} origin/main
Run EXACTLY that command (keep the MOSH_SELFTEST_BASELINE prefix — it enforces the native selftest
check-count floor). It rebases the branch onto origin/main, checks the hard-exclusion list, and runs
the authoritative gate (native: build + ctest + selftest ×3 deterministic + verify.py; cheap: typecheck +
vitest + e2e). Return its JSON verbatim as: {ready, class, excluded, baseSha, headSha, reason, gateSummary, conflict}.
Set gateSummary to a one-line digest of the gate result. Do not edit any files.`

function reviewPrompt(it, prep) {
  return `You are a HOSTILE release gatekeeper for an UNATTENDED auto-merge to main of PR #${it.prNumber}
(backlog item ${it.id}: "${it.title}"). No human will see this before it lands. Find a reason to REJECT;
assume the change is guilty until proven safe. You are READ-ONLY (use git show / git diff only).

${PRIME}

Inspect the rebased diff:  ${RUN} git -C .claude/worktrees/auto-${slugOf(it.id)} diff origin/main...HEAD
The gate already passed: ${prep.gateSummary || '(see prepare output)'} (class ${prep.class}).

Hunt specifically for: (1) prime-directive violations; (2) gate-weakening (tests deleted/skipped/.only,
a selftest check removed, an assertion downgraded, the determinism bar or contract test neutered, selftest
check-count dropping); (3) scope creep into the exclusion list; (4) correctness/data-loss/partial-mutation/
use-after-free/races; (5) any added secret/token/credential. DEFAULT TO REJECT on ANY uncertainty — a false
reject just routes to a human (cheap); a bad merge breaks an unattended main (catastrophic).
Return JSON ONLY: {verdict:"APPROVE"|"REJECT", blockers:<int>, reasons:[...]}. "Approve with fixes" = REJECT.`
}

const finalizePrompt = (it, prep) => `${RUN} ${ROOT}/merge-one.sh finalize ${slugOf(it.id)} ${it.prNumber} ${prep.baseSha} "APPROVE (adversarial self-review)"
Run EXACTLY that command. It re-checks the kill switch + that origin/main has not advanced since ${prep.baseSha},
then waits for main's required "cheap gate" status check and squash-merges (gh pr merge --squash — NOT
--admin, which cannot bypass a required check while enforce_admins is on), appends the ledger, and
removes the worktree. A red or absent check is fail-closed: finalize refuses to merge.
Return its JSON verbatim: {merged, mergeSha, reason}.`

const rejectAction = (it, sublabel, reason) =>
  agent(`${RUN} ${ROOT}/merge-one.sh reject ${slugOf(it.id)} ${it.prNumber} ${sublabel} ${JSON.stringify(reason)}
Run EXACTLY that command (labels the PR needs-human + ${sublabel}, comments, ledgers a REJECTED entry). Return its JSON.`,
    { label: `reject:${it.id}`, phase: 'Merge' })

// ════════════════════════════════════════════════════════════════════════════════
// PREFLIGHT
// ════════════════════════════════════════════════════════════════════════════════
phase('Preflight')
let baseline = cfg.baselineN
if (baseline == null) {
  const pf = await agent(
    `${RUN} ${ROOT}/seed-cache.sh
Then establish the selftest BASELINE on main: build the Release app from the MAIN worktree
(reuse the seeded dep cache flags printed in ~/.mosh-auto-loop/auto-loop.env), and run
\`Mosh --selftest\` ONCE (set a unique MOSH_SELFTEST_SESSION + MOSH_SERVICE_PORT). Parse the
"<N> checks passed, <F> failed" line. Report JSON: {ok:<F==0>, baseline:<N or null>, detail:"..."}.
This is heavy (cold first build). Do not merge anything.`,
    { schema: PREFLIGHT_SCHEMA, phase: 'Preflight', label: 'preflight' })
  if (!pf || !pf.ok || pf.baseline == null) {
    log(`PREFLIGHT failed (${pf ? pf.detail : 'agent died'}). Halting — cannot establish a baseline.`)
    return { halted: 'preflight-failed', detail: pf }
  }
  baseline = pf.baseline
  log(`baseline selftest = ${baseline} checks on main`)
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ════════════════════════════════════════════════════════════════════════════════
let merges = 0, cycle = 0, dryRuns = 0, consecutiveFailures = 0
const merged = [], rejected = [], halts = []

// Process ONE prepared PR through the serial merge-queue. Returns 'merged'|'rejected'|'dry'.
async function mergeQueueOne(item) {
  const prep = await agent(preparePrompt(item), { schema: PREPARE_SCHEMA, phase: 'Merge', label: `prepare:${item.id}` })
  if (!prep) { await rejectAction(item, 'gate-red', 'prepare agent died'); rejected.push(item.id); return 'rejected' }
  if (prep.conflict) { await rejectAction(item, 'rebase-conflict', prep.reason || 'rebase conflict'); rejected.push(item.id); return 'rejected' }
  if (prep.excluded) { await rejectAction(item, 'out-of-scope', prep.reason || 'touches exclusion list'); rejected.push(item.id); return 'rejected' }
  if (!prep.ready) { await rejectAction(item, 'gate-red', prep.reason || 'gate failed'); rejected.push(item.id); return 'rejected' }

  // Independent adversarial review (fresh context, default-to-reject).
  const review = await agent(reviewPrompt(item, prep), { schema: REVIEW_SCHEMA, phase: 'Review', label: `review:${item.id}`, effort: 'high' })
  if (!review || review.verdict !== 'APPROVE' || review.blockers !== 0) {
    await rejectAction(item, 'review-reject', (review && review.reasons ? review.reasons.join('; ') : 'review rejected / died'))
    rejected.push(item.id); return 'rejected'
  }

  if (cfg.dryRun) {
    log(`DRY-RUN: ${item.id} would MERGE (gate green + review APPROVE). Not finalizing.`)
    dryRuns++; return 'dry'
  }

  const fin = await agent(finalizePrompt(item, prep), { schema: FINAL_SCHEMA, phase: 'Merge', label: `finalize:${item.id}` })
  if (fin && fin.merged) { merges++; consecutiveFailures = 0; merged.push(item.id); return 'merged' }
  // finalize bounced (e.g. main advanced) — leave the PR, count a failure.
  await rejectAction(item, 'gate-red', fin ? (fin.reason || 'finalize failed') : 'finalize died')
  consecutiveFailures++; rejected.push(item.id); return 'rejected'
}

while (cycle < cfg.maxCycles && merges < cfg.maxMerges) {
  cycle++
  phase('Load')
  const load = await agent(
    `${RUN} test -e docs/auto-loop/STOP && echo STOP || echo GO ; ${ROOT}/discover.sh ready
Report JSON: {stop:<true if STOP printed>, items:<the ready array, verbatim>}.`,
    { schema: READY_SCHEMA, phase: 'Load', label: `load:c${cycle}` })

  if (!load) { halts.push('load-died'); break }
  if (load.stop) { log('STOP sentinel present — halting gracefully.'); halts.push('stop-sentinel'); break }

  let ready = (load.items || []).filter(Boolean)
  if (!cfg.allowNative) ready = ready.filter(it => it.class !== 'native')
  if (ready.length === 0) {
    if (cfg.refill) {
      phase('Refill')
      const found = await refill(baseline)
      if (found > 0) { log(`refill added ${found} item(s); continuing.`); continue }
    }
    log('backlog dry (no workable ready items) — stopping.'); halts.push('backlog-dry'); break
  }

  // pick ≤ maxItems, honoring the native-in-flight cap
  const picked = []
  let nativeCount = 0
  for (const it of ready.sort((a, b) => (a.order || 0) - (b.order || 0))) {
    if (picked.length >= cfg.maxItems) break
    if (it.class === 'native') { if (nativeCount >= cfg.maxNativeInFlight) continue; nativeCount++ }
    picked.push(it)
  }
  log(`cycle ${cycle}: implementing ${picked.map(p => p.id).join(', ')}`)

  // PARALLEL IMPLEMENT (each agent makes its own worktree + draft PR).
  phase('Implement')
  await agentSetStatus(picked, 'in_progress')
  const built = (await parallel(picked.map(it => () =>
    agent(implementPrompt(it), { schema: IMPLEMENT_SCHEMA, phase: 'Implement', label: `impl:${it.id}` })
      .then(r => r ? Object.assign({}, it, r) : null)
  ))).filter(Boolean)

  // SERIAL MERGE-QUEUE
  phase('Merge')
  for (const it of built) {
    if (await stopRequested()) { halts.push('stop-sentinel'); break }
    if (!it.ready || !it.prNumber) { await agentSetStatus([it], 'blocked'); continue }
    const outcome = await mergeQueueOne(it)
    await agentSetStatus([it], outcome === 'merged' ? 'done' : (outcome === 'dry' ? 'ready' : 'needs-human'))
    if (consecutiveFailures >= 3) { log('circuit-breaker: 3 consecutive merge failures — halting.'); halts.push('circuit-breaker'); break }
    if (merges >= cfg.maxMerges) break
  }
  if (halts.length) break
}

log(`auto-loop done. merged=${merged.length} rejected=${rejected.length} dryRuns=${dryRuns} cycles=${cycle} halts=${halts.join(',') || 'none'}`)
return { merged, rejected, dryRuns, cycles: cycle, baseline, halts, dryRun: cfg.dryRun }

// ── helpers that need agents (file IO is via shell agents) ───────────────────────
async function stopRequested() {
  const r = await agent(`${RUN} test -e docs/auto-loop/STOP && echo true || echo false
Report JSON: {stop:<true|false>}.`, { schema: { type: 'object', required: ['stop'], properties: { stop: { type: 'boolean' } } }, label: 'stop-check', phase: 'Merge' })
  return !!(r && r.stop)
}

async function agentSetStatus(items, status) {
  if (!items.length) return
  const cmds = items.map(it => `${ROOT}/discover.sh set-status ${it.id} ${status}`).join(' ; ')
  await agent(`${RUN} ${cmds}\nRun those, then report JSON {ok:true}.`,
    { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, label: `status:${status}`, phase: 'Load' })
}

// Auto-discovery refill: bug-hunt fan-out → adversarial verify → discover.sh add.
async function refill(baselineN) {
  const LENS = ['MoshOps command validation + partial-mutation', 'UI optimistic-update / state rollback', 'Python service/relay resilience + error handling']
  const finds = (await parallel(LENS.map((lens, i) => () =>
    agent(`You are a bug-finder for the Mosh repo (read-only). Lens: ${lens}.
Find ONE small, real, SINGLE-PR-fixable defect whose fix can be proven by an automated gate
(vitest / a python unit / a Mosh --selftest check / verify.py). Avoid the excluded epics and the
hard-exclusion paths (cmake pins, deploy, relay/Supabase auth, src/plugins/hosting, MoshEngine, src/state).
Inspect with grep/read. Report JSON: {found:bool, title, class:"cheap"|"native", size, files:[...], acceptance, why}.`,
      { schema: { type: 'object', required: ['found'], properties: {
        found: { type: 'boolean' }, title: { type: 'string' }, class: { enum: ['cheap', 'native'] },
        size: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
        acceptance: { type: 'string' }, why: { type: 'string' } } }, label: `find:${i}`, phase: 'Refill' })
  ))).filter(Boolean).filter(f => f.found)

  let added = 0
  for (const f of finds) {
    // adversarial verify: a second agent must confirm it's real + single-PR + gate-provable
    const v = await agent(`Adversarially verify this candidate backlog item is REAL, in-scope, single-PR,
and provable by an automated gate. Default to REJECT on doubt. Candidate: ${JSON.stringify(f)}.
Inspect the repo (read-only). Report JSON: {confirmed:bool, reason}.`,
      { schema: { type: 'object', required: ['confirmed'], properties: { confirmed: { type: 'boolean' }, reason: { type: 'string' } } }, label: 'verify-find', phase: 'Refill', effort: 'high' })
    if (v && v.confirmed) {
      const item = { title: f.title, class: f.class || 'cheap', size: f.size || 'M', files: f.files || [], acceptance: f.acceptance || '', skills: ['systematic-debugging', 'test-driven-development'], notes: 'auto-discovered' }
      await agent(`${RUN} ${ROOT}/discover.sh add ${JSON.stringify(JSON.stringify(item))}
Run that (appends the item to the backlog) and report JSON {ok:true, id:"<the printed id>"}.`,
        { schema: { type: 'object', properties: { ok: { type: 'boolean' }, id: { type: 'string' } } }, label: 'backlog-add', phase: 'Refill' })
      added++
    }
  }
  return added
}
