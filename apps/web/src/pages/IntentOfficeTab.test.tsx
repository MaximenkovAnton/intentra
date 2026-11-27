import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { i18n } from "../i18n"
import {
  emptyEvidence,
  escalation,
  escalationId,
  intentDetail,
  intentId,
  member,
  project,
  user,
} from "../test/fixtures"
import { installApiMock, jsonResponse } from "../test/apiMock"
import { renderApp } from "../test/render"

const baseRoutes = (role: "editor" | "viewer") => ({
  "GET /api/auth/me": () => jsonResponse(user),
  "GET /api/projects": () => jsonResponse({ items: [project], nextCursor: null }),
  "GET /api/projects/alpha/members": () => jsonResponse({ items: [member(role)], nextCursor: null }),
  [`GET /api/intents/${intentId}`]: () => jsonResponse(intentDetail),
  [`GET /api/intents/${intentId}/evidence`]: () => jsonResponse(emptyEvidence),
})

describe("IntentOfficeTab", () => {
  it("renders the card and the escalation with recommendation and default", async () => {
    await i18n.changeLanguage("ru")
    installApiMock(baseRoutes("editor"))
    renderApp(`/intents/${intentId}`)

    expect(await screen.findByRole("heading", { name: "Какую базу использовать?" })).toBeInTheDocument()
    expect(screen.getByText("Хранить интенты и историю.")).toBeInTheDocument()
    expect(screen.getByText("Рекомендация")).toBeInTheDocument()
    expect(screen.getByText("По умолчанию")).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /PostgreSQL/ })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /SQLite/ })).toBeInTheDocument()
  })

  it("sends the chosen option and the note to the API", async () => {
    await i18n.changeLanguage("ru")
    let answerBody: unknown = null
    installApiMock({
      ...baseRoutes("editor"),
      [`POST /api/intents/${intentId}/answer`]: async (request: Request) => {
        answerBody = await request.json()
        return jsonResponse({
          escalation: { ...escalation, status: "answered", answerOption: "sqlite" },
          decision: {
            ...emptyEvidence.decisions[0],
            id: escalationId,
            question: escalation.question,
            answer: "SQLite",
          },
        })
      },
    })
    const userEventApi = userEvent.setup()
    renderApp(`/intents/${intentId}`)

    await userEventApi.click(await screen.findByRole("radio", { name: /SQLite/ }))
    await userEventApi.type(screen.getByLabelText("Комментарий"), "Локальный запуск проще.")
    await userEventApi.click(screen.getByRole("button", { name: "Ответить" }))

    await waitFor(() => {
      expect(answerBody).toEqual({
        escalationId,
        optionId: "sqlite",
        note: "Локальный запуск проще.",
      })
    })
  })

  it("gives a viewer no answer or message controls", async () => {
    await i18n.changeLanguage("ru")
    installApiMock(baseRoutes("viewer"))
    renderApp(`/intents/${intentId}`)

    expect(await screen.findByRole("heading", { name: "Какую базу использовать?" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Ответить" })).toBeNull()
    expect(screen.queryByLabelText("Сообщение")).toBeNull()
    expect(screen.getAllByText("Ваша роль — только чтение.").length).toBeGreaterThan(0)
  })
})
