import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useMembers, useMyProjectRole, useRemoveMember } from "../api/queries"
import { canManage } from "../auth/permissions"
import { AddMemberForm } from "../components/AddMemberForm"

export const ProjectMembersPage = ({ projectKey }: { projectKey: string }) => {
  const { t } = useTranslation()
  const members = useMembers(projectKey)
  const role = useMyProjectRole(projectKey)
  const manage = canManage(role)
  const removeMember = useRemoveMember()
  const apiErrorMessage = useApiErrorMessage()

  return (
    <section className="section" aria-labelledby="project-members-title">
      <h2 id="project-members-title">{t("projects.members.title")}</h2>
      {!manage ? <p className="hint">{t("projects.members.readOnly")}</p> : null}
      {manage ? <AddMemberForm projectKey={projectKey} /> : null}
      {members.status === "pending" ? <p role="status">{t("common.loading")}</p> : null}
      {members.status === "error" ? (
        <p className="field__error" role="alert">
          {apiErrorMessage(members.error)}
        </p>
      ) : null}
      {members.status === "success" ? (
        members.data.items.length === 0 ? (
          <p className="muted">{t("projects.members.empty")}</p>
        ) : (
          <ul className="member-list">
            {members.data.items.map((member) => (
              <li key={member.userId} className="member-list__item">
                <span>{member.name}</span>
                <span className="member-list__email">{member.email}</span>
                <span className="badge">{t(`projects.members.roles.${member.role}`)}</span>
                {manage ? (
                  <button
                    type="button"
                    className="button button--danger"
                    onClick={() => removeMember.mutate({ key: projectKey, userId: member.userId })}
                    disabled={removeMember.isPending}
                  >
                    {t("projects.members.remove")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
      {removeMember.isError ? (
        <p className="field__error" role="alert">
          {apiErrorMessage(removeMember.error)}
        </p>
      ) : null}
    </section>
  )
}
