import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"

export const NotFoundPage = () => {
  const { t } = useTranslation()

  return (
    <section className="page" aria-labelledby="not-found-title">
      <h1 id="not-found-title">{t("notFound.title")}</h1>
      <p className="muted">{t("notFound.text")}</p>
      <div>
        <Link className="button" to="/">
          {t("notFound.back")}
        </Link>
      </div>
    </section>
  )
}
