import { useTranslation } from "react-i18next"
import { LanguageSwitcher } from "../components/LanguageSwitcher"
import { ThemeToggle } from "../components/ThemeToggle"

export const LoginPage = () => {
  const { t } = useTranslation()

  return (
    <div className="public-shell">
      <header className="public-header">
        <span className="brand">{t("app.name")}</span>
        <div className="app-header__tools">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>
      <main className="public-main">
        <div className="public-main__panel">
          <h1>{t("auth.loginTitle")}</h1>
          <p className="muted">{t("auth.loginSubtitle")}</p>
          <a className="button button--primary" href="/api/auth/login">
            {t("auth.signIn")}
          </a>
          <p className="hint">{t("auth.loginHint")}</p>
        </div>
      </main>
      <footer className="public-footer">
        <p>{t("auth.providerNote")}</p>
      </footer>
    </div>
  )
}
