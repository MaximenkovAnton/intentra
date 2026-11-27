import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { isNotFoundError } from "../api/errors"
import { useJobs, usePlan, useRunners } from "../api/queries"
import type { Job } from "../api/types"
import { latestJobPerTask } from "../api/results"
import { StatusBadge } from "../components/StatusBadge"
import { jobTone } from "../ui/status"

const TaskJob = ({ job, runnerName }: { job: Job | undefined; runnerName: string | null }) => {
  const { t } = useTranslation()
  if (job === undefined) return <span className="muted">{t("intent.plan.noJob")}</span>
  return (
    <span className="badge-row">
      <StatusBadge label={t(`intent.build.jobStatuses.${job.status}`)} tone={jobTone(job.status)} />
      {runnerName === null ? null : <span className="hint">{runnerName}</span>}
    </span>
  )
}

export const IntentPlanTab = ({ intentId }: { intentId: string }) => {
  const { t } = useTranslation()
  const plan = usePlan(intentId)
  const jobs = useJobs(intentId)
  const runners = useRunners()
  const apiErrorMessage = useApiErrorMessage()

  if (plan.status === "pending") return <p role="status">{t("common.loading")}</p>
  if (plan.status === "error") {
    return isNotFoundError(plan.error) ? (
      <div className="notice">
        <p>{t("intent.plan.notReady")}</p>
      </div>
    ) : (
      <p className="field__error" role="alert">
        {apiErrorMessage(plan.error)}
      </p>
    )
  }

  const latestJobs = latestJobPerTask(jobs.data?.items ?? [])
  const runnersById = new Map((runners.data?.items ?? []).map((runner) => [runner.id, runner.name]))

  return (
    <section className="section" aria-labelledby="plan-title">
      <h2 id="plan-title">{t("intent.plan.title")}</h2>
      <ul className="card-list">
        {plan.data.tasks.map((task) => {
          const job = latestJobs.get(task.id)
          const runnerName = job?.runnerId == null ? null : runnersById.get(job.runnerId) ?? null
          return (
            <li key={task.id} className="card">
              <div className="page__header">
                <h3 className="card__title">{task.title}</h3>
                <TaskJob job={job} runnerName={runnerName} />
              </div>
              <p className="muted">{task.id}</p>
              <dl className="facts">
                <dt>{t("intent.plan.dependencies")}</dt>
                <dd>
                  {task.dependsOn.length === 0
                    ? t("intent.plan.noDependencies")
                    : task.dependsOn.join(", ")}
                </dd>
                <dt>{t("intent.plan.paths")}</dt>
                <dd>{task.paths.length === 0 ? t("common.notAvailable") : task.paths.join(", ")}</dd>
                <dt>{t("intent.plan.acceptance")}</dt>
                <dd>{task.acceptance.join(", ")}</dd>
                <dt>{t("intent.plan.reviewLens")}</dt>
                <dd>{task.reviewLens}</dd>
              </dl>
              <details>
                <summary>{t("intent.plan.spec")}</summary>
                <pre className="spec-body">{task.spec}</pre>
              </details>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
