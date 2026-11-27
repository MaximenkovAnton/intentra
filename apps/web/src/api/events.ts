import { useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import type { QueryClient } from "@tanstack/react-query"
import type { SseEvent } from "./types"

const SSE_EVENT_TYPES = [
  "intent.updated",
  "stage.updated",
  "job.updated",
  "escalation.created",
  "escalation.answered",
  "finding.created",
  "runner.updated",
  "memory.updated",
] as const

export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_MAX_MS = 30_000

const INVALIDATION_PREFIXES: Record<SseEvent["type"], readonly (readonly string[])[]> = {
  "intent.updated": [["intents"]],
  "stage.updated": [["intents"]],
  "job.updated": [["intents"]],
  "escalation.created": [["intents"]],
  "escalation.answered": [["intents"]],
  "finding.created": [["intents"]],
  "runner.updated": [["runners"]],
  "memory.updated": [["memory"]],
}

const reload = (queryClient: QueryClient, type: SseEvent["type"]): void => {
  for (const queryKey of INVALIDATION_PREFIXES[type]) {
    void queryClient.invalidateQueries({ queryKey })
  }
}

const isSseType = (value: string): value is SseEvent["type"] =>
  SSE_EVENT_TYPES.some((type) => type === value)

export const useProjectEvents = (projectKey: string | null): void => {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (projectKey === null || projectKey.length === 0 || typeof EventSource === "undefined") return
    let source: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let attempt = 0
    let lastEventId: string | null = null

    const scheduleReconnect = (): void => {
      if (stopped) return
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
      attempt += 1
      timer = setTimeout(connect, delay)
    }

    const connect = (): void => {
      if (stopped) return
      const params = new URLSearchParams({ project: projectKey })
      if (lastEventId !== null) params.set("lastEventId", lastEventId)
      const current = new EventSource(`/api/events?${params.toString()}`)
      source = current
      current.onopen = () => {
        attempt = 0
      }
      current.onerror = () => {
        current.close()
        if (source === current) source = null
        scheduleReconnect()
      }
      for (const type of SSE_EVENT_TYPES) {
        current.addEventListener(type, (event) => {
          const message = event as MessageEvent<string>
          if (message.lastEventId !== "") lastEventId = message.lastEventId
          try {
            const parsed: unknown = JSON.parse(message.data)
            if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
              const eventType = (parsed as SseEvent).type
              if (isSseType(eventType)) {
                reload(queryClient, eventType)
                return
              }
            }
          } catch {
            return
          }
          reload(queryClient, type)
        })
      }
    }

    connect()

    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      source?.close()
    }
  }, [projectKey, queryClient])
}
