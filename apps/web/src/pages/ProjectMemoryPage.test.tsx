import { fireEvent, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { i18n } from "../i18n"
import { installApiMock, jsonResponse } from "../test/apiMock"
import { member, project, user } from "../test/fixtures"
import { renderApp } from "../test/render"

const routes = {
  "GET /api/auth/me": () => jsonResponse(user),
  "GET /api/projects": () => jsonResponse({ items: [project], nextCursor: null }),
  "GET /api/projects/alpha": () => jsonResponse(project),
  "GET /api/projects/alpha/members": () =>
    jsonResponse({ items: [member("editor")], nextCursor: null }),
  "GET /api/projects/alpha/memory/search": () =>
    jsonResponse({
      items: [
        {
          id: "claim-1",
          kind: "claim",
          text: "The runbook names bubblewrap as a runner prerequisite",
          score: 0.912,
          meta: { status: "stale" },
        },
      ],
    }),
}

describe("ProjectMemoryPage", () => {
  it("shows a stale claim returned by the project memory search", async () => {
    await i18n.changeLanguage("ru")
    installApiMock(routes)
    renderApp("/projects/alpha/memory")

    fireEvent.change(await screen.findByRole("textbox", { name: "Поиск по памяти" }), {
      target: { value: "bubblewrap" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Найти" }))

    expect(
      await screen.findByText("The runbook names bubblewrap as a runner prerequisite"),
    ).toBeInTheDocument()
    expect(screen.getByText("Устарел")).toBeInTheDocument()
    expect(screen.getByText("claim")).toBeInTheDocument()
  })
})
