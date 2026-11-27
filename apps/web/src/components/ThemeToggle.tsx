import { useTranslation } from "react-i18next"
import { useTheme } from "../theme/ThemeProvider"

export const ThemeToggle = () => {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const nextTheme = theme === "dark" ? "light" : "dark"

  return (
    <button
      type="button"
      className="button"
      aria-pressed={theme === "dark"}
      aria-label={t("theme.toggle")}
      onClick={() => setTheme(nextTheme)}
    >
      {theme === "dark" ? t("theme.switchToLight") : t("theme.switchToDark")}
    </button>
  )
}
