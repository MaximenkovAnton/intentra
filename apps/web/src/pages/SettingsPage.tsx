import { useTranslation } from "react-i18next"
import { useMe } from "../api/queries"
import { LanguageSwitcher } from "../components/LanguageSwitcher"
import { ThemeToggle } from "../components/ThemeToggle"

export const SettingsPage = () => {
  const { t, i18n } = useTranslation()
  const me = useMe()
  const locale = i18n.resolvedLanguage ?? "ru"

  return (
    <section className="page" aria-labelledby="settings-title">
      <header>
        <h1 id="settings-title">{t("settings.title")}</h1>
        <p className="page__subtitle">{t("settings.subtitle")}</p>
      </header>
      <section className="section" aria-labelledby="settings-profile-title">
        <h2 id="settings-profile-title">{t("settings.profileTitle")}</h2>
        {me.status === "pending" ? <p role="status">{t("common.loading")}</p> : null}
        {me.status === "error" ? <p className="field__error">{t("errors.UNKNOWN")}</p> : null}
        {me.status === "success" ? (
          <dl className="facts">
            <dt>{t("settings.name")}</dt>
            <dd>{me.data.name}</dd>
            <dt>{t("settings.email")}</dt>
            <dd>{me.data.email}</dd>
            <dt>{t("settings.admin")}</dt>
            <dd>{me.data.isAdmin ? t("settings.adminYes") : t("settings.adminNo")}</dd>
            <dt>{t("settings.locale")}</dt>
            <dd>
              <LanguageSwitcher />
            </dd>
            <dt>{t("settings.theme")}</dt>
            <dd>
              <ThemeToggle />
            </dd>
          </dl>
        ) : null}
      </section>
      <section className="section" aria-labelledby="settings-users-title">
        <h2 id="settings-users-title">{t("settings.usersTitle")}</h2>
        <p className="hint">{t("settings.usersHint")}</p>
        <p className="hint">{t("settings.localeHint")}</p>
        <p className="muted">{locale}</p>
      </section>
    </section>
  )
}
