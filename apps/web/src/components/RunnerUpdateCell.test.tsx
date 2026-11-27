import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import type { Runner } from "../api/types"
import { i18n } from "../i18n"
import { installApiMock, jsonResponse } from "../test/apiMock"
import { user } from "../test/fixtures"
import { renderWithProviders } from "../test/render"
import { RunnerUpdateCell } from "./RunnerUpdateCell"

const RUNNER_ID = "00000000-0000-4000-8000-000000000010"
const POLICY_PATH = `PUT /api/runners/${RUNNER_ID}/update-policy`

const runner = (overrides: Partial<Runner> = {}): Runner => ({
  id: RUNNER_ID,
  name: "runner-1",
  ownerUserId: user.id,
  os: "linux",
  arch: "x86_64",
  version: "0.1.0",
  capabilities: [],
  status: "online",
  lastSeenAt: "2026-11-20T09:00:00.000Z",
  revokedAt: null,
  pinnedVersion: null,
  autoUpdate: true,
  latestVersion: "0.2.0",
  updateAvailable: true,
  lastUpdate: null,
  ...overrides,
})

const policyBodies = async (fetchMock: ReturnType<typeof installApiMock>) => {
  const requests = await waitFor(() => {
    const calls = fetchMock.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method === "PUT")
    expect(calls).toHaveLength(1)
    return calls
  })
  const [request] = requests
  if (request === undefined) throw new Error("expected a PUT request")
  return { path: new URL(request.url).pathname, body: await request.json() }
}

describe("RunnerUpdateCell", () => {
  it("pins the typed version and sends the current auto-update flag", async () => {
    await i18n.changeLanguage("ru")
    const fetchMock = installApiMock({
      [POLICY_PATH]: () => new Response(null, { status: 204 }),
    })
    const userEventApi = userEvent.setup()
    renderWithProviders(<RunnerUpdateCell runner={runner()} canManage />)

    await userEventApi.type(screen.getByRole("textbox", { name: "Пин версии" }), "0.2.0")
    await userEventApi.click(screen.getByRole("button", { name: "Закрепить" }))

    await expect(policyBodies(fetchMock)).resolves.toEqual({
      path: `/api/runners/${RUNNER_ID}/update-policy`,
      body: { pinnedVersion: "0.2.0", autoUpdate: true },
    })
  })

  it("resets the pin while keeping the auto-update flag", async () => {
    await i18n.changeLanguage("ru")
    const fetchMock = installApiMock({
      [POLICY_PATH]: () => new Response(null, { status: 204 }),
    })
    const userEventApi = userEvent.setup()
    renderWithProviders(<RunnerUpdateCell runner={runner({ pinnedVersion: "0.2.0" })} canManage />)

    await userEventApi.click(screen.getByRole("button", { name: "Сбросить" }))

    await expect(policyBodies(fetchMock)).resolves.toEqual({
      path: `/api/runners/${RUNNER_ID}/update-policy`,
      body: { pinnedVersion: null, autoUpdate: true },
    })
  })

  it("toggles auto-update without dropping the stored pin", async () => {
    await i18n.changeLanguage("ru")
    const fetchMock = installApiMock({
      [POLICY_PATH]: () => new Response(null, { status: 204 }),
    })
    const userEventApi = userEvent.setup()
    renderWithProviders(
      <RunnerUpdateCell runner={runner({ pinnedVersion: "0.2.0", autoUpdate: true })} canManage />,
    )

    await userEventApi.click(screen.getByRole("checkbox", { name: "Автообновление" }))

    await expect(policyBodies(fetchMock)).resolves.toEqual({
      path: `/api/runners/${RUNNER_ID}/update-policy`,
      body: { pinnedVersion: "0.2.0", autoUpdate: false },
    })
  })

  it("keeps a typed pin draft when auto-update is toggled", async () => {
    await i18n.changeLanguage("ru")
    const fetchMock = installApiMock({
      [POLICY_PATH]: () => new Response(null, { status: 204 }),
    })
    const userEventApi = userEvent.setup()
    renderWithProviders(
      <RunnerUpdateCell runner={runner({ pinnedVersion: "0.1.0", autoUpdate: true })} canManage />,
    )

    const pinInput = screen.getByRole("textbox", { name: "Пин версии" })
    await userEventApi.clear(pinInput)
    await userEventApi.type(pinInput, "9.9.9")
    await userEventApi.click(screen.getByRole("checkbox", { name: "Автообновление" }))

    await expect(policyBodies(fetchMock)).resolves.toEqual({
      path: `/api/runners/${RUNNER_ID}/update-policy`,
      body: { pinnedVersion: "0.1.0", autoUpdate: false },
    })
    expect(pinInput).toHaveValue("9.9.9")
  })

  it("shows the API error when the policy update is rejected", async () => {
    await i18n.changeLanguage("ru")
    installApiMock({
      [POLICY_PATH]: () => jsonResponse({ code: "VALIDATION", message: "invalid version" }, 400),
    })
    const userEventApi = userEvent.setup()
    renderWithProviders(<RunnerUpdateCell runner={runner()} canManage />)

    await userEventApi.type(screen.getByRole("textbox", { name: "Пин версии" }), "not-a-version")
    await userEventApi.click(screen.getByRole("button", { name: "Закрепить" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("Проверьте введённые данные.")
  })

  it("renders the policy read-only without controls for a non-owner", async () => {
    await i18n.changeLanguage("ru")
    renderWithProviders(
      <RunnerUpdateCell runner={runner({ pinnedVersion: "0.2.0", autoUpdate: false })} canManage={false} />,
    )

    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(screen.queryByRole("button")).toBeNull()
    expect(
      screen.getByText("Закреплено: 0.2.0 · Автообновление: выключено"),
    ).toBeInTheDocument()
  })
})
