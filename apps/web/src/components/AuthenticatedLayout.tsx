import { Link, Outlet, useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { isAuthRequiredError } from "../api/errors"
import { useLogout, useMe } from "../api/queries"
import { LanguageSwitcher } from "./LanguageSwitcher"
import { ThemeToggle } from "./ThemeToggle"

export const AuthenticatedLayout = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const me = useMe()
  const logout = useLogout()
  const apiErrorMessage = useApiErrorMessage()
  const shouldRedirect = me.status === "error" && isAuthRequiredError(me.error)

  useEffect(() => {
    if (shouldRedirect) void navigate({ to: "/login", replace: true })
  }, [shouldRedirect, navigate])

  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        const query = event.query
        if (query.state.status === "error" && isAuthRequiredError(query.state.error)) {
          void navigate({ to: "/login", replace: true })
        }
      }),
    [queryClient, navigate],
  )

  if (me.status === "pending") {
    return (
      <main className="status-screen" aria-busy="true">
        <p role="status">{t("common.loading")}</p>
      </main>
    )
  }

  if (me.status === "error") {
    return (
      <main className="status-screen">
        <p role="alert">{shouldRedirect ? t("auth.redirecting") : apiErrorMessage(me.error)}</p>
        <a className="button" href="/api/auth/login">
          {t("auth.signIn")}
        </a>
      </main>
    )
  }

  const handleLogout = async () => {
    const result = await logout.mutateAsync().catch(() => undefined)
    if (result?.redirectUrl) {
      window.location.assign(result.redirectUrl)
      return
    }
    await navigate({ to: "/login", replace: true })
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        {t("common.skipToContent")}
      </a>
      <header className="app-header">
        <Link to="/" className="brand">
          {t("app.name")}
        </Link>
        <nav className="app-nav" aria-label={t("nav.primary")}>
          <Link
            to="/"
            className="nav-link"
            activeProps={{ "aria-current": "page" }}
          >
            {t("nav.projects")}
          </Link>
          <Link to="/runners" className="nav-link" activeProps={{ "aria-current": "page" }}>
            {t("nav.runners")}
          </Link>
          <Link to="/memory" className="nav-link" activeProps={{ "aria-current": "page" }}>
            {t("nav.memory")}
          </Link>
          <Link to="/settings" className="nav-link" activeProps={{ "aria-current": "page" }}>
            {t("nav.settings")}
          </Link>
        </nav>
        <div className="app-header__tools">
          <span className="user-name" title={me.data.email}>
            {me.data.name}
          </span>
          <LanguageSwitcher />
          <ThemeToggle />
          <button type="button" className="button" onClick={handleLogout} disabled={logout.isPending}>
            {t("auth.logout")}
          </button>
        </div>
      </header>
      <main id="main-content" className="app-main">
        <Outlet />
      </main>
    </div>
  )
}
