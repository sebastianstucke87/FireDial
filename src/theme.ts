// Runs before the page is painted: the theme FireDial showed last, so the first paint has the
// right colors. The data comes later, from the store; this is only the page's background.

import { THEME_KEY } from './theme-key.ts'

try {
  const theme = localStorage.getItem(THEME_KEY)
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset['theme'] = theme
} catch {
  // no localStorage: the first paint is light
}
