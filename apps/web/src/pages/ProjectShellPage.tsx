import { Link, Outlet } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useProjectEvents } from "../api/events"
import { useProject } from "../api/queries"

export const ProjectShellPage = ({ projectKey }: { projectKey: string }) => {
  const { t } = useTranslation()
  const project = useProject(projectKey)
  const apiErrorMessage = useApiErrorMessage()
  useProjectEvents(projectKey)

  if (project.status === "pending") {
    return (
      <main className="status-screen" aria-busy="true">
        <p role="status">{t("common.loading")}</p>
      </main>
    )
  }

  if (project.status === "error") {
    return (
      <section className="page">
        <p className="field__error" role="alert">
          {apiErrorMessage(project.error)}
        </p>
        <Link className="button" to="/projects">
          {t("notFound.back")}
        </Link>
      </section>
    )
  }

  return (
    <section className="page" aria-labelledby="project-title">
      <header>
        <h1 id="project-title">{project.data.name}</h1>
        <p className="page__subtitle">{project.data.key}</p>
      </header>
      <nav className="tabs" aria-label={t("projects.tabsLabel")}>
        <Link
          className="tab"
          activeProps={{ "aria-current": "page" }}
          activeOptions={{ exact: true }}
          to="/projects/$key"
          params={{ key: projectKey }}
        >
          {t("projects.tabs.overview")}
        </Link>
        <Link
          className="tab"
          activeProps={{ "aria-current": "page" }}
          to="/projects/$key/members"
          params={{ key: projectKey }}
        >
          {t("projects.tabs.members")}
        </Link>
        <Link
          className="tab"
          activeProps={{ "aria-current": "page" }}
          to="/projects/$key/settings"
          params={{ key: projectKey }}
        >
          {t("projects.tabs.settings")}
        </Link>
        <Link
          className="tab"
          activeProps={{ "aria-current": "page" }}
          to="/projects/$key/runners"
          params={{ key: projectKey }}
        >
          {t("projects.tabs.runners")}
        </Link>
        <Link
          className="tab"
          activeProps={{ "aria-current": "page" }}
          to="/projects/$key/intents"
          params={{ key: projectKey }}
        >
          {t("projects.tabs.intents")}
        </Link>
        <Link
          className="tab"
          activeProps={{ "aria-current": "page" }}
          to="/projects/$key/memory"
          params={{ key: projectKey }}
        >
          {t("projects.tabs.memory")}
        </Link>
      </nav>
      <Outlet />
    </section>
  )
}
