import { useTranslation } from "react-i18next"
import { isLocale } from "../i18n"

export const LanguageSwitcher = () => {
  const { t, i18n } = useTranslation()
  const current = i18n.resolvedLanguage === "en" ? "en" : "ru"

  return (
    <select
      className="field__select"
      aria-label={t("language.label")}
      value={current}
      onChange={(event) => {
        const next = event.target.value
        if (isLocale(next)) void i18n.changeLanguage(next)
      }}
    >
      <option value="ru">{t("language.ru")}</option>
      <option value="en">{t("language.en")}</option>
    </select>
  )
}
