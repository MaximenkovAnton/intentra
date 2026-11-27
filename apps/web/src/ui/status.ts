import type { Finding, GateStatus, Job, Stage } from "../api/types"

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
