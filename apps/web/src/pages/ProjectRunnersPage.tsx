import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import {
  useCreateRegistrationToken,
  useMe,
  useMyProjectRole,
  useRevokeRunner,
  useRotateRunnerToken,
  useRunners,
} from "../api/queries"
import { canManage, manageRunner } from "../auth/permissions"
import { RunnerUpdateCell } from "../components/RunnerUpdateCell"
import { StatusBadge } from "../components/StatusBadge"
import { formatDateTime } from "../i18n/format"
import { runnerTone } from "../ui/status"

export const ProjectRunnersPage = ({ projectKey }: { projectKey: string }) => {
  const { t, i18n } = useTranslation()
  const runners = useRunners()
  const me = useMe()
  const role = useMyProjectRole(projectKey)
  const manage = canManage(role)
  const revokeRunner = useRevokeRunner()
  const rotateToken = useRotateRunnerToken()
  const createToken = useCreateRegistrationToken(projectKey)
  const apiErrorMessage = useApiErrorMessage()
  const locale = i18n.resolvedLanguage ?? "ru"

  return (
    <section className="section" aria-labelledby="project-runners-title">
      <h2 id="project-runners-title">{t("runners.title")}</h2>
      <p className="hint">{t("runners.subtitle", { key: projectKey })}</p>
      {manage ? (
        <div>
          <button
            type="button"
            className="button button--primary"
            onClick={() => createToken.mutate()}
            disabled={createToken.isPending}
          >
            {t("runners.token.create")}
          </button>
        </div>
      ) : (
        <p className="hint">{t("runners.token.readOnly")}</p>
      )}
      {createToken.isError ? (
        <p className="field__error" role="alert">
          {apiErrorMessage(createToken.error)}
        </p>
      ) : null}
      {createToken.data !== undefined ? (
        <div className="section">
          <code className="token-value">{createToken.data.token}</code>
          <p className="hint">{t("runners.token.hint")}</p>
          <p className="muted">
            {t("runners.token.expires", { date: formatDateTime(createToken.data.expiresAt, locale) })}
          </p>
        </div>
      ) : null}
      {rotateToken.data !== undefined ? (
        <div className="notice">
          <p>{t("runners.rotateHint")}</p>
          <code className="token-value">{rotateToken.data.token}</code>
        </div>
      ) : null}
      {runners.status === "pending" ? <p role="status">{t("common.loading")}</p> : null}
      {runners.status === "error" ? (
        <p className="field__error" role="alert">
          {apiErrorMessage(runners.error)}
        </p>
      ) : null}
      {runners.status === "success" ? (
        runners.data.items.length === 0 ? (
          <p className="muted">{t("runners.empty")}</p>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t("runners.name")}</th>
                  <th scope="col">{t("runners.platform")}</th>
                  <th scope="col">{t("runners.version")}</th>
                  <th scope="col">{t("runners.updates.title")}</th>
                  <th scope="col">{t("runners.capabilities")}</th>
                  <th scope="col">{t("runners.status")}</th>
                  <th scope="col">{t("runners.lastSeen")}</th>
                  <th scope="col">{t("runners.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {runners.data.items.map((runner) => {
                  const canManageRunner = manageRunner(role, runner.ownerUserId, me.data?.id)
                  return (
                    <tr key={runner.id}>
                      <td>
                        <Link to="/runners">{runner.name}</Link>
                      </td>
                      <td>
                        {runner.os} / {runner.arch}
                      </td>
                      <td>
                        <span>{runner.version}</span>
                        {runner.updateAvailable && runner.latestVersion !== null ? (
                          <span className="muted"> → {runner.latestVersion}</span>
                        ) : null}
                      </td>
                      <td>
                        <RunnerUpdateCell runner={runner} canManage={canManageRunner} />
                      </td>
                      <td>
                        {runner.capabilities.length === 0 ? (
                          <span className="muted">{t("common.notAvailable")}</span>
                        ) : (
                          <span className="badge-list">
                            {runner.capabilities.map((capability) => (
                              <span key={capability} className="badge">
                                {capability}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td>
                        <StatusBadge
                          label={t(`runners.statuses.${runner.status}`)}
                          tone={runnerTone(runner.status)}
                        />
                      </td>
                      <td>
                        {runner.lastSeenAt === null
                          ? t("runners.never")
                          : formatDateTime(runner.lastSeenAt, locale)}
                      </td>
                      <td>
                        {canManageRunner ? (
                          <span className="button-row">
                            <button
                              type="button"
                              className="button"
                              onClick={() => rotateToken.mutate(runner.id)}
                              disabled={rotateToken.isPending || runner.status === "revoked"}
                            >
                              {t("runners.rotate")}
                            </button>
                            <button
                              type="button"
                              className="button button--danger"
                              onClick={() => revokeRunner.mutate(runner.id)}
                              disabled={runner.status === "revoked" || revokeRunner.isPending}
                            >
                              {t("runners.revoke")}
                            </button>
                          </span>
                        ) : (
                          <span className="muted">{t("runners.readOnly")}</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      ) : null}
      {revokeRunner.isError ? (
        <p className="field__error" role="alert">
          {apiErrorMessage(revokeRunner.error)}
        </p>
      ) : null}
      {rotateToken.isError ? (
        <p className="field__error" role="alert">
          {apiErrorMessage(rotateToken.error)}
        </p>
      ) : null}
    </section>
  )
}
