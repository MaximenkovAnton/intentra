import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import type { Runner } from "../api/types"
import { formatDateTime } from "../i18n/format"
import { i18n } from "../i18n"
import { installApiMock, jsonResponse } from "../test/apiMock"
import { user } from "../test/fixtures"
import { renderApp } from "../test/render"

const ownerId = user.id
const admin = { ...user, isAdmin: true }
const viewer = { ...user, id: "00000000-0000-4000-8000-000000000099", isAdmin: false }

const runner = (overrides: Partial<Runner>): Runner => ({
  id: "00000000-0000-4000-8000-000000000010",
  name: "runner-1",
  ownerUserId: ownerId,
  os: "linux",
  arch: "x86_64",
  version: "0.2.0",
  capabilities: [],
  status: "online",
  lastSeenAt: "2026-11-20T09:00:00.000Z",
  revokedAt: null,
  pinnedVersion: null,
  autoUpdate: true,
  latestVersion: "0.2.0",
  updateAvailable: false,
  lastUpdate: null,
  ...overrides,
})

const lastUpdate = (
  status: "applied" | "rolled_back" | "failed",
  createdAt: string,
) => ({
  fromVersion: "0.1.0",
  toVersion: "0.2.0",
  status,
  reason: null,
  createdAt,
})

const runners = [
  runner({ id: "00000000-0000-4000-8000-000000000011", name: "actual", version: "0.2.0" }),
  runner({
    id: "00000000-0000-4000-8000-000000000012",
    name: "available",
    version: "0.1.0",
    latestVersion: "0.2.0",
    updateAvailable: true,
  }),
  runner({
    id: "00000000-0000-4000-8000-000000000013",
    name: "updated",
    version: "0.2.0",
    lastUpdate: lastUpdate("applied", "2026-11-20T10:00:00.000Z"),
  }),
  runner({
    id: "00000000-0000-4000-8000-000000000014",
    name: "rolled-back",
    version: "0.1.0",
    latestVersion: "0.2.0",
    updateAvailable: true,
    lastUpdate: lastUpdate("rolled_back", "2026-11-21T10:00:00.000Z"),
  }),
  runner({
    id: "00000000-0000-4000-8000-000000000015",
    name: "failed",
    version: "0.1.0",
    latestVersion: "0.2.0",
    updateAvailable: true,
    lastUpdate: lastUpdate("failed", "2026-11-22T10:00:00.000Z"),
  }),
]

const routes = (me: typeof user) => ({
  "GET /api/auth/me": () => jsonResponse(me),
  "GET /api/runners": () => jsonResponse({ items: runners, nextCursor: null }),
})

describe("RunnersPage update state", () => {
  it("renders the current and available versions, every update status and the last event time", async () => {
    await i18n.changeLanguage("ru")
    installApiMock(routes(admin))
    renderApp("/runners")

    expect(await screen.findByRole("heading", { name: "Runner’ы" })).toBeInTheDocument()
    expect(await screen.findByText("Актуально")).toBeInTheDocument()
    expect(screen.getByText("Обновлено")).toBeInTheDocument()
    expect(screen.getByText("Откат выполнен")).toBeInTheDocument()
    expect(screen.getByText("Ошибка обновления")).toBeInTheDocument()
    expect(screen.getAllByText("Доступно обновление").length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText("0.1.0")).toHaveLength(3)
    expect(screen.getAllByText(/→ 0\.2\.0/)).toHaveLength(3)
    expect(
      screen.getByText(formatDateTime("2026-11-20T10:00:00.000Z", "ru")),
    ).toBeInTheDocument()
    expect(screen.getAllByRole("textbox", { name: "Пин версии" })).toHaveLength(runners.length)
    expect(screen.getAllByRole("checkbox", { name: "Автообновление" })).toHaveLength(runners.length)
  })

  it("gives a non-owner read-only update state", async () => {
    await i18n.changeLanguage("ru")
    installApiMock(routes(viewer))
    renderApp("/runners")

    expect(await screen.findByRole("heading", { name: "Runner’ы" })).toBeInTheDocument()
    expect(await screen.findAllByText(/Версия не закреплена/)).toHaveLength(runners.length)
    expect(screen.queryByRole("textbox", { name: "Пин версии" })).toBeNull()
    expect(screen.queryByRole("checkbox", { name: "Автообновление" })).toBeNull()
  })

  it("refetches the runners list after a successful policy change", async () => {
    await i18n.changeLanguage("ru")
    let listRequests = 0
    const [firstRunner] = runners
    if (firstRunner === undefined) throw new Error("expected a runner fixture")
    installApiMock({
      ...routes(admin),
      "GET /api/runners": () => {
        listRequests += 1
        return jsonResponse({ items: runners, nextCursor: null })
      },
      [`PUT /api/runners/${firstRunner.id}/update-policy`]: () => new Response(null, { status: 204 }),
    })
    const userEventApi = userEvent.setup()
    renderApp("/runners")

    const [pinInput] = await screen.findAllByRole("textbox", { name: "Пин версии" })
    const [pinButton] = screen.getAllByRole("button", { name: "Закрепить" })
    if (pinInput === undefined || pinButton === undefined) throw new Error("expected controls")
    const requestsBeforeSave = listRequests

    await userEventApi.type(pinInput, "0.2.0")
    await userEventApi.click(pinButton)

    await waitFor(() => expect(listRequests).toBe(requestsBeforeSave + 1))
  })
})
