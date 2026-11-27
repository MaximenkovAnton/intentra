import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useApiErrorMessage } from "../api/errorMessages"
import { useMemorySearch } from "../api/queries"
import type { MemoryHit } from "../api/types"
import { StatusBadge } from "../components/StatusBadge"
import { claimTone } from "../ui/status"

const statusOf = (hit: MemoryHit): string | null => {
  const status = hit.meta?.["status"]
  return typeof status === "string" ? status : null
}

export const ProjectMemoryPage = ({ projectKey }: { projectKey: string }) => {
  const { t } = useTranslation()
  const apiErrorMessage = useApiErrorMessage()
  const [draft, setDraft] = useState("")
  const [query, setQuery] = useState("")
  const search = useMemorySearch(projectKey, query)

  return (
    <div className="page">
      <section className="section" aria-labelledby="memory-search-title">
        <h2 id="memory-search-title">{t("memory.searchTitle")}</h2>
        <form
          className="field"
          onSubmit={(event) => {
            event.preventDefault()
            setQuery(draft.trim())
          }}
        >
          <label className="field__label" htmlFor="memory-query">
            {t("memory.queryLabel")}
          </label>
          <input
            id="memory-query"
            className="field__input"
            value={draft}
            maxLength={200}
            placeholder={t("memory.queryPlaceholder")}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="button" disabled={draft.trim().length === 0}>
            {t("memory.search")}
          </button>
        </form>
        {query.length === 0 ? <p className="hint">{t("memory.searchHint")}</p> : null}
        {search.status === "pending" ? <p role="status">{t("common.loading")}</p> : null}
        {search.status === "error" ? (
          <p className="field__error" role="alert">
            {apiErrorMessage(search.error)}
          </p>
        ) : null}
        {search.status === "success" ? (
          <>
            {search.data.degraded === true ? <p className="notice">{t("memory.degraded")}</p> : null}
            {search.data.items.length === 0 ? (
              <p className="muted">{t("memory.empty")}</p>
            ) : (
              <>
                <p className="muted">
                  {t("memory.resultCount", { count: search.data.items.length })}
                </p>
                <ul className="list">
                  {search.data.items.map((hit) => {
                    const status = statusOf(hit)
                    return (
                      <li key={hit.id} className="list__item list__item--stacked">
                        <span className="badge-row">
                          <span className="badge">{hit.kind}</span>
                          {status === null ? null : (
                            <StatusBadge
                              label={t(`memory.statuses.${status}`, { defaultValue: status })}
                              tone={claimTone(status)}
                            />
                          )}
                          <span className="muted">
                            {t("memory.score")} {hit.score.toFixed(3)}
                          </span>
                        </span>
                        <span>{hit.text}</span>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </>
        ) : null}
      </section>
    </div>
  )
}
