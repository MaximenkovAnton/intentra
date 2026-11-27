import createClient from "openapi-fetch"
import { toApiError } from "./errors"
import type { paths } from "./schema"

export const api = createClient<paths>({ baseUrl: "", credentials: "include" })

type RequestResult<T> = {
  data?: T
  error?: unknown
  response: Response
}

type EmptyRequestResult = {
  error?: unknown
  response: Response
}

export const unwrapResponse = async <T>(request: Promise<RequestResult<T>>): Promise<T> => {
  const { data, error, response } = await request
  if (error !== undefined) throw toApiError(error, response.status)
  if (!response.ok) throw toApiError(undefined, response.status)
  if (data === undefined) throw toApiError(undefined, response.status)
  return data
}

export const expectNoContent = async (request: Promise<EmptyRequestResult>): Promise<void> => {
  const { error, response } = await request
  if (error !== undefined) throw toApiError(error, response.status)
  if (!response.ok) throw toApiError(undefined, response.status)
}
