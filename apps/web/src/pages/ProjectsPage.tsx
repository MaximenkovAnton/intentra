import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useProjects } from "../api/queries"
import { CreateProjectDialog } from "../components/CreateProjectDialog"

export const ProjectsPage = () => {
  const { t } = useTranslation()
  const projects = useProjects()
  const apiErrorMessage = useApiErrorMessage()
  const [isCreating, setIsCreating] = useState(false)

  return (
    <section className="page" aria-labelledby="projects-title">
      <header className="page__header">
        <div>
          <h1 id="projects-title">{t("projects.title")}</h1>
          <p className="page__subtitle">{t("projects.subtitle")}</p>
        </div>
        <button type="button" className="button button--primary" onClick={() => setIsCreating(true)}>
          {t("projects.create")}
        </button>
      </header>
      {projects.status === "pending" ? <p role="status">{t("common.loading")}</p> : null}
      {projects.status === "error" ? (
        <p className="field__error" role="alert">
          {apiErrorMessage(projects.error)}
        </p>
      ) : null}
      {projects.status === "success" ? (
        projects.data.items.length === 0 ? (
          <p className="muted">{t("projects.empty")}</p>
        ) : (
          <ul className="card-list">
            {projects.data.items.map((project) => (
              <li key={project.key} className="card">
                <h2 className="card__title">{project.name}</h2>
                <p className="muted">{project.key}</p>
                {project.description !== null ? <p>{project.description}</p> : null}
                <nav className="card__actions" aria-label={t("projects.actions", { name: project.name })}>
                  <Link className="button" to="/projects/$key" params={{ key: project.key }}>
                    {t("projects.tabs.overview")}
                  </Link>
                  <Link className="button" to="/projects/$key/intents" params={{ key: project.key }}>
                    {t("projects.intents")}
                  </Link>
                  <Link className="button" to="/projects/$key/runners" params={{ key: project.key }}>
                    {t("projects.runners")}
                  </Link>
                </nav>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {isCreating ? <CreateProjectDialog onClose={() => setIsCreating(false)} /> : null}
    </section>
  )
}
