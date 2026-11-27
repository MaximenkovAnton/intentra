import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useEvidence } from "../api/queries"
import { readJobLinks } from "../api/results"
import { StatusBadge } from "../components/StatusBadge"
import { formatDateTime, formatDuration, formatNumber } from "../i18n/format"
import { gateTone } from "../ui/status"

export const IntentEvidenceTab = ({ intentId }: { intentId: string }) => {
  const { t, i18n } = useTranslation()
  const evidence = useEvidence(intentId)
  const apiErrorMessage = useApiErrorMessage()
  const locale = i18n.resolvedLanguage ?? "ru"

  if (evidence.status === "pending") return <p role="status">{t("common.loading")}</p>
  if (evidence.status === "error") {
    return (
      <p className="field__error" role="alert">
        {apiErrorMessage(evidence.error)}
      </p>
    )
  }

  const data = evidence.data
  const links = data.jobs
    .map((job) => ({ job, value: readJobLinks(job.result) }))
    .filter(
      (entry) =>
        entry.value.link !== null || entry.value.links.length > 0 || entry.value.commit !== null,
    )

  return (
    <div className="page">
      <section className="section" aria-labelledby="evidence-metrics-title">
        <h2 id="evidence-metrics-title">{t("intent.evidence.metricsTitle")}</h2>
        <dl className="facts">
          <dt>{t("intent.evidence.duration")}</dt>
          <dd>
            {data.metrics.durationMs === null
              ? t("common.notAvailable")
              : formatDuration(data.metrics.durationMs, locale)}
          </dd>
          <dt>{t("intent.evidence.humanWait")}</dt>
          <dd>{formatDuration(data.metrics.humanWaitMs, locale)}</dd>
          <dt>{t("intent.evidence.attempts")}</dt>
          <dd>{data.metrics.attempts}</dd>
          <dt>{t("intent.evidence.inputTokens")}</dt>
          <dd>{formatNumber(data.metrics.inputTokens, locale)}</dd>
          <dt>{t("intent.evidence.outputTokens")}</dt>
          <dd>{formatNumber(data.metrics.outputTokens, locale)}</dd>
          <dt>{t("intent.evidence.gatesSummary")}</dt>
          <dd>
            {t("intent.evidence.gatesCounts", {
              pass: data.metrics.gates.pass,
              fail: data.metrics.gates.fail,
              skipped: data.metrics.gates.skipped,
            })}
          </dd>
        </dl>
      </section>
      <section className="section" aria-labelledby="evidence-gates-title">
        <h2 id="evidence-gates-title">{t("intent.evidence.gatesTitle")}</h2>
        {data.gates.length === 0 ? (
          <p className="muted">{t("intent.evidence.gatesEmpty")}</p>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t("intent.evidence.criterion")}</th>
                  <th scope="col">{t("intent.evidence.status")}</th>
                  <th scope="col">{t("intent.evidence.duration")}</th>
                  <th scope="col">{t("intent.evidence.exitCode")}</th>
                </tr>
              </thead>
              <tbody>
                {data.gates.map((gate) => (
                  <tr key={`${gate.criterion}-${gate.durationMs}`}>
                    <td>{gate.criterion}</td>
                    <td>
                      <StatusBadge
                        label={t(`intent.evidence.gateStatuses.${gate.status}`)}
                        tone={gateTone(gate.status)}
                      />
                    </td>
                    <td>{formatDuration(gate.durationMs, locale)}</td>
                    <td>{gate.exitCode === undefined ? "—" : gate.exitCode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="section" aria-labelledby="evidence-verdicts-title">
        <h2 id="evidence-verdicts-title">{t("intent.evidence.verdictsTitle")}</h2>
        {data.verdicts.length === 0 ? (
          <p className="muted">{t("intent.evidence.verdictsEmpty")}</p>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t("intent.critic.role")}</th>
                  <th scope="col">{t("intent.critic.decision")}</th>
                  <th scope="col">{t("intent.critic.round")}</th>
                </tr>
              </thead>
              <tbody>
                {data.verdicts.map((verdict) => (
                  <tr key={verdict.id}>
                    <td>{verdict.role}</td>
                    <td>
                      <StatusBadge
                        label={t(`intent.critic.decisions.${verdict.decision}`)}
                        tone={verdict.decision === "approve" ? "success" : "danger"}
                      />
                    </td>
                    <td>{verdict.round}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="section" aria-labelledby="evidence-decisions-title">
        <h2 id="evidence-decisions-title">{t("intent.evidence.decisionsTitle")}</h2>
        {data.decisions.length === 0 ? (
          <p className="muted">{t("intent.evidence.decisionsEmpty")}</p>
        ) : (
          <ul className="list">
            {data.decisions.map((decision) => (
              <li key={decision.id} className="list__item list__item--stacked">
                <span className="field__label">{decision.question}</span>
                <span>{decision.answer}</span>
                {decision.rationale === null ? null : (
                  <span className="muted">{decision.rationale}</span>
                )}
                <span className="badge-row">
                  <StatusBadge
                    label={t(`intent.office.decisionStatuses.${decision.status}`)}
                    tone={decision.status === "accepted" ? "success" : "warning"}
                  />
                  <span className="muted">{formatDateTime(decision.createdAt, locale)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="section" aria-labelledby="evidence-links-title">
        <h2 id="evidence-links-title">{t("intent.evidence.linksTitle")}</h2>
        {links.length === 0 ? (
          <p className="muted">{t("intent.evidence.linksEmpty")}</p>
        ) : (
          <ul className="list">
            {links.map(({ job, value }) => (
              <li key={job.id} className="list__item">
                {value.link === null ? null : (
                  <a href={value.link} target="_blank" rel="noopener noreferrer">
                    {value.link}
                  </a>
                )}
                {value.commit === null ? null : <code>{value.commit.slice(0, 12)}</code>}
                {value.links.map((link) => (
                  <a key={link} href={link} target="_blank" rel="noopener noreferrer">
                    {link}
                  </a>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
