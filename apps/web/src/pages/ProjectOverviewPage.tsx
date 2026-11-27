import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useIntents, useMembers, useMyProjectRole, useProject } from "../api/queries"
import { formatDateTime } from "../i18n/format"
import { StatusBadge } from "../components/StatusBadge"
import { intentTone } from "../ui/status"

const Count = ({ label, value }: { label: string; value: number }) => (
  <div className="stat">
    <span className="stat__value">{value}</span>
    <span className="stat__label">{label}</span>
  </div>
)

export const ProjectOverviewPage = ({ projectKey }: { projectKey: string }) => {
  const { t, i18n } = useTranslation()
  const project = useProject(projectKey)
  const members = useMembers(projectKey)
  const intents = useIntents(projectKey)
  const role = useMyProjectRole(projectKey)
  const apiErrorMessage = useApiErrorMessage()
  const locale = i18n.resolvedLanguage ?? "ru"

  if (project.status === "pending") return <p role="status">{t("common.loading")}</p>
  if (project.status === "error") {
    return (
      <p className="field__error" role="alert">
        {apiErrorMessage(project.error)}
      </p>
    )
  }

  return (
    <div className="page">
      <section className="section" aria-labelledby="project-overview-title">
        <h2 id="project-overview-title">{t("projects.overview.title")}</h2>
        {project.data.description === null ? (
          <p className="muted">{t("projects.overview.descriptionMissing")}</p>
        ) : (
          <p>{project.data.description}</p>
        )}
        <dl className="facts">
          <dt>{t("projects.overview.repoLabel")}</dt>
          <dd>
            {project.data.repoUrl === null ? (
              t("common.notAvailable")
            ) : (
              <a href={project.data.repoUrl} target="_blank" rel="noopener noreferrer">
                {project.data.repoUrl}
              </a>
            )}
          </dd>
          <dt>{t("projects.overview.branchLabel")}</dt>
          <dd>{project.data.defaultBranch}</dd>
          <dt>{t("projects.overview.createdLabel")}</dt>
          <dd>{formatDateTime(project.data.createdAt, locale)}</dd>
          <dt>{t("projects.overview.roleLabel")}</dt>
          <dd>
            {role === null ? t("common.notAvailable") : t(`projects.members.roles.${role}`)}
          </dd>
        </dl>
        <div className="stats">
          <Count label={t("projects.overview.membersCount")} value={members.data?.items.length ?? 0} />
          <Count label={t("projects.overview.intentsCount")} value={intents.data?.items.length ?? 0} />
        </div>
      </section>
      <section className="section" aria-labelledby="project-recent-intents-title">
        <div className="page__header">
          <h2 id="project-recent-intents-title">{t("projects.overview.recentIntents")}</h2>
          <Link className="button" to="/projects/$key/intents" params={{ key: projectKey }}>
            {t("projects.tabs.intents")}
          </Link>
        </div>
        {intents.status === "pending" ? <p role="status">{t("common.loading")}</p> : null}
        {intents.status === "error" ? (
          <p className="field__error" role="alert">
            {apiErrorMessage(intents.error)}
          </p>
        ) : null}
        {intents.status === "success" ? (
          intents.data.items.length === 0 ? (
            <p className="muted">{t("projects.overview.noIntents")}</p>
          ) : (
            <ul className="list">
              {intents.data.items.slice(0, 5).map((intent) => (
                <li key={intent.id} className="list__item">
                  <Link to="/intents/$id" params={{ id: intent.id }}>
                    {intent.title}
                  </Link>
                  <StatusBadge
                    label={t(`intents.statuses.${intent.status}`)}
                    tone={intentTone(intent.status)}
                  />
                  <span className="muted">{formatDateTime(intent.createdAt, locale)}</span>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
    </div>
  )
}
