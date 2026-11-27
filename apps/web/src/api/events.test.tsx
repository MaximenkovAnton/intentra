import { act, render } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RECONNECT_BASE_MS, useProjectEvents } from "./events"

type Listener = (event: MessageEvent<string>) => void

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private readonly listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const current = this.listeners.get(type) ?? []
    current.push(listener)
    this.listeners.set(type, current)
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, data: unknown, lastEventId = ""): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data), lastEventId } as MessageEvent<string>)
    }
  }

  fireError(): void {
    this.onerror?.()
  }
}

const Hook = ({ projectKey }: { projectKey: string }) => {
  useProjectEvents(projectKey)
  return null
}

const wrap = (queryClient: QueryClient, projectKey = "alpha") => (
  <QueryClientProvider client={queryClient}>
    <Hook projectKey={projectKey} />
  </QueryClientProvider>
)

const createClient = (): QueryClient =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } })

describe("useProjectEvents", () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal("EventSource", FakeEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("subscribes to the project scoped stream", () => {
    const queryClient = createClient()
    render(wrap(queryClient))
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]?.url).toBe("/api/events?project=alpha")
  })

  it("does not subscribe without a project", () => {
    render(wrap(createClient(), ""))
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it("invalidates the intent queries when an intent event arrives", () => {
    const queryClient = createClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    render(wrap(queryClient))
    const source = FakeEventSource.instances[0]
    if (source === undefined) throw new Error("expected an EventSource")

    act(() => {
      source.emit("intent.updated", {
        id: "evt-1",
        type: "intent.updated",
        projectId: "p-1",
        at: "2026-01-01T00:00:00.000Z",
      })
    })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["intents"] })
  })

  it("invalidates runners when a runner event arrives", () => {
    const queryClient = createClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    render(wrap(queryClient))
    const source = FakeEventSource.instances[0]
    if (source === undefined) throw new Error("expected an EventSource")

    act(() => {
      source.emit("runner.updated", {
        id: "evt-2",
        type: "runner.updated",
        projectId: "p-1",
        at: "2026-01-01T00:00:00.000Z",
      })
    })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["runners"] })
  })

  it("reconnects with the last event id after an error", () => {
    vi.useFakeTimers()
    render(wrap(createClient()))
    const first = FakeEventSource.instances[0]
    if (first === undefined) throw new Error("expected an EventSource")

    act(() => {
      first.emit(
        "job.updated",
        { id: "evt-3", type: "job.updated", projectId: "p-1", at: "2026-01-01T00:00:00.000Z" },
        "evt-3",
      )
    })
    act(() => {
      first.fireError()
    })
    expect(FakeEventSource.instances).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(RECONNECT_BASE_MS)
    })

    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[1]?.url).toBe("/api/events?project=alpha&lastEventId=evt-3")
  })

  it("closes the stream on unmount", () => {
    const queryClient = createClient()
    const view = render(wrap(queryClient))
    const source = FakeEventSource.instances[0]
    view.unmount()
    expect(source?.closed).toBe(true)
  })
})
