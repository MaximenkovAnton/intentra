import { vi } from "vitest"

export type RouteHandler = (request: Request) => Response | Promise<Response>

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

let handlers: Record<string, RouteHandler> = {}

const fetchMock = vi.fn(async (input: Request): Promise<Response> => {
  const url = new URL(input.url, "http://localhost")
  const key = `${input.method.toUpperCase()} ${url.pathname}`
  const handler = handlers[key]
  if (handler === undefined) {
    return jsonResponse({ code: "NOT_FOUND", message: `No API stub for ${key}` }, 404)
  }
  return handler(input)
})

export const installFetchRouter = (): void => {
  vi.stubGlobal("fetch", fetchMock)
}

export const installApiMock = (routes: Record<string, RouteHandler>) => {
  handlers = routes
  fetchMock.mockClear()
  return fetchMock
}

export const resetApiMock = (): void => {
  handlers = {}
  fetchMock.mockClear()
}
