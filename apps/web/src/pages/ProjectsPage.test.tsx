import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { i18n } from "../i18n"
import { installApiMock, jsonResponse } from "../test/apiMock"
import { renderApp } from "../test/render"

const user = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "ada@example.com",
  name: "Ada Lovelace",
  avatarUrl: null,
  locale: "ru",
  isAdmin: false,
}

const project = {
  id: "00000000-0000-4000-8000-000000000001",
  key: "alpha",
  name: "Alpha",
  description: null,
  repoUrl: null,
  defaultBranch: "main",
  createdBy: user.id,
  createdAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
}

describe("ProjectsPage", () => {
  it("renders projects returned by the API", async () => {
    await i18n.changeLanguage("ru")
    installApiMock({
      "GET /api/auth/me": () => jsonResponse(user),
      "GET /api/projects": () => jsonResponse({ items: [project], nextCursor: null }),
    })
    renderApp("/")

    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument()
    expect(screen.getByText("alpha")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Обзор" })).toHaveAttribute("href", "/projects/alpha")
    expect(screen.getByRole("link", { name: "Интенты" })).toHaveAttribute(
      "href",
      "/projects/alpha/intents",
    )
    expect(screen.getByRole("heading", { name: "Проекты" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Проекты" })).toHaveAttribute("aria-current", "page")
    expect(screen.getByRole("link", { name: "Перейти к содержимому" })).toHaveAttribute(
      "href",
      "#main-content",
    )
  })

  it("validates the create dialog without calling the API", async () => {
    await i18n.changeLanguage("ru")
    const fetchMock = installApiMock({
      "GET /api/auth/me": () => jsonResponse(user),
      "GET /api/projects": () => jsonResponse({ items: [], nextCursor: null }),
    })
    const userEventApi = userEvent.setup()
    renderApp("/")

    await screen.findByText("Проектов пока нет. Создайте первый проект.")
    await userEventApi.click(screen.getByRole("button", { name: "Создать проект" }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    await userEventApi.click(screen.getByRole("button", { name: "Создать" }))

    expect(await screen.findByText("Укажите ключ проекта.")).toBeInTheDocument()
    expect(screen.getByText("Укажите название проекта.")).toBeInTheDocument()
    const postCalls = fetchMock.mock.calls.filter(([input]) => input.method === "POST")
    expect(postCalls).toHaveLength(0)
  })
})
