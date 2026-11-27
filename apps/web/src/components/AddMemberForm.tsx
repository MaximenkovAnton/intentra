import { useId, useState } from "react"
import type { FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useAddMember } from "../api/queries"
import type { AddMemberInput } from "../api/types"

type MemberRole = AddMemberInput["role"]

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const isMemberRole = (value: string): value is MemberRole =>
  value === "owner" || value === "editor" || value === "viewer"

export const AddMemberForm = ({ projectKey }: { projectKey: string }) => {
  const { t } = useTranslation()
  const addMember = useAddMember()
  const apiErrorMessage = useApiErrorMessage()
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<MemberRole>("viewer")
  const [error, setError] = useState<string | null>(null)
  const emailId = useId()
  const emailErrorId = useId()
  const roleId = useId()

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedEmail = email.trim()
    if (trimmedEmail === "") {
      setError(t("projects.members.emailRequired"))
      return
    }
    if (!EMAIL_PATTERN.test(trimmedEmail)) {
      setError(t("projects.members.emailInvalid"))
      return
    }
    setError(null)
    addMember.mutate(
      { key: projectKey, input: { email: trimmedEmail, role } },
      { onSuccess: () => setEmail("") },
    )
  }

  return (
    <form className="form" onSubmit={handleSubmit} aria-label={t("projects.members.add")} noValidate>
      <div className="form__row">
        <div className="field">
          <label className="field__label" htmlFor={emailId}>
            {t("projects.members.email")}
          </label>
          <input
            id={emailId}
            className="field__input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={error !== null}
            aria-describedby={error !== null ? emailErrorId : undefined}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={roleId}>
            {t("projects.members.role")}
          </label>
          <select
            id={roleId}
            className="field__select"
            value={role}
            onChange={(event) => {
              if (isMemberRole(event.target.value)) setRole(event.target.value)
            }}
          >
            <option value="owner">{t("projects.members.roles.owner")}</option>
            <option value="editor">{t("projects.members.roles.editor")}</option>
            <option value="viewer">{t("projects.members.roles.viewer")}</option>
          </select>
        </div>
        <button type="submit" className="button button--primary" disabled={addMember.isPending}>
          {t("projects.members.add")}
        </button>
      </div>
      {error !== null ? (
        <p className="field__error" id={emailErrorId} role="alert">
          {error}
        </p>
      ) : null}
      {addMember.isError ? (
        <p className="field__error" role="alert">
          {apiErrorMessage(addMember.error)}
        </p>
      ) : null}
    </form>
  )
}
