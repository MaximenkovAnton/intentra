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
})
