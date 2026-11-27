import { describe, expect, it } from "vitest"
import { latestJobPerTask, readDiffSummary, readJobKind, readJobLinks, readJobTaskId } from "./results"
import type { Job } from "./types"

const job = (overrides: Partial<Job>): Job => ({
  id: "job-1",
  intentId: "intent-1",
  stageId: null,
  runnerId: null,
  runtime: "dsh",
  status: "succeeded",
  payload: {},
  result: null,
  leaseUntil: null,
  attempt: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  ...overrides,
})

describe("diff summary parsing", () => {
  it("reads the camelCase diff summary emitted by the runner", () => {
    const summary = readDiffSummary({
      diffSummary: {
        files: 2,
        additions: 15,
        deletions: 4,
        entries: [
          { path: "apps/web/src/App.tsx", status: "M", additions: 12, deletions: 3, binary: false },
          { path: "logo.png", status: "A", additions: 3, deletions: 1, binary: true },
        ],
      },
    })
    expect(summary).toEqual({
      files: 2,
      additions: 15,
      deletions: 4,
      entries: [
        { path: "apps/web/src/App.tsx", status: "M", additions: 12, deletions: 3, binary: false },
        { path: "logo.png", status: "A", additions: 3, deletions: 1, binary: true },
      ],
    })
  })

  it("ignores malformed entries and a missing result", () => {
    expect(readDiffSummary(null)).toBeNull()
    expect(readDiffSummary({ diffSummary: "nope" })).toBeNull()
    expect(
      readDiffSummary({ diffSummary: { files: 1, additions: 1, deletions: 1, entries: [{ path: 7 }] } }),
    ).toEqual({ files: 1, additions: 1, deletions: 1, entries: [] })
  })

  it("never exposes anything beyond files and counts", () => {
    const summary = readDiffSummary({
      diffSummary: {
        files: 1,
        additions: 1,
        deletions: 0,
        entries: [{ path: "a.ts", status: "M", additions: 1, deletions: 0, binary: false }],
        patch: "diff --git a/a.ts b/a.ts",
      },
    })
    expect(Object.keys(summary ?? {})).toEqual(["files", "additions", "deletions", "entries"])
  })
})

describe("job link parsing", () => {
  it("reads branch, commit, link and additional links", () => {
    expect(
      readJobLinks({
        branch: "intentra/task",
        commit: "abc123",
        link: "https://github.com/acme/repo/pull/1",
        links: ["https://example.com/a", 7],
      }),
    ).toEqual({
      branch: "intentra/task",
      commit: "abc123",
      link: "https://github.com/acme/repo/pull/1",
      links: ["https://example.com/a"],
    })
  })

  it("returns empty links for a missing result", () => {
    expect(readJobLinks(null)).toEqual({ branch: null, commit: null, link: null, links: [] })
  })
})

describe("job payload helpers", () => {
  it("reads the job kind and task id", () => {
    expect(readJobKind({ kind: "build", taskId: "web-ui" })).toBe("build")
    expect(readJobTaskId({ kind: "build", taskId: "web-ui" })).toBe("web-ui")
    expect(readJobKind({})).toBeNull()
    expect(readJobTaskId({})).toBeNull()
  })

  it("keeps the newest job per plan task", () => {
    const jobs = [
      job({ id: "a", payload: { taskId: "web-ui" }, createdAt: "2026-01-01T00:00:00.000Z" }),
      job({ id: "b", payload: { taskId: "web-ui" }, createdAt: "2026-01-02T00:00:00.000Z" }),
      job({ id: "c", payload: { taskId: "api" }, createdAt: "2026-01-01T00:00:00.000Z" }),
      job({ id: "d", payload: {} }),
    ]
    const latest = latestJobPerTask(jobs)
    expect(latest.get("web-ui")?.id).toBe("b")
    expect(latest.get("api")?.id).toBe("c")
    expect(latest.size).toBe(2)
  })
})
