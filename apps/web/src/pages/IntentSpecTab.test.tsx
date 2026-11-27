import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { i18n } from "../i18n"
import { intentDetail, intentId, member, project, specBundle, user } from "../test/fixtures"
import { installApiMock, jsonResponse } from "../test/apiMock"
import { renderApp } from "../test/render"

const routes = {
  "GET /api/auth/me": () => jsonResponse(user),
  "GET /api/projects": () => jsonResponse({ items: [project], nextCursor: null }),
  "GET /api/projects/alpha/members": () => jsonResponse({ items: [member("editor")], nextCursor: null }),
  [`GET /api/intents/${intentId}`]: () => jsonResponse(intentDetail),
  [`GET /api/intents/${intentId}/spec`]: () => jsonResponse(specBundle),
}

describe("IntentSpecTab", () => {
  it("renders the spec body, AC and DoD with the sha", async () => {
    await i18n.changeLanguage("ru")
    installApiMock(routes)
    renderApp(`/intents/${intentId}/spec`)

    expect(await screen.findByText("AC-1")).toBeInTheDocument()
    expect(screen.getByText("Интент создаётся и хранится.")).toBeInTheDocument()
    expect(screen.getByText("src/intents.test.ts")).toBeInTheDocument()
    expect(screen.getByText("aa".repeat(32))).toBeInTheDocument()
    expect(screen.getByText(/Хранить интенты\./)).toBeInTheDocument()
  })

  it("tells the user when the spec is not generated yet", async () => {
    await i18n.changeLanguage("ru")
    installApiMock({
      ...routes,
      [`GET /api/intents/${intentId}/spec`]: () =>
        jsonResponse({ code: "NOT_FOUND", message: "Spec not found" }, 404),
    })
    renderApp(`/intents/${intentId}/spec`)

    expect(await screen.findByText("Спека ещё не сгенерирована.")).toBeInTheDocument()
  })
})
