import { useEffect, useId, useRef, useState } from "react"
import type { FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useCreateProject } from "../api/queries"

const PROJECT_KEY_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
const PROJECT_NAME_MAX_LENGTH = 120

type FormErrors = {
  key?: string
  name?: string
}

export const CreateProjectDialog = ({ onClose }: { onClose: () => void }) => {
  const { t } = useTranslation()
  const createProject = useCreateProject()
  const apiErrorMessage = useApiErrorMessage()
  const [key, setKey] = useState("")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [defaultBranch, setDefaultBranch] = useState("main")
  const [errors, setErrors] = useState<FormErrors>({})
  const titleId = useId()
  const keyId = useId()
  const keyHintId = useId()
  const keyErrorId = useId()
  const nameId = useId()
  const nameErrorId = useId()
  const descriptionId = useId()
  const branchId = useId()
  const keyInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    keyInputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose])

  const validate = (): FormErrors => {
    const nextErrors: FormErrors = {}
    const trimmedKey = key.trim()
    const trimmedName = name.trim()
    if (trimmedKey === "") nextErrors.key = t("projects.form.keyRequired")
    else if (!PROJECT_KEY_PATTERN.test(trimmedKey)) nextErrors.key = t("projects.form.keyInvalid")
    if (trimmedName === "") nextErrors.name = t("projects.form.nameRequired")
    else if (trimmedName.length > PROJECT_NAME_MAX_LENGTH) nextErrors.name = t("projects.form.nameTooLong")
    return nextErrors
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextErrors = validate()
    setErrors(nextErrors)
    if (nextErrors.key !== undefined || nextErrors.name !== undefined) return
    const trimmedDescription = description.trim()
    const trimmedBranch = defaultBranch.trim()
    createProject.mutate(
      {
        key: key.trim(),
        name: name.trim(),
        description: trimmedDescription === "" ? null : trimmedDescription,
        defaultBranch: trimmedBranch === "" ? "main" : trimmedBranch,
      },
      { onSuccess: () => onClose() },
    )
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="dialog__title">
          {t("projects.createTitle")}
        </h2>
        <form className="form" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label className="field__label" htmlFor={keyId}>
              {t("projects.key")}
            </label>
            <input
              ref={keyInputRef}
              id={keyId}
              className="field__input"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              aria-invalid={errors.key !== undefined}
              aria-describedby={errors.key !== undefined ? keyErrorId : keyHintId}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="field__hint" id={keyHintId}>
              {t("projects.keyHint")}
            </p>
            {errors.key !== undefined ? (
              <p className="field__error" id={keyErrorId} role="alert">
                {errors.key}
              </p>
            ) : null}
          </div>
          <div className="field">
            <label className="field__label" htmlFor={nameId}>
              {t("projects.name")}
            </label>
            <input
              id={nameId}
              className="field__input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={errors.name !== undefined}
              aria-describedby={errors.name !== undefined ? nameErrorId : undefined}
            />
            {errors.name !== undefined ? (
              <p className="field__error" id={nameErrorId} role="alert">
                {errors.name}
              </p>
            ) : null}
          </div>
          <div className="field">
            <label className="field__label" htmlFor={descriptionId}>
              {t("projects.description")}
            </label>
            <textarea
              id={descriptionId}
              className="field__textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={branchId}>
              {t("projects.defaultBranch")}
            </label>
            <input
              id={branchId}
              className="field__input"
              value={defaultBranch}
              onChange={(event) => setDefaultBranch(event.target.value)}
            />
          </div>
          {createProject.isError ? (
            <p className="field__error" role="alert">
              {apiErrorMessage(createProject.error)}
            </p>
          ) : null}
          <div className="form__actions">
            <button type="submit" className="button button--primary" disabled={createProject.isPending}>
              {createProject.isPending ? t("common.loading") : t("projects.createSubmit")}
            </button>
            <button type="button" className="button" onClick={onClose}>
              {t("common.cancel")}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
