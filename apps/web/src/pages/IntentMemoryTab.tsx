import { useTranslation } from "react-i18next"

export const IntentMemoryTab = () => {
  const { t } = useTranslation()

  return (
    <div className="notice">
      <p>{t("intent.memory.unavailable")}</p>
      <p className="hint">{t("intent.memory.unavailableHint")}</p>
    </div>
  )
}
