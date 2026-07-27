// Light/dark toggle. The *initial* theme is stamped onto <html data-theme> by
// a tiny synchronous inline script in index.html's <head> (before first
// paint, so there's no flash-of-wrong-theme) — this module only wires up the
// interactive toggle button afterwards. STORAGE_KEY must stay in sync with
// the literal used in that inline script.
const STORAGE_KEY = 'mosh-landing-theme'

type Theme = 'light' | 'dark'

function systemPrefersLight(): boolean {
  return window.matchMedia('(prefers-color-scheme: light)').matches
}

function currentTheme(): Theme {
  const stamped = document.documentElement.getAttribute('data-theme')
  if (stamped === 'light' || stamped === 'dark') return stamped
  return systemPrefersLight() ? 'light' : 'dark'
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.style.colorScheme = theme
}

export function initThemeToggle(button: HTMLButtonElement): void {
  button.setAttribute('aria-pressed', String(currentTheme() === 'light'))

  button.addEventListener('click', () => {
    const next: Theme = currentTheme() === 'light' ? 'dark' : 'light'
    applyTheme(next)
    button.setAttribute('aria-pressed', String(next === 'light'))
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Private-browsing / storage-locked contexts can throw. The toggle
      // still works for the session; it just won't persist across reloads.
    }
  })
}
