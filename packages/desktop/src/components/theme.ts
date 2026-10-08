/** 'system' removes the attribute so tokens.css follows the Windows app theme through color-scheme. */
export function applyTheme(theme: 'system' | 'light' | 'dark') {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}
