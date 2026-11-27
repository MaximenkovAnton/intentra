import type { Job } from "./types"

export type DiffFile = {
  path: string
  status: string
  additions: number
  deletions: number
  binary: boolean
}

export type DiffSummary = {
  files: number
  additions: number
  deletions: number
  entries: DiffFile[]
}

export type JobLinks = {
  branch: string | null
  commit: string | null
  link: string | null
  links: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readString = (value: unknown): string | null => (typeof value === "string" ? value : null)

const readCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0

const readDiffFile = (value: unknown): DiffFile | null => {
  if (!isRecord(value)) return null
  const path = readString(value.path)
  if (path === null) return null
  return {
    path,
    status: readString(value.status) ?? "",
    additions: readCount(value.additions),
    deletions: readCount(value.deletions),
    binary: value.binary === true,
  }
}

export const readDiffSummary = (result: Record<string, unknown> | null): DiffSummary | null => {
  if (result === null) return null
  const raw = result.diffSummary
  if (!isRecord(raw)) return null
  const entries = Array.isArray(raw.entries)
    ? raw.entries.flatMap((entry) => {
        const file = readDiffFile(entry)
        return file === null ? [] : [file]
      })
    : []
  return {
    files: readCount(raw.files),
    additions: readCount(raw.additions),
    deletions: readCount(raw.deletions),
    entries,
  }
}

export const readJobLinks = (result: Record<string, unknown> | null): JobLinks => {
  if (result === null) {
    return { branch: null, commit: null, link: null, links: [] }
  }
  return {
    branch: readString(result.branch),
    commit: readString(result.commit),
    link: readString(result.link),
    links: Array.isArray(result.links)
      ? result.links.filter((link): link is string => typeof link === "string")
      : [],
  }
}

export const readJobKind = (payload: Record<string, unknown>): string | null =>
  readString(payload.kind)

export const readJobTaskId = (payload: Record<string, unknown>): string | null =>
  readString(payload.taskId)

export const latestJobPerTask = (jobs: readonly Job[]): ReadonlyMap<string, Job> => {
  const latest = new Map<string, Job>()
  for (const job of jobs) {
    const taskId = readJobTaskId(job.payload)
    if (taskId === null) continue
    const current = latest.get(taskId)
    if (current === undefined || job.createdAt > current.createdAt) latest.set(taskId, job)
  }
  return latest
}
