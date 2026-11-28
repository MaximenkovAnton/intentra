import type { Finding, GateStatus, Job, Runner, Stage } from "../api/types"

export type Tone = "neutral" | "success" | "danger" | "warning"

export const jobTone = (status: Job["status"]): Tone => {
  switch (status) {
    case "succeeded":
      return "success"
    case "failed":
    case "cancelled":
    case "expired":
      return "danger"
    case "running":
    case "offered":
      return "warning"
    case "queued":
      return "neutral"
  }
}

export const stageTone = (status: Stage["status"]): Tone => {
  switch (status) {
    case "succeeded":
      return "success"
    case "failed":
    case "blocked":
    case "cancelled":
      return "danger"
    case "running":
      return "warning"
    case "pending":
      return "neutral"
  }
}

export const gateTone = (status: GateStatus["status"]): Tone => {
  switch (status) {
    case "pass":
      return "success"
    case "fail":
      return "danger"
    case "skipped":
      return "neutral"
  }
}

export const findingTone = (finding: Finding): Tone =>
  finding.severity === "blocking" ? "danger" : "neutral"

export const intentTone = (status: string): Tone => {
  switch (status) {
    case "accepted":
      return "success"
    case "rejected":
    case "cancelled":
      return "danger"
    case "awaiting_acceptance":
      return "warning"
    default:
      return "neutral"
  }
}

export const runnerTone = (status: string): Tone => {
  switch (status) {
    case "online":
      return "success"
    case "offline":
      return "warning"
    case "revoked":
      return "danger"
    default:
      return "neutral"
  }
}

export type RunnerUpdateStatus = "actual" | "available" | "updated" | "rolled_back" | "failed"

export const runnerUpdateStatus = (
  runner: Pick<Runner, "updateAvailable" | "lastUpdate">,
): RunnerUpdateStatus => {
  switch (runner.lastUpdate?.status) {
    case "applied":
      return "updated"
    case "rolled_back":
      return "rolled_back"
    case "failed":
      return "failed"
    default:
      return runner.updateAvailable ? "available" : "actual"
  }
}

export const runnerUpdateTone = (status: RunnerUpdateStatus): Tone => {
  switch (status) {
    case "actual":
    case "updated":
      return "success"
    case "available":
    case "rolled_back":
      return "warning"
    case "failed":
      return "danger"
  }
}

export const claimTone = (status: string): Tone => {
  switch (status) {
    case "fresh":
      return "success"
    case "stale":
    case "contradicted":
      return "danger"
    default:
      return "neutral"
  }
}
