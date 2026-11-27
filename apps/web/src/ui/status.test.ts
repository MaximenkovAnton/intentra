import { describe, expect, it } from "vitest"
import { runnerUpdateStatus } from "./status"
import type { RunnerUpdateStatus } from "./status"

type UpdateEvent = {
  fromVersion: string
  toVersion: string
  status: "applied" | "rolled_back" | "failed"
  reason: string | null
  createdAt: string
}

const lastUpdate = (status: UpdateEvent["status"]): UpdateEvent => ({
  fromVersion: "0.1.0",
  toVersion: "0.2.0",
  status,
  reason: null,
  createdAt: "2026-11-20T10:00:00.000Z",
})

const cases: Array<{
  name: string
  updateAvailable: boolean
  lastUpdate: UpdateEvent | null
  expected: RunnerUpdateStatus
}> = [
  { name: "actual without events or a newer release", updateAvailable: false, lastUpdate: null, expected: "actual" },
  { name: "available before any event", updateAvailable: true, lastUpdate: null, expected: "available" },
  { name: "updated after an applied event", updateAvailable: false, lastUpdate: lastUpdate("applied"), expected: "updated" },
  { name: "updated after an applied event even if a newer release exists", updateAvailable: true, lastUpdate: lastUpdate("applied"), expected: "updated" },
  { name: "rolled_back after a rollback event", updateAvailable: true, lastUpdate: lastUpdate("rolled_back"), expected: "rolled_back" },
  { name: "failed after a failed event", updateAvailable: true, lastUpdate: lastUpdate("failed"), expected: "failed" },
]

describe("runner update status", () => {
  it.each(cases)("$name", ({ updateAvailable, lastUpdate: event, expected }) => {
    expect(runnerUpdateStatus({ updateAvailable, lastUpdate: event })).toBe(expected)
  })
})
