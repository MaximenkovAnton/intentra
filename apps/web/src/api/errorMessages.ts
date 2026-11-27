import { useTranslation } from "react-i18next"
import { ApiRequestError } from "./errors"

export const useApiErrorMessage = (): ((error: unknown) => string) => {
  const { t } = useTranslation()
  return (error: unknown): string => {
    if (error instanceof ApiRequestError) {
      return t(`errors.${error.code}`, { defaultValue: t("errors.UNKNOWN") })
    }
    return t("errors.UNKNOWN")
  }
}
