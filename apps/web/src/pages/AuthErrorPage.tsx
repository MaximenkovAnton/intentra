import { useTranslation } from "react-i18next"
import { LanguageSwitcher } from "../components/LanguageSwitcher"
import { ThemeToggle } from "../components/ThemeToggle"

export const AuthErrorPage = ({ errorCode }: { errorCode: string | undefined }) => {
  const { t } = useTranslation()
  const message =
    errorCode === undefined
      ? t("auth.error.UNKNOWN")
      : t(`auth.error.${errorCode}`, { defaultValue: t("auth.error.UNKNOWN") })

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
          <h1>{t("auth.errorTitle")}</h1>
          <p role="alert">{message}</p>
          <a className="button button--primary" href="/api/auth/login">
            {t("auth.errorRetry")}
          </a>
          <a className="button" href="/login">
            {t("auth.errorBack")}
          </a>
        </div>
      </main>
      <footer className="public-footer">
        <p>{t("auth.providerNote")}</p>
      </footer>
    </div>
  )
}
