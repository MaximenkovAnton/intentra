import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { i18n } from "./i18n"
import { routeTree } from "./router"
import { installApiMock, jsonResponse } from "./test/apiMock"
import {
  buildEvidence,
  intentDetail,
  intentId,
  member,
  project,
  specBundle,
  user,
} from "./test/fixtures"
import { renderApp } from "./test/render"
import { ThemeProvider } from "./theme/ThemeProvider"

describe("auth guard", () => {
  it("redirects to /login when /api/auth/me returns 401", async () => {
    await i18n.changeLanguage("ru")
    installApiMock({
      "GET /api/auth/me": () =>
        jsonResponse({ code: "AUTH_REQUIRED", message: "Authentication required" }, 401),
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    })

    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryClientProvider>,
    )

    expect(await screen.findByRole("heading", { name: "Вход в Intentra" })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe("/login")
  })

  it("renders the catch-all 404 page inside the app layout", async () => {
    await i18n.changeLanguage("ru")
    installApiMock({
      "GET /api/auth/me": () =>
        jsonResponse({
          id: "00000000-0000-4000-8000-000000000002",
          email: "ada@example.com",
          name: "Ada Lovelace",
          avatarUrl: null,
          locale: "ru",
          isAdmin: false,
        }),
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/does-not-exist"] }),
    })

    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryClientProvider>,
    )

    expect(await screen.findByRole("heading", { name: "Страница не найдена" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Выйти" })).toBeInTheDocument()
  })

  it("shows the translated callback error from the error query param", async () => {
    await i18n.changeLanguage("ru")
    const queryClient = new QueryClient()
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/auth/error?error=AUTH_REQUIRED"] }),
    })

    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryClientProvider>,
    )

    expect(
      await screen.findByText("Провайдер не подтвердил вход. Попробуйте войти снова."),
    ).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Попробовать снова" })).toHaveAttribute(
      "href",
      "/api/auth/login",
    )
  })
})

const planFixture = {
  tasks: [
    {
      id: "web-ui",
      title: "Web UI",
      spec: "Все экраны §10.",
      dependsOn: [],
      paths: ["apps/web/src"],
      acceptance: ["AC-1"],
      reviewLens: "test-reviewer",
    },
  ],
}

const appRoutes = (role: "owner" | "editor" | "viewer") => ({
  "GET /api/auth/me": () => jsonResponse(user),
  "GET /api/projects": () => jsonResponse({ items: [project], nextCursor: null }),
  "GET /api/projects/alpha": () => jsonResponse(project),
  "GET /api/projects/alpha/members": () => jsonResponse({ items: [member(role)], nextCursor: null }),
  "GET /api/projects/alpha/intents": () =>
    jsonResponse({ items: [intentDetail.intent], nextCursor: null }),
  "GET /api/runners": () => jsonResponse({ items: [], nextCursor: null }),
  [`GET /api/intents/${intentId}`]: () => jsonResponse(intentDetail),
  [`GET /api/intents/${intentId}/spec`]: () => jsonResponse(specBundle),
  [`GET /api/intents/${intentId}/findings`]: () => jsonResponse({ items: [], nextCursor: null }),
  [`GET /api/intents/${intentId}/plan`]: () => jsonResponse(planFixture),
  [`GET /api/intents/${intentId}/jobs`]: () => jsonResponse({ items: [], nextCursor: null }),
  [`GET /api/intents/${intentId}/evidence`]: () => jsonResponse(buildEvidence),
})

type RouteCase = { readonly path: string; readonly heading?: string; readonly text?: string }

const routeCases: readonly RouteCase[] = [
  { path: "/", heading: "Проекты" },
  { path: "/projects", heading: "Проекты" },
  { path: "/projects/alpha", heading: "Alpha" },
  { path: "/projects/alpha/members", heading: "Участники" },
  { path: "/projects/alpha/settings", heading: "Настройки проекта" },
  { path: "/projects/alpha/runners", heading: "Runner’ы" },
  { path: "/projects/alpha/intents", heading: "Интенты" },
  { path: `/intents/${intentId}`, heading: "Карточка интента" },
  { path: `/intents/${intentId}/spec`, heading: "Спека" },
  { path: `/intents/${intentId}/critic`, heading: "Находки критика" },
  { path: `/intents/${intentId}/plan`, heading: "План сборки" },
  { path: `/intents/${intentId}/build`, heading: "Стадии" },
  { path: `/intents/${intentId}/memory`, text: "Память недоступна в этом инкременте." },
  { path: `/intents/${intentId}/evidence`, heading: "Метрики" },
  { path: "/runners", heading: "Runner’ы" },
  { path: "/memory", heading: "Память" },
  { path: "/settings", heading: "Настройки" },
]

describe("routes", () => {
  it.each(routeCases)("renders $path for a project owner", async ({ path, heading, text }) => {
    await i18n.changeLanguage("ru")
    installApiMock(appRoutes("owner"))
    renderApp(path)

    if (heading !== undefined) {
      expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument()
    }
    if (text !== undefined) {
      expect(await screen.findByText(text)).toBeInTheDocument()
    }
  })

  it.each([
    {
      path: "/projects/alpha/members",
      heading: "Участники",
      hint: "Управлять участниками может только владелец.",
      actions: ["Добавить участника", "Удалить"],
    },
    {
      path: "/projects/alpha/settings",
      heading: "Настройки проекта",
      hint: "Менять настройки проекта может только владелец.",
      actions: ["Сохранить"],
    },
    {
      path: "/projects/alpha/runners",
      heading: "Runner’ы",
      hint: "Создать токен регистрации может только владелец проекта.",
      actions: ["Создать токен регистрации"],
    },
  ])("gives a viewer no actions on $path", async ({ path, heading, hint, actions }) => {
    await i18n.changeLanguage("ru")
    installApiMock(appRoutes("viewer"))
    renderApp(path)

    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument()
    expect(await screen.findByText(hint)).toBeInTheDocument()
    for (const action of actions) {
      expect(screen.queryByRole("button", { name: action })).toBeNull()
    }
  })

  it.each([
    { path: `/intents/${intentId}`, heading: "Карточка интента" },
    { path: `/intents/${intentId}/critic`, heading: "Находки критика" },
  ])("renders an evidence error as an alert on $path", async ({ path, heading }) => {
    await i18n.changeLanguage("ru")
    installApiMock({
      ...appRoutes("owner"),
      [`GET /api/intents/${intentId}/evidence`]: () =>
        jsonResponse({ code: "UNKNOWN", message: "evidence unavailable" }, 500),
    })
    renderApp(path)

    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument()
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Не удалось выполнить запрос. Попробуйте ещё раз.",
    )
  })
})
