export const userId = "00000000-0000-4000-8000-000000000002"
export const projectId = "00000000-0000-4000-8000-000000000001"
export const intentId = "00000000-0000-4000-8000-000000000003"
export const escalationId = "00000000-0000-4000-8000-000000000004"

export const user = {
  id: userId,
  email: "ada@example.com",
  name: "Ada Lovelace",
  avatarUrl: null,
  locale: "ru",
  isAdmin: false,
}

export const project = {
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

export const member = (role: "owner" | "editor" | "viewer") => ({
  userId,
  email: "ada@example.com",
  name: "Ada Lovelace",
  role,
  createdAt: "2026-01-01T00:00:00.000Z",
})

export const escalation = {
  id: escalationId,
  intentId,
  stage: "intake",
  question: "Какую базу использовать?",
  context: "Проект новый, данных нет.",
  options: [
    {
      id: "postgres",
      label: "PostgreSQL",
      meaning: "Реляционная база проекта.",
      reversible: true,
    },
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

export const intentDetail = {
  intent: {
    id: intentId,
    projectId,
    title: "Хранить интенты",
    statement: "Нужно хранить интенты и их историю.",
    status: "clarifying",
    createdBy: userId,
    createdAt: "2026-01-01T00:00:00.000Z",
    acceptedAt: null,
  },
  card: {
    objective: "Хранить интенты и историю.",
    users: ["Продуктовая команда"],
    jobs: ["Создать интент"],
    inScope: ["Список интентов"],
    outOfScope: ["Мобильный UI"],
    constraints: [],
    successSignals: ["Интент создаётся"],
    assumptions: [],
    risks: [],
    openQuestions: [],
  },
  openEscalations: [escalation],
}

const emptyMetrics = {
  durationMs: 60_000,
  humanWaitMs: 0,
  attempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  findingsByClass: {},
  gates: { pass: 0, fail: 0, skipped: 0 },
}

export const emptyEvidence = {
  decisions: [
    {
      id: "00000000-0000-4000-8000-000000000005",
      projectId,
      intentId,
      question: "Какую базу использовать?",
      answer: "PostgreSQL",
      rationale: null,
      alternatives: ["SQLite"],
      status: "accepted",
      supersedesId: null,
      authorKind: "user",
      authorId: userId,
      evidence: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  findings: [],
  verdicts: [],
  stages: [],
  jobs: [],
  gates: [],
  metrics: emptyMetrics,
}

export const buildEvidence = {
  ...emptyEvidence,
  jobs: [
    {
      id: "00000000-0000-4000-8000-000000000006",
      intentId,
      stageId: null,
      runnerId: "00000000-0000-4000-8000-000000000007",
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
            {
              path: "apps/web/src/App.tsx",
              status: "M",
              additions: 12,
              deletions: 3,
              binary: false,
            },
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
  gates: [{ criterion: "tests", status: "pass", durationMs: 42_000, exitCode: 0 }],
}

export const specBundle = {
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
