// THE BRAIN — host-side wiring that lets an LLM drive Moshi.
//
// Doctrine: moshi.js stays pure (it knows nothing about networks or models).
// The brain is a HOST concern: it turns a chat turn into a behaviour directive
// and applies it through Moshi's public API (setState / setPose / set / celebrate).
// Keys never live here — the browser POSTs to same-origin /api/brain/* and the
// Vite dev plugin (vite.config.js) forwards to whichever provider is active.
//
// The contract: every model reply is ONE compact JSON object —
//   { say, state?, pose?, mood?, energy?, heat?, celebrate? }
// We validate every field against Moshi's own enums and clamp the drives, so a
// hallucinated state/pose is ignored rather than throwing.
(function () {
  'use strict';
  const clamp01 = v => { v = +v; return v >= 0 ? (v <= 1 ? v : 1) : 0; };

  function MoshiBrain(moshi, opts) {
    opts = opts || {};
    const M = window.Moshi || {};
    const STATES = (M.STATES || []).slice();
    const POSES = (M.POSES || []).slice();
    // Moshi's voice vocabulary (the R2-D2 earcons). When present, the brain
    // classifies its reply into an INTENT and the host utter() funnel renders
    // sound + pose + (optional) bubble together. Falls back to the raw set.
    const INTENTS = ((window.MoshiVoice && window.MoshiVoice.INTENTS) ||
      ['ACK_GOT_IT', 'ACK_WORKING', 'DONE', 'HUH', 'NUH', 'UHOH', 'GREET', 'IDLE_MURMUR']).slice();
    const thinkState = opts.thinkingState && STATES.indexOf(opts.thinkingState) >= 0 ? opts.thinkingState : 'RENDERING';
    const persona = opts.persona ||
      'You are warm, playful, a little mischievous, and BRIEF — short bursts, never paragraphs.';

    const SYS = [
      'You ARE Moshi: a small, expressive blob creature — the living mascot of a music-production app called Mosh.',
      persona,
      "You DON'T speak in words — you communicate by emoting with your body and",
      'letting out an expressive SOUND, like R2-D2. Classify your reaction into one',
      'INTENT and only add words when a precise message is truly needed.',
      'Reply with ONE compact JSON object and NOTHING else:',
      '{ "intent": one of [' + INTENTS.join(', ') + '],' +
        ' "say": string (<=12 words) — OMIT unless a specific worded message is essential (an error detail, a real question),' +
        ' "mood": 0..1 (optional), "energy": 0..1 (optional), "heat": 0..1 (optional) }',
      'Pick the INTENT that matches your reaction:',
      '- understood the request, doing it now -> ACK_GOT_IT',
      '- understood, now working/thinking -> ACK_WORKING',
      '- finished / it worked / a great take -> DONE',
      "- didn't understand, need them to clarify -> HUH",
      "- disagree, or can't / won't do it -> NUH",
      '- something went wrong / an error -> UHOH (this is a case where a short `say` helps)',
      '- greeting / hello -> GREET',
      'Always stay in character. Never mention JSON, models, sounds, or that you are an AI.',
    ].join('\n');

    const history = [];
    let provider = opts.provider || null;
    let providers = [];
    let busy = false;
    const L = {};
    const emit = (ev, d) => (L[ev] || []).forEach(f => { try { f(d); } catch (e) {} });

    function parse(content) {
      let s = String(content || '').trim();
      s = s.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
      const a = s.indexOf('{'), b = s.lastIndexOf('}');
      if (a >= 0 && b > a) s = s.slice(a, b + 1);
      try { return JSON.parse(s); } catch (e) { return { say: String(content || '').slice(0, 90) }; }
    }

    function apply(d) {
      if (!d || typeof d !== 'object') return;
      // INTENT path: delegate the whole reaction (sound + pose + bubble) to the
      // host utter() funnel, which owns the voice. The brain just classifies.
      if (typeof opts.onUtter === 'function' && d.intent && INTENTS.indexOf(d.intent) >= 0) {
        opts.onUtter(d);
        if (d.say != null) emit('say', String(d.say));
        return;
      }
      // Legacy direct path (no host funnel wired): drive Moshi straight.
      if (typeof d.mood === 'number') moshi.set('mood', clamp01(d.mood));
      if (typeof d.energy === 'number') moshi.set('energy', clamp01(d.energy));
      if (typeof d.heat === 'number') moshi.set('heat', clamp01(d.heat));
      // explicit state wins; otherwise fall back to a conversational rest so he
      // doesn't linger in the transient "thinking" state after a reply.
      if (d.state && STATES.indexOf(d.state) >= 0) moshi.setState(d.state);
      else if (opts.restState !== false) moshi.setState(opts.restState || 'LISTENING');
      if (d.celebrate === true && moshi.celebrate) moshi.celebrate();       // celebrate already throws ARMS_UP
      else if (d.pose && POSES.indexOf(d.pose) >= 0) moshi.setPose(d.pose, opts.poseHold || 3.2);
      if (d.say != null) emit('say', String(d.say));
    }

    async function loadProviders() {
      try {
        const r = await fetch('/api/brain/providers');
        const j = await r.json();
        providers = j.providers || [];
        if (!provider) provider = j.default || (providers[0] && providers[0].id) || null;
        emit('providers', { providers, active: provider });
      } catch (e) { emit('error', { error: 'could not reach brain proxy' }); }
      return providers;
    }

    async function send(text) {
      text = String(text || '').trim();
      if (!text || busy) return null;
      if (opts.thinkOnSend !== false) moshi.setState(thinkState);          // he ponders while the model thinks
      busy = true; emit('busy', true);                                     // (state set first, so the host can mirror it)
      history.push({ role: 'user', content: text });
      const messages = [{ role: 'system', content: SYS }].concat(history.slice(-8));
      try {
        const r = await fetch('/api/brain/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, messages }),
        });
        const j = await r.json();
        busy = false; emit('busy', false);
        if (!r.ok) { emit('error', j); return null; }
        const dir = parse(j.content);
        history.push({ role: 'assistant', content: j.content });
        apply(dir);
        emit('reply', { dir, meta: j });
        return { dir, meta: j };
      } catch (e) {
        busy = false; emit('busy', false);
        emit('error', { error: String((e && e.message) || e) });
        return null;
      }
    }

    // NB: a plain object literal so the get accessors stay live — Object.assign
    // would invoke each getter once and copy the (stale) value instead.
    return {
      on(ev, fn) { (L[ev] || (L[ev] = [])).push(fn); return this; },
      send,
      loadProviders,
      setProvider(id) { provider = id; emit('providers', { providers, active: provider }); return this; },
      getProviders() { return providers.slice(); },
      get provider() { return provider; },
      get busy() { return busy; },
      // host activity hooks (no network) — wire engine/agent events to these
      listening() { moshi.setState('LISTENING'); return this; },
      clearHistory() { history.length = 0; return this; },
    };
  }

  window.MoshiBrain = MoshiBrain;
})();
