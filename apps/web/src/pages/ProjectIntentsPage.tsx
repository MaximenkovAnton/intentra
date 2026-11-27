import { Link } from "@tanstack/react-router"
import { useId, useState } from "react"
import type { FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useCreateIntent, useIntents, useMyProjectRole } from "../api/queries"
import { canEdit } from "../auth/permissions"
import { StatusBadge } from "../components/StatusBadge"
import { formatDateTime } from "../i18n/format"
import { intentTone } from "../ui/status"

const TITLE_MAX_LENGTH = 200

const CreateIntentForm = ({ projectKey }: { projectKey: string }) => {
  const { t } = useTranslation()
  const createIntent = useCreateIntent(projectKey)
  const apiErrorMessage = useApiErrorMessage()
  const [title, setTitle] = useState("")
  const [statement, setStatement] = useState("")
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const statementId = useId()
  const formErrorId = useId()

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedTitle = title.trim()
    const trimmedStatement = statement.trim()
    if (trimmedTitle === "") {
      setError(t("intents.form.titleRequired"))
      return
    }
    if (trimmedTitle.length > TITLE_MAX_LENGTH) {
      setError(t("intents.form.titleTooLong"))
      return
    }
    if (trimmedStatement === "") {
      setError(t("intents.form.statementRequired"))
      return
    }
    setError(null)
    createIntent.mutate(
      { title: trimmedTitle, statement: trimmedStatement },
      {
        onSuccess: () => {
          setTitle("")
          setStatement("")
        },
      },
    )
  }

  return (
    <form className="form" onSubmit={handleSubmit} aria-label={t("intents.create")} noValidate>
      <div className="field">
        <label className="field__label" htmlFor={titleId}>
          {t("intents.form.title")}
        </label>
        <input
          id={titleId}
          className="field__input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? formErrorId : undefined}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor={statementId}>
          {t("intents.form.statement")}
        </label>
        <textarea
          id={statementId}
          className="field__textarea"
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
        />
      </div>
      {error !== null ? (
        <p className="field__error" id={formErrorId} role="alert">
          {error}
        </p>
      ) : null}
      {createIntent.isError ? (
        <p className="field__error" role="alert">
          {apiErrorMessage(createIntent.error)}
        </p>
      ) : null}
      <div className="form__actions">
        <button type="submit" className="button button--primary" disabled={createIntent.isPending}>
          {t("intents.createSubmit")}
        </button>
      </div>
    </form>
  )
}

export const ProjectIntentsPage = ({ projectKey }: { projectKey: string }) => {
  const { t, i18n } = useTranslation()
  const intents = useIntents(projectKey)
  const role = useMyProjectRole(projectKey)
  const apiErrorMessage = useApiErrorMessage()
  const locale = i18n.resolvedLanguage ?? "ru"

  return (
    <div className="page">
      {canEdit(role) ? (
        <section className="section" aria-labelledby="intents-create-title">
          <h2 id="intents-create-title">{t("intents.create")}</h2>
          <CreateIntentForm projectKey={projectKey} />
        </section>
      ) : (
        <p className="hint">{t("intents.viewerReadOnly")}</p>
      )}
      <section className="section" aria-labelledby="intents-list-title">
        <h2 id="intents-list-title">{t("intents.title")}</h2>
        {intents.status === "pending" ? <p role="status">{t("common.loading")}</p> : null}
        {intents.status === "error" ? (
          <p className="field__error" role="alert">
            {apiErrorMessage(intents.error)}
          </p>
        ) : null}
        {intents.status === "success" ? (
          intents.data.items.length === 0 ? (
            <p className="muted">{t("intents.empty")}</p>
          ) : (
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t("intents.form.title")}</th>
                    <th scope="col">{t("intents.status")}</th>
                    <th scope="col">{t("intents.created")}</th>
                    <th scope="col">{t("intents.open")}</th>
                  </tr>
                </thead>
                <tbody>
                  {intents.data.items.map((intent) => (
                    <tr key={intent.id}>
                      <td>{intent.title}</td>
                      <td>
                        <StatusBadge
                          label={t(`intents.statuses.${intent.status}`)}
                          tone={intentTone(intent.status)}
                        />
                      </td>
                      <td>{formatDateTime(intent.createdAt, locale)}</td>
                      <td>
                        <Link className="button" to="/intents/$id" params={{ id: intent.id }}>
                          {t("intents.open")}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </section>
    </div>
  )
}
