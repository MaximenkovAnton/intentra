import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useEvidence, useFindings } from "../api/queries"
import type { Finding } from "../api/types"
import { StatusBadge } from "../components/StatusBadge"
import { findingTone } from "../ui/status"

const FINDING_CLASSES: readonly Finding["class"][] = [
  "ambiguous",
  "missing-evidence",
  "contradiction",
  "unprovable",
  "stale-doc",
  "scope",
]

const FindingItem = ({ finding }: { finding: Finding }) => {
  const { t } = useTranslation()
  return (
    <li className="list__item list__item--stacked">
      <span className="badge-row">
        <StatusBadge label={t(`intent.critic.severities.${finding.severity}`)} tone={findingTone(finding)} />
        <span className="badge">{t(`intent.critic.findingStatuses.${finding.status}`)}</span>
        {finding.acId === null ? null : <code>{finding.acId}</code>}
        <span className="muted">
          {t("intent.critic.round")} {finding.round} · {finding.role}
        </span>
      </span>
      <span>{finding.requirement}</span>
      {finding.evidence === null ? null : <span className="muted">{finding.evidence}</span>}
      {finding.requiredChange === null ? null : (
        <span className="hint">
          {t("intent.critic.requiredChange")}: {finding.requiredChange}
        </span>
      )}
    </li>
  )
}

export const IntentCriticTab = ({ intentId }: { intentId: string }) => {
  const { t } = useTranslation()
  const findings = useFindings(intentId)
  const evidence = useEvidence(intentId)
  const apiErrorMessage = useApiErrorMessage()

  const groups =
    findings.data === undefined
      ? []
      : FINDING_CLASSES.map((findingClass) => ({
          findingClass,
          items: findings.data.items.filter((finding) => finding.class === findingClass),
        })).filter((group) => group.items.length > 0)

  return (
    <div className="page">
      <section className="section" aria-labelledby="critic-findings-title">
        <h2 id="critic-findings-title">{t("intent.critic.findingsTitle")}</h2>
        {findings.status === "pending" ? <p role="status">{t("common.loading")}</p> : null}
        {findings.status === "error" ? (
          <p className="field__error" role="alert">
            {apiErrorMessage(findings.error)}
          </p>
        ) : null}
        {findings.status === "success" && findings.data.items.length === 0 ? (
          <p className="muted">{t("intent.critic.findingsEmpty")}</p>
        ) : null}
        {groups.map((group) => (
          <section key={group.findingClass} className="subsection" aria-labelledby={`class-${group.findingClass}`}>
            <h3 id={`class-${group.findingClass}`} className="subsection__title">
              {t(`intent.critic.classes.${group.findingClass}`)}
              <span className="badge">{group.items.length}</span>
            </h3>
            <ul className="list">
              {group.items.map((finding) => (
                <FindingItem key={finding.id} finding={finding} />
              ))}
            </ul>
          </section>
        ))}
      </section>
      <section className="section" aria-labelledby="critic-verdicts-title">
        <h2 id="critic-verdicts-title">{t("intent.critic.verdictTitle")}</h2>
        {evidence.status === "pending" ? <p role="status">{t("common.loading")}</p> : null}
        {evidence.status === "error" ? (
          <p className="field__error" role="alert">
            {apiErrorMessage(evidence.error)}
          </p>
        ) : null}
        {evidence.status === "success" ? (
          evidence.data.verdicts.length === 0 ? (
            <p className="muted">{t("intent.critic.verdictEmpty")}</p>
          ) : (
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t("intent.critic.role")}</th>
                    <th scope="col">{t("intent.critic.decision")}</th>
                    <th scope="col">{t("intent.critic.round")}</th>
                    <th scope="col">{t("intent.critic.artifact")}</th>
                  </tr>
                </thead>
                <tbody>
                  {evidence.data.verdicts.map((verdict) => (
                    <tr key={verdict.id}>
                      <td>{verdict.role}</td>
                      <td>
                        <StatusBadge
                          label={t(`intent.critic.decisions.${verdict.decision}`)}
                          tone={verdict.decision === "approve" ? "success" : "danger"}
                        />
                      </td>
                      <td>{verdict.round}</td>
                      <td>
                        <code>{verdict.artifactSha256.slice(0, 12)}</code>
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
