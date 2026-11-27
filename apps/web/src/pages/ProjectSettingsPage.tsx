import { useId, useState } from "react"
import type { FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useMyProjectRole, useProject, useUpdateProject } from "../api/queries"
import type { Project } from "../api/types"
import { canManage } from "../auth/permissions"
import { formatDateTime } from "../i18n/format"

const PROJECT_NAME_MAX_LENGTH = 120

const EditProjectForm = ({ project }: { project: Project }) => {
  const { t } = useTranslation()
  const updateProject = useUpdateProject()
  const apiErrorMessage = useApiErrorMessage()
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? "")
  const [repoUrl, setRepoUrl] = useState(project.repoUrl ?? "")
  const [defaultBranch, setDefaultBranch] = useState(project.defaultBranch)
  const [error, setError] = useState<string | null>(null)
  const nameId = useId()
  const nameErrorId = useId()
  const descriptionId = useId()
  const repoUrlId = useId()
  const branchId = useId()

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (trimmedName === "") {
      setError(t("projects.form.nameRequired"))
      return
    }
    if (trimmedName.length > PROJECT_NAME_MAX_LENGTH) {
      setError(t("projects.form.nameTooLong"))
      return
    }
    setError(null)
    const trimmedDescription = description.trim()
    const trimmedRepoUrl = repoUrl.trim()
    const trimmedBranch = defaultBranch.trim()
    updateProject.mutate({
      key: project.key,
      input: {
        name: trimmedName,
        description: trimmedDescription === "" ? null : trimmedDescription,
        repoUrl: trimmedRepoUrl === "" ? null : trimmedRepoUrl,
        defaultBranch: trimmedBranch === "" ? project.defaultBranch : trimmedBranch,
      },
    })
  }

  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label className="field__label" htmlFor={nameId}>
          {t("projects.name")}
        </label>
        <input
          id={nameId}
          className="field__input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? nameErrorId : undefined}
        />
        {error !== null ? (
          <p className="field__error" id={nameErrorId} role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label className="field__label" htmlFor={descriptionId}>
          {t("projects.description")}
        </label>
        <textarea
          id={descriptionId}
          className="field__textarea"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="form__row">
        <div className="field">
          <label className="field__label" htmlFor={repoUrlId}>
            {t("projects.repoUrl")}
          </label>
          <input
            id={repoUrlId}
            className="field__input"
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            inputMode="url"
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={branchId}>
            {t("projects.defaultBranch")}
          </label>
          <input
            id={branchId}
            className="field__input"
            value={defaultBranch}
            onChange={(event) => setDefaultBranch(event.target.value)}
          />
        </div>
      </div>
      {updateProject.isError ? (
        <p className="field__error" role="alert">
          {apiErrorMessage(updateProject.error)}
        </p>
      ) : null}
      {updateProject.isSuccess ? (
        <p className="hint" role="status">
          {t("projects.settings.renamed")}
        </p>
      ) : null}
      <div className="form__actions">
        <button type="submit" className="button button--primary" disabled={updateProject.isPending}>
          {t("common.save")}
        </button>
      </div>
    </form>
  )
}

export const ProjectSettingsPage = ({ projectKey }: { projectKey: string }) => {
  const { t, i18n } = useTranslation()
  const project = useProject(projectKey)
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
    <section className="section" aria-labelledby="project-settings-title">
      <h2 id="project-settings-title">{t("projects.settings.title")}</h2>
      {canManage(role) ? (
        <>
          <EditProjectForm project={project.data} />
          <p className="hint">{t("projects.settings.descriptionHint")}</p>
        </>
      ) : (
        <>
          <p className="hint">{t("projects.settings.readOnly")}</p>
          <dl className="facts">
            <dt>{t("projects.name")}</dt>
            <dd>{project.data.name}</dd>
            <dt>{t("projects.description")}</dt>
            <dd>{project.data.description ?? t("common.notAvailable")}</dd>
            <dt>{t("projects.repoUrl")}</dt>
            <dd>{project.data.repoUrl ?? t("common.notAvailable")}</dd>
            <dt>{t("projects.defaultBranch")}</dt>
            <dd>{project.data.defaultBranch}</dd>
            <dt>{t("projects.overview.createdLabel")}</dt>
            <dd>{formatDateTime(project.data.createdAt, locale)}</dd>
          </dl>
        </>
      )}
    </section>
  )
}
