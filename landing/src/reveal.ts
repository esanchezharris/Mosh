// Scroll-triggered reveal for below-the-fold sections. The hero's own
// entrance is pure CSS (motion.css) so it works even if this never runs;
// this module only handles [data-reveal] elements further down the page.
export function initScrollReveal(): void {
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))
  if (items.length === 0) return

  // Stagger siblings within the same parent by DOM order — a light visual
  // nicety, not load-bearing.
  const seenPerParent = new Map<Element | null, number>()
  for (const el of items) {
    const parent = el.parentElement
    const i = seenPerParent.get(parent) ?? 0
    el.style.setProperty('--reveal-i', String(Math.min(i, 6)))
    seenPerParent.set(parent, i + 1)
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reducedMotion || !('IntersectionObserver' in window)) {
    for (const el of items) el.classList.add('is-visible')
    return
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('is-visible')
        observer.unobserve(entry.target)
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
  )

  for (const el of items) observer.observe(el)
}
