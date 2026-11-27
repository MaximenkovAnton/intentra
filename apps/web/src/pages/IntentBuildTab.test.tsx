import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { i18n } from "../i18n"
import { buildEvidence, intentDetail, intentId, member, project, user } from "../test/fixtures"
import { installApiMock, jsonResponse } from "../test/apiMock"
import { renderApp } from "../test/render"

const routes = {
  "GET /api/auth/me": () => jsonResponse(user),
  "GET /api/projects": () => jsonResponse({ items: [project], nextCursor: null }),
  "GET /api/projects/alpha/members": () => jsonResponse({ items: [member("editor")], nextCursor: null }),
  [`GET /api/intents/${intentId}`]: () => jsonResponse(intentDetail),
  [`GET /api/intents/${intentId}/evidence`]: () => jsonResponse(buildEvidence),
  [`GET /api/intents/${intentId}/findings`]: () => jsonResponse({ items: [], nextCursor: null }),
  "GET /api/runners": () => jsonResponse({ items: [], nextCursor: null }),
}

describe("IntentBuildTab", () => {
  it("shows the diff summary as files and counts only", async () => {
    await i18n.changeLanguage("ru")
    installApiMock(routes)
    renderApp(`/intents/${intentId}/build`)

    expect(await screen.findByText("apps/web/src/App.tsx")).toBeInTheDocument()
    expect(screen.getAllByText("+12").length).toBeGreaterThan(0)
    expect(screen.getAllByText("−3").length).toBeGreaterThan(0)
    expect(screen.getByText("Файлов: 1")).toBeInTheDocument()
    expect(
      screen.getByText("Только имена файлов и количество строк: содержимое диффа в центр не попадает."),
    ).toBeInTheDocument()
    expect(screen.queryByText(/diff --git/)).toBeNull()
  })

  it("shows gates, stage status and links", async () => {
    await i18n.changeLanguage("ru")
    installApiMock(routes)
    renderApp(`/intents/${intentId}/build`)

    expect(await screen.findByText("tests")).toBeInTheDocument()
    expect(screen.getByText("Сборка")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "https://github.com/acme/repo/pull/1" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    )
    expect(screen.getByRole("link", { name: "https://github.com/acme/repo/pull/1" })).toHaveAttribute(
      "target",
      "_blank",
    )
  })
})
