export type Theme = "light" | "dark"

export const THEME_STORAGE_KEY = "intentra.theme"

const prefersDark = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches

export const readStoredTheme = (): Theme | null => {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return stored === "light" || stored === "dark" ? stored : null
}

export const resolveInitialTheme = (): Theme => readStoredTheme() ?? (prefersDark() ? "dark" : "light")

export const applyTheme = (theme: Theme): void => {
  document.documentElement.dataset.theme = theme
}
