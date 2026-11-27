import { expect, test } from "@playwright/test"
import type { Page, Route } from "@playwright/test"

const userId = "00000000-0000-4000-8000-000000000002"
const projectId = "00000000-0000-4000-8000-000000000001"
const intentId = "00000000-0000-4000-8000-000000000003"
const escalationId = "00000000-0000-4000-8000-000000000004"

const user = {
  id: userId,
  email: "ada@example.com",
  name: "Ada Lovelace",
  avatarUrl: null,
  locale: "ru",
  isAdmin: false,
}

const project = {
  id: projectId,
  key: "alpha",
  name: "Alpha",
  description: null,
  repoUrl: null,
  defaultBranch: "main",
  createdBy: userId,
  createdAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
}

const member = (role: "owner" | "editor" | "viewer") => ({
  userId,
  email: "ada@example.com",
  name: "Ada Lovelace",
  role,
  createdAt: "2026-01-01T00:00:00.000Z",
})

const intent = {
  id: intentId,
  projectId,
  title: "Хранить интенты",
  statement: "Нужно хранить интенты и их историю.",
  status: "clarifying",
  createdBy: userId,
  createdAt: "2026-01-01T00:00:00.000Z",
  acceptedAt: null,
}

const escalation = {
  id: escalationId,
  intentId,
  stage: "intake",
  question: "Какую базу использовать?",
  context: "Проект новый, данных нет.",
  options: [
    { id: "postgres", label: "PostgreSQL", meaning: "Реляционная база проекта.", reversible: true },
    { id: "sqlite", label: "SQLite", meaning: "Файловая база без сервера.", reversible: false },
  ],
  recommendation: "postgres",
  defaultOption: "postgres",
  expiresAt: null,
  status: "open",
  answerOption: null,
  answerNote: null,
  answeredBy: null,
  answeredAt: null,
  decisionId: null,
}

const emptyEvidence = {
  decisions: [],
  findings: [],
  verdicts: [],
  stages: [
    {
      id: "00000000-0000-4000-8000-000000000008",
      intentId,
      kind: "build",
      status: "succeeded",
      attempt: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:02:00.000Z",
      error: null,
    },
  ],
  jobs: [
    {
      id: "00000000-0000-4000-8000-000000000006",
      intentId,
      stageId: null,
      runnerId: null,
      runtime: "dsh",
      status: "succeeded",
      payload: { kind: "build", taskId: "web-ui" },
      result: {
        branch: "intentra/web-ui",
        commit: "abcdef1234567890",
        link: "https://github.com/acme/repo/pull/1",
        diffSummary: {
          files: 1,
          additions: 12,
          deletions: 3,
          entries: [
            { path: "apps/web/src/App.tsx", status: "M", additions: 12, deletions: 3, binary: false },
          ],
        },
      },
      leaseUntil: null,
      attempt: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:01:00.000Z",
      finishedAt: "2026-01-01T00:02:00.000Z",
    },
  ],
  gates: [{ criterion: "tests", status: "pass", durationMs: 42_000, exitCode: 0 }],
  metrics: {
    durationMs: 60_000,
    humanWaitMs: 0,
    attempts: 1,
    inputTokens: 100,
    outputTokens: 200,
    findingsByClass: {},
    gates: { pass: 1, fail: 0, skipped: 0 },
  },
}

const specBundle = {
  spec: {
    id: "00000000-0000-4000-8000-000000000009",
    intentId,
    version: 1,
    bodyMd: "# Спека\n\nХранить интенты.",
    status: "approved",
    sha256: "a".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  requirements: [
    {
      id: "00000000-0000-4000-8000-000000000010",
      specId: "00000000-0000-4000-8000-000000000009",
      acId: "AC-1",
      text: "Интент создаётся и хранится.",
      kind: "functional",
      status: "met",
    },
  ],
  dodRows: [
    {
      id: "00000000-0000-4000-8000-000000000011",
      requirementId: "00000000-0000-4000-8000-000000000010",
      testRef: "src/intents.test.ts",
      probe: "pnpm test",
      status: "pass",
    },
  ],
}

type ApiState = {
  answerBody: unknown
  intentStatus: string
  created: boolean
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })

const installApi = async (
  page: Page,
  role: "owner" | "editor" | "viewer",
): Promise<ApiState> => {
  const state: ApiState = { answerBody: null, intentStatus: "clarifying", created: false }

  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204, body: "" }))
  await page.route(/\/api\/events(\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: ": ok\n\n",
    }),
  )
  await page.route("**/api/auth/me", (route) => json(route, user))
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({ status: 302, headers: { location: "/" } }),
  )
  await page.route("**/api/projects/alpha/members", (route) =>
    json(route, { items: [member(role)], nextCursor: null }),
  )
  await page.route("**/api/projects/alpha/intents", (route) => {
    if (route.request().method() === "POST") {
      state.created = true
      return json(route, intent, 201)
    }
    return json(route, {
      items: state.created ? [{ ...intent, status: state.intentStatus }] : [],
      nextCursor: null,
    })
  })
  await page.route("**/api/projects/alpha", (route) => json(route, project))
  await page.route("**/api/projects", (route) =>
    route.request().method() === "GET" ? json(route, { items: [project], nextCursor: null }) : json(route, project, 201),
  )
  await page.route("**/api/runners", (route) => json(route, { items: [], nextCursor: null }))
  await page.route(/\/api\/intents\/[0-9a-f-]+\/answer$/, (route) => {
    state.answerBody = route.request().postDataJSON()
    state.intentStatus = "awaiting_acceptance"
    return json(route, {
      escalation: { ...escalation, status: "answered", answerOption: "sqlite" },
      decision: {
        id: "00000000-0000-4000-8000-000000000005",
        projectId,
        intentId,
        question: escalation.question,
        answer: "SQLite",
        rationale: null,
        alternatives: ["PostgreSQL"],
        status: "accepted",
        supersedesId: null,
        authorKind: "user",
        authorId: userId,
        evidence: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    })
  })
  await page.route(/\/api\/intents\/[0-9a-f-]+\/accept$/, (route) => {
    state.intentStatus = "accepted"
    return json(route, {
      ...intent,
      status: "accepted",
      acceptedAt: "2026-01-01T01:00:00.000Z",
    })
  })
  await page.route(/\/api\/intents\/[0-9a-f-]+\/evidence$/, (route) => json(route, emptyEvidence))
  await page.route(/\/api\/intents\/[0-9a-f-]+\/findings$/, (route) =>
    json(route, { items: [], nextCursor: null }),
  )
  await page.route(/\/api\/intents\/[0-9a-f-]+\/spec$/, (route) => json(route, specBundle))
  await page.route(/\/api\/intents\/[0-9a-f-]+\/jobs$/, (route) =>
    json(route, { items: [], nextCursor: null }),
  )
  await page.route(/\/api\/intents\/[0-9a-f-]+\/?$/, (route) =>
    json(route, {
      intent: { ...intent, status: state.intentStatus },
      card: null,
      openEscalations: state.answerBody === null ? [escalation] : [],
    }),
  )
  return state
}

const collectConsoleErrors = (page: Page): string[] => {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(error.message))
  return errors
}

test("signs in, creates an intent, answers the escalation, reads the spec and build, then accepts", async ({
  page,
}) => {
  const consoleErrors = collectConsoleErrors(page)
  const state = await installApi(page, "owner")

  await page.goto("/login")
  await page.getByRole("link", { name: "Войти через Pocket ID" }).click()

  await expect(page.getByRole("heading", { name: "Проекты" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible()
  await page.getByRole("link", { name: "Обзор" }).click()
  await expect(page.getByRole("heading", { name: "Alpha", level: 1 })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Обзор проекта" })).toBeVisible()

  await page.getByRole("link", { name: "Интенты" }).first().click()
  await expect(page.getByRole("heading", { name: "Новый интент" })).toBeVisible()
  await page.getByLabel("Название").fill("Хранить интенты")
  await page.getByLabel("Намерение").fill("Нужно хранить интенты и их историю.")
  await page.getByRole("button", { name: "Создать интент" }).click()
  await expect(page.getByRole("cell", { name: "Хранить интенты" })).toBeVisible()
  await page.getByRole("link", { name: "Открыть" }).click()

  await expect(page.getByRole("heading", { name: "Хранить интенты" })).toBeVisible()
  await expect(page.getByText("Какую базу использовать?")).toBeVisible()
  await expect(page.getByText("По умолчанию")).toBeVisible()
  await page.getByRole("radio", { name: /SQLite/ }).check()
  await page.getByRole("button", { name: "Ответить" }).click()
  await expect.poll(() => state.answerBody).not.toBeNull()
  expect(state.answerBody).toEqual({ escalationId, optionId: "sqlite" })

  await page.getByRole("link", { name: "Спека" }).click()
  await expect(page.getByText("AC-1")).toBeVisible()
  await expect(page.getByText("Интент создаётся и хранится.")).toBeVisible()
  await expect(page.getByText("src/intents.test.ts")).toBeVisible()

  await page.getByRole("link", { name: "Исполнение" }).click()
  await expect(page.getByText("apps/web/src/App.tsx")).toBeVisible()
  await expect(page.getByText("+12").first()).toBeVisible()
  await expect(page.getByText("−3").first()).toBeVisible()
  await expect(
    page.getByText("Только имена файлов и количество строк: содержимое диффа в центр не попадает."),
  ).toBeVisible()
  expect(await page.getByText(/diff --git/).count()).toBe(0)
  expect(await page.locator('input[type="password"]').count()).toBe(0)

  await page.getByRole("button", { name: "Принять" }).click()
  await expect(page.getByText("Принят", { exact: true })).toBeVisible()

  expect(consoleErrors).toEqual([])
})

test("shows a viewer only read-only screens", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page)
  await installApi(page, "viewer")

  await page.goto(`/intents/${intentId}`)
  await expect(page.getByRole("heading", { name: "Хранить интенты" })).toBeVisible()
  await expect(page.getByText("Какую базу использовать?")).toBeVisible()
  expect(await page.getByRole("button", { name: "Ответить" }).count()).toBe(0)
  expect(await page.getByLabel("Сообщение").count()).toBe(0)
  expect(await page.getByRole("button", { name: "Принять" }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "Отменить интент" }).count()).toBe(0)

  await page.goto("/projects/alpha/intents")
  await expect(
    page.getByText("Создавать интенты может редактор или владелец проекта."),
  ).toBeVisible()
  expect(await page.getByRole("button", { name: "Создать интент" }).count()).toBe(0)

  expect(consoleErrors).toEqual([])
})
