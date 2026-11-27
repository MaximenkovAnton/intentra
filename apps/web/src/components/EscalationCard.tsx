import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useAnswerEscalation } from "../api/queries"
import type { Escalation } from "../api/types"
import { formatDateTime } from "../i18n/format"

type Props = {
  escalation: Escalation
  intentId: string
  canAnswer: boolean
}

export const EscalationCard = ({ escalation, intentId, canAnswer }: Props) => {
  const { t, i18n } = useTranslation()
  const answer = useAnswerEscalation(intentId)
  const apiErrorMessage = useApiErrorMessage()
  const [selected, setSelected] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [validation, setValidation] = useState<string | null>(null)
  const groupId = useId()
  const noteId = useId()
  const errorId = useId()
  const locale = i18n.resolvedLanguage ?? "ru"
  const recommendedId = escalation.options.some((option) => option.id === escalation.recommendation)
    ? escalation.recommendation
    : null
  const recommendationText = recommendedId === null ? escalation.recommendation : null

  const handleSubmit = () => {
    if (selected === null) {
      setValidation(t("intent.office.optionRequired"))
      return
    }
    setValidation(null)
    const trimmedNote = note.trim()
    answer.mutate({
      escalationId: escalation.id,
      optionId: selected,
      ...(trimmedNote === "" ? {} : { note: trimmedNote }),
    })
  }

  return (
    <article className="section escalation" aria-labelledby={`${groupId}-question`}>
      <h3 id={`${groupId}-question`} className="escalation__question">
        {escalation.question}
      </h3>
      <p className="muted">{escalation.context}</p>
      <p className="hint">
        {t("intent.office.stage")}: {escalation.stage}
        {escalation.expiresAt === null
          ? null
          : ` · ${t("intent.office.expires", { date: formatDateTime(escalation.expiresAt, locale) })}`}
      </p>
      <fieldset className="escalation__options">
        <legend>{t("intent.office.optionsLabel")}</legend>
        {escalation.options.map((option) => {
          const inputId = `${groupId}-${option.id}`
          return (
            <div key={option.id} className="escalation__option">
              <input
                id={inputId}
                type="radio"
                name={groupId}
                value={option.id}
                checked={selected === option.id}
                disabled={!canAnswer || answer.isPending}
                onChange={() => setSelected(option.id)}
              />
              <label htmlFor={inputId} className="escalation__option-label">
                <span className="escalation__option-title">
                  {option.label}
                  {recommendedId === option.id ? (
                    <span className="badge badge--warning">{t("intent.office.recommendation")}</span>
                  ) : null}
                  {escalation.defaultOption === option.id ? (
                    <span className="badge">{t("intent.office.defaultOption")}</span>
                  ) : null}
                  {option.reversible === true ? (
                    <span className="badge badge--success">{t("intent.office.reversible")}</span>
                  ) : null}
                  {option.reversible === false ? (
                    <span className="badge badge--danger">{t("intent.office.irreversible")}</span>
                  ) : null}
                </span>
                {option.meaning === undefined ? null : (
                  <span className="muted">{option.meaning}</span>
                )}
                {option.when === undefined ? null : (
                  <span className="hint">
                    {t("intent.office.optionWhen")}: {option.when}
                  </span>
                )}
                {option.cost === undefined ? null : (
                  <span className="hint">
                    {t("intent.office.optionCost")}: {option.cost}
                  </span>
                )}
                {option.risk === undefined ? null : (
                  <span className="hint">
                    {t("intent.office.optionRisk")}: {option.risk}
                  </span>
                )}
              </label>
            </div>
          )
        })}
      </fieldset>
      {recommendationText === null ? null : (
        <p className="hint">
          {t("intent.office.recommendationText")}: {recommendationText}
        </p>
      )}
      <p className="hint">
        {t("intent.office.defaultText")}:{" "}
        {escalation.options.find((option) => option.id === escalation.defaultOption)?.label ??
          escalation.defaultOption}
      </p>
      {canAnswer ? (
        <>
          <div className="field">
            <label className="field__label" htmlFor={noteId}>
              {t("intent.office.note")}
            </label>
            <textarea
              id={noteId}
              className="field__textarea"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t("intent.office.notePlaceholder")}
            />
          </div>
          {validation !== null ? (
            <p className="field__error" id={errorId} role="alert">
              {validation}
            </p>
          ) : null}
          {answer.isError ? (
            <p className="field__error" role="alert">
              {apiErrorMessage(answer.error)}
            </p>
          ) : null}
          <div className="form__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={handleSubmit}
              disabled={answer.isPending}
            >
              {t("intent.office.answer")}
            </button>
          </div>
        </>
      ) : (
        <p className="hint">{t("intent.office.readOnly")}</p>
      )}
    </article>
  )
}
