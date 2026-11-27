import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useSpec } from "../api/queries"
import { isNotFoundError } from "../api/errors"
import { StatusBadge } from "../components/StatusBadge"
import type { DodRow, Requirement } from "../api/types"

const SPEC_STATUS_TONE = {
  draft: "neutral",
  in_review: "warning",
  approved: "success",
  superseded: "danger",
} as const

const DodRows = ({ requirement, rows }: { requirement: Requirement; rows: readonly DodRow[] }) => {
  const { t } = useTranslation()
  const own = rows.filter((row) => row.requirementId === requirement.id)
  if (own.length === 0) return <p className="muted">{t("intent.spec.dodEmpty")}</p>
  return (
    <ul className="list list--plain">
      {own.map((row) => (
        <li key={row.id}>
          <span className="badge">{t(`intent.spec.dodStatuses.${row.status}`)}</span>{" "}
          {row.testRef === null ? null : <code>{row.testRef}</code>}
          {row.probe === null ? null : <span className="muted"> · {row.probe}</span>}
        </li>
      ))}
    </ul>
  )
}

export const IntentSpecTab = ({ intentId }: { intentId: string }) => {
  const { t } = useTranslation()
  const spec = useSpec(intentId)
  const apiErrorMessage = useApiErrorMessage()

  if (spec.status === "pending") return <p role="status">{t("common.loading")}</p>
  if (spec.status === "error") {
    return isNotFoundError(spec.error) ? (
      <div className="notice">
        <p>{t("intent.spec.notReady")}</p>
        <p className="hint">{t("intent.spec.notReadyHint")}</p>
      </div>
    ) : (
      <p className="field__error" role="alert">
        {apiErrorMessage(spec.error)}
      </p>
    )
  }

  const bundle = spec.data
  return (
    <div className="page">
      <section className="section" aria-labelledby="spec-meta-title">
        <h2 id="spec-meta-title">{t("intent.spec.title")}</h2>
        <dl className="facts">
          <dt>{t("intent.spec.version")}</dt>
          <dd>{bundle.spec.version}</dd>
          <dt>{t("intent.spec.status")}</dt>
          <dd>
            <StatusBadge
              label={t(`intent.spec.statuses.${bundle.spec.status}`)}
              tone={SPEC_STATUS_TONE[bundle.spec.status]}
            />
          </dd>
          <dt>{t("intent.spec.sha")}</dt>
          <dd>
            <code>{bundle.spec.sha256}</code>
          </dd>
        </dl>
      </section>
      <section className="section" aria-labelledby="spec-body-title">
        <h2 id="spec-body-title">{t("intent.spec.bodyTitle")}</h2>
        <pre className="spec-body">{bundle.spec.bodyMd}</pre>
      </section>
      <section className="section" aria-labelledby="spec-ac-title">
        <h2 id="spec-ac-title">{t("intent.spec.acTitle")}</h2>
        {bundle.requirements.length === 0 ? (
          <p className="muted">{t("intent.spec.acEmpty")}</p>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t("intent.spec.acId")}</th>
                  <th scope="col">{t("intent.spec.acText")}</th>
                  <th scope="col">{t("intent.spec.acKind")}</th>
                  <th scope="col">{t("intent.spec.acStatus")}</th>
                  <th scope="col">{t("intent.spec.dodTitle")}</th>
                </tr>
              </thead>
              <tbody>
                {bundle.requirements.map((requirement) => (
                  <tr key={requirement.id}>
                    <td>
                      <code>{requirement.acId}</code>
                    </td>
                    <td>{requirement.text}</td>
                    <td>{t(`intent.spec.kinds.${requirement.kind}`)}</td>
                    <td>{t(`intent.spec.acStatuses.${requirement.status}`)}</td>
                    <td>
                      <DodRows requirement={requirement} rows={bundle.dodRows} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
