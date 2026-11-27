import { useId, useState } from "react"
import type { FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useUpdateRunnerPolicy } from "../api/queries"
import type { Runner } from "../api/types"
import { formatDateTime } from "../i18n/format"
import { runnerUpdateStatus, runnerUpdateTone } from "../ui/status"
import { StatusBadge } from "./StatusBadge"

export const RunnerUpdateCell = ({ runner, canManage }: { runner: Runner; canManage: boolean }) => {
  const { t, i18n } = useTranslation()
  const updatePolicy = useUpdateRunnerPolicy()
  const apiErrorMessage = useApiErrorMessage()
  const pinInputId = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const locale = i18n.resolvedLanguage ?? "ru"
  const status = runnerUpdateStatus(runner)
  const pinValue = draft ?? runner.pinnedVersion ?? ""

  const savePolicy = (
    pinnedVersion: string | null,
    autoUpdate: boolean,
    options?: { clearDraft: boolean },
  ) => {
    updatePolicy.mutate(
      { runnerId: runner.id, input: { pinnedVersion, autoUpdate } },
      options?.clearDraft === true ? { onSuccess: () => setDraft(null) } : undefined,
    )
  }

  const handlePin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const pinnedVersion = pinValue.trim()
    savePolicy(pinnedVersion === "" ? null : pinnedVersion, runner.autoUpdate, { clearDraft: true })
  }

  return (
    <div className="update-cell">
      <div className="badge-row">
        <StatusBadge label={t(`runners.updates.statuses.${status}`)} tone={runnerUpdateTone(status)} />
        {runner.updateAvailable && status !== "available" ? (
          <span className="badge badge--warning">{t("runners.updates.availableBadge")}</span>
        ) : null}
      </div>
      <span className="hint">
        {t("runners.updates.lastEvent")}:{" "}
        <span>
          {runner.lastUpdate === null
            ? t("common.notAvailable")
            : formatDateTime(runner.lastUpdate.createdAt, locale)}
        </span>
      </span>
      {canManage ? (
        <form className="update-policy" onSubmit={handlePin} noValidate>
          <div className="update-policy__row">
            <div className="field update-policy__pin">
              <label className="field__label" htmlFor={pinInputId}>
                {t("runners.updates.pinLabel")}
              </label>
              <input
                id={pinInputId}
                className="field__input"
                value={pinValue}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={t("runners.updates.pinPlaceholder")}
                autoComplete="off"
                spellCheck={false}
                disabled={updatePolicy.isPending}
              />
            </div>
            <div className="button-row">
              <button type="submit" className="button" disabled={updatePolicy.isPending}>
                {t("runners.updates.pin")}
              </button>
              <button
                type="button"
                className="button"
                onClick={() => savePolicy(null, runner.autoUpdate, { clearDraft: true })}
                disabled={
                  updatePolicy.isPending || (runner.pinnedVersion === null && draft === null)
                }
              >
                {t("runners.updates.reset")}
              </button>
            </div>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={runner.autoUpdate}
              onChange={(event) => savePolicy(runner.pinnedVersion, event.target.checked)}
              disabled={updatePolicy.isPending}
            />
            {t("runners.updates.autoUpdate")}
          </label>
          {updatePolicy.isError ? (
            <p className="field__error" role="alert">
              {apiErrorMessage(updatePolicy.error)}
            </p>
          ) : null}
        </form>
      ) : (
        <span className="hint">
          {runner.pinnedVersion === null
            ? t("runners.updates.notPinned")
            : t("runners.updates.pinned", { version: runner.pinnedVersion })}
          {" · "}
          {t("runners.updates.autoUpdate")}:{" "}
          {runner.autoUpdate ? t("runners.updates.autoUpdateOn") : t("runners.updates.autoUpdateOff")}
        </span>
      )}
    </div>
  )
}
