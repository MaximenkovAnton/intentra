import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useProjects } from "../api/queries"

export const MemoryPage = () => {
  const { t } = useTranslation()
  const apiErrorMessage = useApiErrorMessage()
  const projects = useProjects()

  return (
    <section className="page" aria-labelledby="memory-title">
      <header>
        <h1 id="memory-title">{t("memory.title")}</h1>
        <p className="page__subtitle">{t("memory.subtitle")}</p>
      </header>
      {projects.status === "pending" ? <p role="status">{t("common.loading")}</p> : null}
      {projects.status === "error" ? (
        <p className="field__error" role="alert">
          {apiErrorMessage(projects.error)}
        </p>
      ) : null}
      {projects.status === "success" ? (
        projects.data.items.length === 0 ? (
          <p className="muted">{t("memory.chooseProject")}</p>
        ) : (
          <>
            <p className="hint">{t("memory.chooseProject")}</p>
            <ul className="card-list">
              {projects.data.items.map((project) => (
                <li key={project.id} className="card">
                  <h2 className="card__title">{project.name}</h2>
                  <p className="muted">{project.key}</p>
                  <div className="card__actions">
                    <Link
                      className="button"
                      to="/projects/$key/memory"
                      params={{ key: project.key }}
                    >
                      {t("memory.openProject")}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
    </section>
  )
}
