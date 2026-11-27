import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useEvidence, useFindings, useRunners } from "../api/queries"
import { readDiffSummary, readJobKind, readJobLinks, readJobTaskId } from "../api/results"
import type { Job } from "../api/types"
import { StatusBadge } from "../components/StatusBadge"
import { formatDuration } from "../i18n/format"
import { findingTone, gateTone, jobTone, stageTone } from "../ui/status"

const DiffSummaryView = ({ job }: { job: Job }) => {
  const { t } = useTranslation()
  const summary = readDiffSummary(job.result)
  if (summary === null) return null
  const taskId = readJobTaskId(job.payload)
  return (
    <section className="subsection" aria-label={t("intent.build.diffTitle")}>
      <h3 className="subsection__title">
        {t("intent.build.diffTitle")}
        {taskId === null ? null : <code>{taskId}</code>}
        <span className="badge">{t("intent.build.files", { count: summary.files })}</span>
        <span className="badge badge--success">+{summary.additions}</span>
        <span className="badge badge--danger">−{summary.deletions}</span>
      </h3>
      {summary.entries.length === 0 ? (
        <p className="muted">{t("intent.build.diffEmpty")}</p>
      ) : (
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t("intent.build.path")}</th>
                <th scope="col">{t("intent.build.changeStatus")}</th>
                <th scope="col">{t("intent.build.additions")}</th>
                <th scope="col">{t("intent.build.deletions")}</th>
              </tr>
            </thead>
            <tbody>
              {summary.entries.map((entry) => (
                <tr key={`${entry.path}-${entry.status}`}>
                  <td>
                    <code>{entry.path}</code>
                    {entry.binary ? <span className="badge">{t("intent.build.binary")}</span> : null}
                  </td>
                  <td>{entry.status}</td>
                  <td>+{entry.additions}</td>
                  <td>−{entry.deletions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">{t("intent.build.diffPrivacy")}</p>
    </section>
  )
}

export const IntentBuildTab = ({ intentId }: { intentId: string }) => {
  const { t, i18n } = useTranslation()
  const evidence = useEvidence(intentId)
  const findings = useFindings(intentId)
  const runners = useRunners()
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
  const runnersById = new Map((runners.data?.items ?? []).map((runner) => [runner.id, runner.name]))
  const diffJobs = data.jobs.filter((job) => readDiffSummary(job.result) !== null)
  const linkJobs = data.jobs
    .map((job) => ({ job, links: readJobLinks(job.result) }))
    .filter((entry) => entry.links.branch !== null || entry.links.commit !== null || entry.links.link !== null)

  return (
    <div className="page">
      <section className="section" aria-labelledby="build-stages-title">
        <h2 id="build-stages-title">{t("intent.build.stagesTitle")}</h2>
        {data.stages.length === 0 ? (
          <p className="muted">{t("intent.build.stagesEmpty")}</p>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t("intent.build.stage")}</th>
                  <th scope="col">{t("intent.build.status")}</th>
                  <th scope="col">{t("intent.build.attempt")}</th>
                  <th scope="col">{t("intent.build.started")}</th>
                  <th scope="col">{t("intent.build.finished")}</th>
                </tr>
              </thead>
              <tbody>
                {data.stages.map((stage) => (
                  <tr key={stage.id}>
                    <td>{t(`intent.build.stageKinds.${stage.kind}`)}</td>
                    <td>
                      <StatusBadge
                        label={t(`intent.build.stageStatuses.${stage.status}`)}
                        tone={stageTone(stage.status)}
                      />
                    </td>
                    <td>{stage.attempt}</td>
                    <td>{stage.startedAt === null ? "—" : new Date(stage.startedAt).toLocaleString(locale)}</td>
                    <td>{stage.finishedAt === null ? "—" : new Date(stage.finishedAt).toLocaleString(locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.stages
          .filter((stage) => stage.error !== null)
          .map((stage) => (
            <p key={stage.id} className="field__error">
              {stage.error}
            </p>
          ))}
      </section>
      <section className="section" aria-labelledby="build-jobs-title">
        <h2 id="build-jobs-title">{t("intent.build.jobsTitle")}</h2>
        {data.jobs.length === 0 ? (
          <p className="muted">{t("intent.build.jobsEmpty")}</p>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t("intent.build.kind")}</th>
                  <th scope="col">{t("intent.build.status")}</th>
                  <th scope="col">{t("intent.build.attempt")}</th>
                  <th scope="col">{t("intent.build.runner")}</th>
                  <th scope="col">{t("intent.build.runtime")}</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{readJobKind(job.payload) ?? job.id.slice(0, 8)}</td>
                    <td>
                      <StatusBadge
                        label={t(`intent.build.jobStatuses.${job.status}`)}
                        tone={jobTone(job.status)}
                      />
                    </td>
                    <td>{job.attempt}</td>
                    <td>{job.runnerId === null ? "—" : runnersById.get(job.runnerId) ?? job.runnerId}</td>
                    <td>{job.runtime}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="section" aria-labelledby="build-diff-title">
        <h2 id="build-diff-title">{t("intent.build.diffTitle")}</h2>
        {diffJobs.length === 0 ? (
          <p className="muted">{t("intent.build.diffEmpty")}</p>
        ) : (
          diffJobs.map((job) => <DiffSummaryView key={job.id} job={job} />)
        )}
      </section>
      <section className="section" aria-labelledby="build-links-title">
        <h2 id="build-links-title">{t("intent.build.linksTitle")}</h2>
        {linkJobs.length === 0 ? (
          <p className="muted">{t("intent.build.linksEmpty")}</p>
        ) : (
          <ul className="list">
            {linkJobs.map(({ job, links }) => (
              <li key={job.id} className="list__item">
                {links.branch === null ? null : (
                  <span className="badge">
                    {t("intent.build.branch")}: {links.branch}
                  </span>
                )}
                {links.commit === null ? null : <code>{links.commit.slice(0, 12)}</code>}
                {links.link === null ? null : (
                  <a href={links.link} target="_blank" rel="noopener noreferrer">
                    {links.link}
                  </a>
                )}
                {links.links.map((link) => (
                  <a key={link} href={link} target="_blank" rel="noopener noreferrer">
                    {link}
                  </a>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="section" aria-labelledby="build-findings-title">
        <h2 id="build-findings-title">{t("intent.build.findingsTitle")}</h2>
        {findings.status === "error" ? (
          <p className="field__error" role="alert">
            {apiErrorMessage(findings.error)}
          </p>
        ) : null}
        {findings.data !== undefined && findings.data.items.length === 0 ? (
          <p className="muted">{t("intent.build.findingsEmpty")}</p>
        ) : null}
        {findings.data === undefined ? null : (
          <ul className="list">
            {findings.data.items.map((finding) => (
              <li key={finding.id} className="list__item list__item--stacked">
                <span className="badge-row">
                  <StatusBadge
                    label={t(`intent.critic.severities.${finding.severity}`)}
                    tone={findingTone(finding)}
                  />
                  <span className="badge">{t(`intent.critic.classes.${finding.class}`)}</span>
                  {finding.acId === null ? null : <code>{finding.acId}</code>}
                  <span className="muted">{finding.role}</span>
                </span>
                <span>{finding.requirement}</span>
              </li>
            ))}
          </ul>
        )}
        {data.gates.length === 0 ? null : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t("intent.evidence.criterion")}</th>
                  <th scope="col">{t("intent.evidence.status")}</th>
                  <th scope="col">{t("intent.evidence.duration")}</th>
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
