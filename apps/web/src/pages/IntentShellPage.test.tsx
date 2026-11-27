import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { i18n } from "../i18n"
import { installApiMock, jsonResponse } from "../test/apiMock"
import { buildEvidence, intentDetail, intentId, member, project, user } from "../test/fixtures"
import { renderApp } from "../test/render"

const routes = (status: string) => ({
  "GET /api/auth/me": () => jsonResponse(user),
  "GET /api/projects": () => jsonResponse({ items: [project], nextCursor: null }),
  "GET /api/projects/alpha/members": () =>
    jsonResponse({ items: [member("owner")], nextCursor: null }),
  [`GET /api/intents/${intentId}`]: () =>
    jsonResponse({ ...intentDetail, intent: { ...intentDetail.intent, status } }),
  [`GET /api/intents/${intentId}/evidence`]: () => jsonResponse(buildEvidence),
})

const intakeFailure = "worktree is dirty: ?? _bmad-output/"

const failedIntakeStage = {
  id: "00000000-0000-4000-8000-000000000008",
  intentId,
  kind: "intake",
  status: "failed",
  attempt: 1,
  startedAt: "2026-01-02T00:00:00.000Z",
  finishedAt: "2026-01-02T00:02:00.000Z",
  error: intakeFailure,
}

const runningIntakeStage = {
  ...failedIntakeStage,
  id: "00000000-0000-4000-8000-000000000013",
  status: "running",
  startedAt: "2026-01-03T00:00:00.000Z",
  finishedAt: null,
  error: null,
}

const draftRoutes = (role: "owner" | "editor" | "viewer") => ({
  ...routes("draft"),
  "GET /api/projects/alpha/members": () =>
    jsonResponse({ items: [member(role)], nextCursor: null }),
  [`GET /api/intents/${intentId}/evidence`]: () =>
    jsonResponse({ ...buildEvidence, stages: [failedIntakeStage] }),
})

const STATUSES_WITHOUT_REWORK = [
  "clarifying",
  "specified",
  "critiqued",
  "planned",
  "building",
  "verifying",
] as const

describe("IntentShellPage", () => {
  it.each(STATUSES_WITHOUT_REWORK)("offers no rework while the intent is %s", async (status) => {
    await i18n.changeLanguage("ru")
    installApiMock(routes(status))
    renderApp(`/intents/${intentId}`)

    expect(await screen.findByRole("button", { name: "Отменить интент" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Отправить на доработку" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Принять" })).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("offers accept and rework when the intent awaits acceptance", async () => {
    await i18n.changeLanguage("ru")
    installApiMock(routes("awaiting_acceptance"))
    renderApp(`/intents/${intentId}`)

    expect(await screen.findByRole("button", { name: "Принять" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Отправить на доработку" })).toBeInTheDocument()
  })

  it("closes the cancel confirmation on Escape and returns focus to the trigger", async () => {
    await i18n.changeLanguage("ru")
    installApiMock(routes("clarifying"))
    const userEventApi = userEvent.setup()
    renderApp(`/intents/${intentId}`)

    const trigger = await screen.findByRole("button", { name: "Отменить интент" })
    await userEventApi.click(trigger)

    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveAttribute("aria-modal", "true")
    const confirm = screen.getByRole("button", { name: "Да, отменить" })
    const close = screen.getByRole("button", { name: "Закрыть" })
    expect(close).toHaveFocus()

    await userEventApi.tab()
    expect(confirm).toHaveFocus()
    await userEventApi.tab({ shift: true })
    expect(close).toHaveFocus()

    await userEventApi.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(trigger).toHaveFocus()
  })

  it("shows the failed stage reason, retries intake and hides the reason once the new stage runs", async () => {
    await i18n.changeLanguage("ru")
    let retryPosted = false
    let evidenceFetches = 0
    const fetchMock = installApiMock({
      ...draftRoutes("editor"),
      [`GET /api/intents/${intentId}/evidence`]: () => {
        evidenceFetches += 1
        return jsonResponse({
          ...buildEvidence,
          stages: retryPosted ? [runningIntakeStage] : [failedIntakeStage],
        })
      },
      [`POST /api/intents/${intentId}/retry`]: () => {
        retryPosted = true
        return jsonResponse({ ...intentDetail.intent, status: "draft" })
      },
    })
    const userEventApi = userEvent.setup()
    renderApp(`/intents/${intentId}`)

    expect(await screen.findByRole("alert")).toHaveTextContent(intakeFailure)
    await waitFor(() => expect(evidenceFetches).toBeGreaterThanOrEqual(2))
    const fetchesBeforeRetry = evidenceFetches
    expect(screen.getByRole("alert")).toHaveTextContent(intakeFailure)

    await userEventApi.click(screen.getByRole("button", { name: "Повторить запуск" }))

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([request]) =>
            request.method === "POST" &&
            new URL(request.url).pathname === `/api/intents/${intentId}/retry`,
        ),
      ).toBe(true)
    })
    await waitFor(() => expect(evidenceFetches).toBeGreaterThan(fetchesBeforeRetry))
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  })

  it("hides the failure reason while an earlier stage is still running", async () => {
    await i18n.changeLanguage("ru")
    installApiMock({
      ...draftRoutes("editor"),
      [`GET /api/intents/${intentId}/evidence`]: () =>
        jsonResponse({
          ...buildEvidence,
          stages: [{ ...runningIntakeStage, startedAt: "2026-01-01T00:00:00.000Z" }, failedIntakeStage],
        }),
    })
    renderApp(`/intents/${intentId}`)

    expect(await screen.findByText("Принято")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("hides the retry action from a viewer", async () => {
    await i18n.changeLanguage("ru")
    let memberFetches = 0
    installApiMock({
      ...draftRoutes("viewer"),
      "GET /api/projects/alpha/members": () => {
        memberFetches += 1
        return jsonResponse({ items: [member("viewer")], nextCursor: null })
      },
    })
    renderApp(`/intents/${intentId}`)

    expect(await screen.findByRole("alert")).toHaveTextContent(intakeFailure)
    await waitFor(() => expect(memberFetches).toBeGreaterThan(0))
    expect(screen.queryByRole("button", { name: "Повторить запуск" })).toBeNull()
  })

  it("shows no failure reason for a terminal intent with a failed stage", async () => {
    await i18n.changeLanguage("ru")
    installApiMock({
      ...draftRoutes("editor"),
      [`GET /api/intents/${intentId}`]: () =>
        jsonResponse({ ...intentDetail, intent: { ...intentDetail.intent, status: "accepted" } }),
    })
    renderApp(`/intents/${intentId}`)

    expect(await screen.findByText("Принято")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
