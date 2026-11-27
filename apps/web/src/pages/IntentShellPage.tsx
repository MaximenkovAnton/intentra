import { Link, Outlet } from "@tanstack/react-router"
import { useEffect, useId, useRef, useState } from "react"
import type { FormEvent, KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useProjectEvents } from "../api/events"
import {
  useAcceptIntent,
  useCancelIntent,
  useEvidence,
  useIntent,
  useIntentRole,
  useRetryIntent,
  useReworkIntent,
} from "../api/queries"
import type { ReworkIntentInput } from "../api/types"
import { canEdit, canManage } from "../auth/permissions"
import { StatusBadge } from "../components/StatusBadge"
import { intentTone } from "../ui/status"

const TERMINAL = new Set(["accepted", "rejected", "cancelled"])

type ReworkTarget = ReworkIntentInput["target"]

const ReworkForm = ({ intentId, onClose }: { intentId: string; onClose: () => void }) => {
  const { t } = useTranslation()
  const rework = useReworkIntent(intentId)
  const apiErrorMessage = useApiErrorMessage()
  const [reason, setReason] = useState("")
  const [target, setTarget] = useState<ReworkTarget>("build")
  const [error, setError] = useState<string | null>(null)
  const reasonId = useId()
  const targetId = useId()

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = reason.trim()
    if (trimmed === "") {
      setError(t("intent.actions.reworkReasonRequired"))
      return
    }
    setError(null)
    rework.mutate({ reason: trimmed, target }, { onSuccess: () => onClose() })
  }

  return (
    <form className="form" onSubmit={handleSubmit} aria-label={t("intent.actions.rework")} noValidate>
      <div className="field">
        <label className="field__label" htmlFor={reasonId}>
          {t("intent.actions.reworkReason")}
        </label>
        <textarea
          id={reasonId}
          className="field__textarea"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          aria-invalid={error !== null}
        />
        {error !== null ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label className="field__label" htmlFor={targetId}>
          {t("intent.actions.reworkTarget")}
        </label>
        <select
          id={targetId}
          className="field__select"
          value={target}
          onChange={(event) => {
            if (event.target.value === "build" || event.target.value === "plan") {
              setTarget(event.target.value)
            }
          }}
        >
          <option value="build">{t("intent.actions.targets.build")}</option>
          <option value="plan">{t("intent.actions.targets.plan")}</option>
        </select>
      </div>
      {rework.isError ? (
        <p className="field__error" role="alert">
          {apiErrorMessage(rework.error)}
        </p>
      ) : null}
      <div className="form__actions">
        <button type="submit" className="button button--primary" disabled={rework.isPending}>
          {t("intent.actions.reworkSubmit")}
        </button>
        <button type="button" className="button" onClick={onClose}>
          {t("common.cancel")}
        </button>
      </div>
    </form>
  )
}

const CancelConfirm = ({ intentId, onClose }: { intentId: string; onClose: () => void }) => {
  const { t } = useTranslation()
  const cancel = useCancelIntent(intentId)
  const apiErrorMessage = useApiErrorMessage()
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose])

  const handleTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || dialogRef.current === null) return
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (first === undefined || last === undefined) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleTab}
      >
        <h2 id={titleId} className="dialog__title">
          {t("intent.actions.cancelConfirm")}
        </h2>
        {cancel.isError ? (
          <p className="field__error" role="alert">
            {apiErrorMessage(cancel.error)}
          </p>
        ) : null}
        <div className="form__actions">
          <button
            type="button"
            className="button button--danger"
            onClick={() => cancel.mutate(undefined, { onSuccess: onClose })}
            disabled={cancel.isPending}
          >
            {t("intent.actions.cancelConfirmSubmit")}
          </button>
          <button type="button" className="button" onClick={onClose} autoFocus>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  )
}

export const IntentShellPage = ({ intentId }: { intentId: string }) => {
  const { t } = useTranslation()
  const intent = useIntent(intentId)
  const evidence = useEvidence(intentId)
  const { projectKey, role } = useIntentRole(intent.data?.intent.projectId)
  const accept = useAcceptIntent(intentId)
  const retry = useRetryIntent(intentId)
  const apiErrorMessage = useApiErrorMessage()
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const [isReworking, setIsReworking] = useState(false)
  const [isConfirmingCancel, setIsConfirmingCancel] = useState(false)
  useProjectEvents(projectKey)

  const closeCancelConfirm = () => {
    setIsConfirmingCancel(false)
    cancelButtonRef.current?.focus()
  }

  if (intent.status === "pending") {
    return (
      <main className="status-screen" aria-busy="true">
        <p role="status">{t("common.loading")}</p>
      </main>
    )
  }

  if (intent.status === "error") {
    return (
      <section className="page">
        <p className="field__error" role="alert">
          {apiErrorMessage(intent.error)}
        </p>
        <Link className="button" to="/projects">
          {t("notFound.back")}
        </Link>
      </section>
    )
  }

  const data = intent.data
  const terminal = TERMINAL.has(data.intent.status)
  const manage = canManage(role)
  const edit = canEdit(role)
  const stages = evidence.data?.stages ?? []
  const latestStage = stages.at(-1)
  const hasActiveStage = stages.some(
    (stage) => stage.status === "pending" || stage.status === "running",
  )
  const failureReason =
    !terminal &&
    !hasActiveStage &&
    latestStage !== undefined &&
    (latestStage.status === "failed" || latestStage.status === "blocked")
      ? latestStage.error
      : null

  return (
    <section className="page" aria-labelledby="intent-title">
      <header className="page__header">
        <div>
          <h1 id="intent-title">{data.intent.title}</h1>
          <p className="page__subtitle">
            <StatusBadge
              label={t(`intents.statuses.${data.intent.status}`)}
              tone={intentTone(data.intent.status)}
            />
            {projectKey === null ? null : (
              <>
                {" · "}
                <Link to="/projects/$key/intents" params={{ key: projectKey }}>
                  {t("intent.backToProject")}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="button-row">
          {manage && data.intent.status === "awaiting_acceptance" ? (
            <button
              type="button"
              className="button button--primary"
              onClick={() => accept.mutate()}
              disabled={accept.isPending}
            >
              {t("intent.actions.accept")}
            </button>
          ) : null}
          {manage && data.intent.status === "awaiting_acceptance" ? (
            <button
              type="button"
              className="button"
              onClick={() => setIsReworking(true)}
            >
              {t("intent.actions.rework")}
            </button>
          ) : null}
          {edit && data.intent.status === "draft" ? (
            <button
              type="button"
              className="button button--primary"
              onClick={() => retry.mutate()}
              disabled={retry.isPending}
            >
              {t("intent.actions.retry")}
            </button>
          ) : null}
          {edit && !terminal ? (
            <button
              ref={cancelButtonRef}
              type="button"
              className="button button--danger"
              onClick={() => setIsConfirmingCancel(true)}
            >
              {t("intent.actions.cancel")}
            </button>
          ) : null}
        </div>
      </header>
      {failureReason === null ? null : (
        <section className="section" role="alert">
          <h2>{t("intent.failure.title")}</h2>
          <p className="field__error">{failureReason}</p>
        </section>
      )}
      <p>{data.intent.statement}</p>
      {accept.isError ? (
        <p className="field__error" role="alert">
          {apiErrorMessage(accept.error)}
        </p>
      ) : null}
      {retry.isError ? (
        <p className="field__error" role="alert">
          {apiErrorMessage(retry.error)}
        </p>
      ) : null}
      {isReworking ? (
        <ReworkForm intentId={intentId} onClose={() => setIsReworking(false)} />
      ) : null}
      {isConfirmingCancel ? (
        <CancelConfirm intentId={intentId} onClose={closeCancelConfirm} />
      ) : null}
      <nav className="tabs" aria-label={t("intent.tabsLabel")}>
        <Link
          className="tab"
          activeProps={{ "aria-current": "page" }}
          activeOptions={{ exact: true }}
          to="/intents/$id"
          params={{ id: intentId }}
        >
          {t("intent.tabs.office")}
        </Link>
        <Link
          className="tab"
          activeProps={{ "aria-current": "page" }}
          to="/intents/$id/spec"
          params={{ id: intentId }}
        >
          {t("intent.tabs.spec")}
        </Link>
        <Link
          className="tab"
          activeProps={{ "aria-current": "page" }}
          to="/intents/$id/critic"
          params={{ id: intentId }}
        >
          {t("intent.tabs.critic")}
        </Link>
        <Link
          className="tab"
          activeProps={{ "aria-current": "page" }}
          to="/intents/$id/plan"
          params={{ id: intentId }}
        >
          {t("intent.tabs.plan")}
        </Link>
        <Link
          className="tab"
          activeProps={{ "aria-current": "page" }}
          to="/intents/$id/build"
          params={{ id: intentId }}
        >
          {t("intent.tabs.build")}
        </Link>
        <Link
          className="tab"
          activeProps={{ "aria-current": "page" }}
          to="/intents/$id/memory"
          params={{ id: intentId }}
        >
          {t("intent.tabs.memory")}
        </Link>
        <Link
          className="tab"
          activeProps={{ "aria-current": "page" }}
          to="/intents/$id/evidence"
          params={{ id: intentId }}
        >
          {t("intent.tabs.evidence")}
        </Link>
      </nav>
      <Outlet />
    </section>
  )
}
