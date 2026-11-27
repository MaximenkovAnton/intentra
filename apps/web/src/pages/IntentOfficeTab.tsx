import { useId, useState } from "react"
import type { FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import {
  useEvidence,
  useIntent,
  useIntentMessages,
  useIntentRole,
  usePostMessage,
} from "../api/queries"
import type { IntentCard } from "../api/types"
import { canEdit } from "../auth/permissions"
import { EscalationCard } from "../components/EscalationCard"
import { StatusBadge } from "../components/StatusBadge"
import { formatDateTime } from "../i18n/format"

const CardItems = ({ label, items }: { label: string; items: readonly string[] }) => (
  <div className="card-items">
    <span className="field__label">{label}</span>
    {items.length === 0 ? (
      <span className="muted">—</span>
    ) : (
      <ul className="list list--plain">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    )}
  </div>
)

const IntentCardView = ({ card }: { card: IntentCard }) => {
  const { t } = useTranslation()
  return (
    <div className="card-grid">
      <CardItems label={t("intent.office.objective")} items={[card.objective]} />
      <CardItems label={t("intent.office.users")} items={card.users} />
      <CardItems label={t("intent.office.jobs")} items={card.jobs} />
      <CardItems label={t("intent.office.inScope")} items={card.inScope} />
      <CardItems label={t("intent.office.outOfScope")} items={card.outOfScope} />
      <CardItems label={t("intent.office.constraints")} items={card.constraints} />
      <CardItems label={t("intent.office.successSignals")} items={card.successSignals} />
      <CardItems label={t("intent.office.assumptions")} items={card.assumptions} />
      <CardItems label={t("intent.office.risks")} items={card.risks} />
      <CardItems label={t("intent.office.openQuestions")} items={card.openQuestions} />
    </div>
  )
}

export const IntentOfficeTab = ({ intentId }: { intentId: string }) => {
  const { t, i18n } = useTranslation()
  const detail = useIntent(intentId)
  const { role } = useIntentRole(detail.data?.intent.projectId)
  const messages = useIntentMessages(intentId)
  const postMessage = usePostMessage(intentId)
  const evidence = useEvidence(intentId)
  const apiErrorMessage = useApiErrorMessage()
  const [body, setBody] = useState("")
  const [validation, setValidation] = useState<string | null>(null)
  const messageId = useId()
  const locale = i18n.resolvedLanguage ?? "ru"
  const canWrite = canEdit(role)

  if (detail.data === undefined) return null

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = body.trim()
    if (trimmed === "") {
      setValidation(t("intent.office.messageRequired"))
      return
    }
    setValidation(null)
    postMessage.mutate({ body: trimmed }, { onSuccess: () => setBody("") })
  }

  return (
    <div className="page">
      <section className="section" aria-labelledby="intent-card-title">
        <h2 id="intent-card-title">{t("intent.office.cardTitle")}</h2>
        {detail.data.card === null ? (
          <p className="muted">{t("intent.office.cardEmpty")}</p>
        ) : (
          <IntentCardView card={detail.data.card} />
        )}
      </section>
      <section className="section" aria-labelledby="intent-escalations-title">
        <h2 id="intent-escalations-title">{t("intent.office.escalationsTitle")}</h2>
        {detail.data.openEscalations.length === 0 ? (
          <p className="muted">{t("intent.office.escalationsEmpty")}</p>
        ) : (
          detail.data.openEscalations.map((escalation) => (
            <EscalationCard
              key={escalation.id}
              escalation={escalation}
              intentId={intentId}
              canAnswer={canWrite}
            />
          ))
        )}
      </section>
      <section className="section" aria-labelledby="intent-chat-title">
        <h2 id="intent-chat-title">{t("intent.office.chatTitle")}</h2>
        <p className="hint">{t("intent.office.chatHint")}</p>
        <ul className="chat" aria-label={t("intent.office.chatTitle")}>
          {messages.data?.length === 0 ? (
            <li className="muted">{t("intent.office.chatEmpty")}</li>
          ) : (
            messages.data?.map((message) => (
              <li key={message.id} className={`chat__message chat__message--${message.role}`}>
                <span className="chat__meta">
                  <span className="badge">{t(`intent.office.roles.${message.role}`)}</span>
                  <span className="muted">{formatDateTime(message.createdAt, locale)}</span>
                </span>
                <span className="chat__body">{message.body}</span>
              </li>
            ))
          )}
        </ul>
        {canWrite ? (
          <form className="form" onSubmit={handleSubmit} noValidate>
            <div className="field">
              <label className="field__label" htmlFor={messageId}>
                {t("intent.office.messageLabel")}
              </label>
              <textarea
                id={messageId}
                className="field__textarea"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder={t("intent.office.messagePlaceholder")}
                aria-invalid={validation !== null}
              />
            </div>
            {validation !== null ? (
              <p className="field__error" role="alert">
                {validation}
              </p>
            ) : null}
            {postMessage.isError ? (
              <p className="field__error" role="alert">
                {apiErrorMessage(postMessage.error)}
              </p>
            ) : null}
            <div className="form__actions">
              <button
                type="submit"
                className="button button--primary"
                disabled={postMessage.isPending}
              >
                {t("intent.office.send")}
              </button>
            </div>
          </form>
        ) : (
          <p className="hint">{t("intent.office.readOnly")}</p>
        )}
      </section>
      <section className="section" aria-labelledby="intent-decisions-title">
        <h2 id="intent-decisions-title">{t("intent.office.decisionsTitle")}</h2>
        {evidence.status === "pending" ? <p role="status">{t("common.loading")}</p> : null}
        {evidence.status === "error" ? (
          <p className="field__error" role="alert">
            {apiErrorMessage(evidence.error)}
          </p>
        ) : null}
        {evidence.status === "success" ? (
          evidence.data.decisions.length === 0 ? (
            <p className="muted">{t("intent.office.decisionsEmpty")}</p>
          ) : (
            <ul className="list">
              {evidence.data.decisions.map((decision) => (
                <li key={decision.id} className="list__item list__item--stacked">
                  <span className="field__label">{decision.question}</span>
                  <span>{decision.answer}</span>
                  {decision.rationale === null ? null : (
                    <span className="muted">{decision.rationale}</span>
                  )}
                  <StatusBadge
                    label={t(`intent.office.decisionStatuses.${decision.status}`)}
                    tone={decision.status === "accepted" ? "success" : "warning"}
                  />
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
    </div>
  )
}
