import type { ErrorCode } from "@intentra/contracts"
import type { components } from "./schema"

export type ApiErrorCode = components["schemas"]["ApiError"]["code"]

export type ApiErrorBody = components["schemas"]["ApiError"]

export class ApiRequestError extends Error {
  readonly code: ApiErrorCode | "UNKNOWN"
  readonly status: number

  constructor(message: string, code: ApiErrorCode | "UNKNOWN", status: number) {
    super(message)
    this.name = "ApiRequestError"
    this.code = code
    this.status = status
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const API_ERROR_CODES = {
  AUTH_REQUIRED: true,
  FORBIDDEN: true,
  VALIDATION: true,
  CONFLICT: true,
  NOT_FOUND: true,
  LIMIT: true,
  RUNNER_OFFLINE: true,
  ESCALATION_EXPIRED: true,
  UPSTREAM_FAILED: true,
  RELEASE_DISABLED: true,
  INTERNAL: true,
} satisfies Record<ErrorCode, true>

const isApiErrorCode = (value: string): value is ApiErrorCode => Object.hasOwn(API_ERROR_CODES, value)

export const isApiErrorBody = (value: unknown): value is ApiErrorBody => {
  if (!isRecord(value)) return false
  const { code, message } = value
  return typeof code === "string" && isApiErrorCode(code) && typeof message === "string"
}

export const toApiError = (error: unknown, status: number): ApiRequestError => {
  if (isApiErrorBody(error)) return new ApiRequestError(error.message, error.code, status)
  if (status === 401) return new ApiRequestError("Authentication required", "AUTH_REQUIRED", status)
  if (status === 403) return new ApiRequestError("Forbidden", "FORBIDDEN", status)
  if (status === 404) return new ApiRequestError("Not found", "NOT_FOUND", status)
  return new ApiRequestError(`Request failed with status ${status}`, "UNKNOWN", status)
}

export const isAuthRequiredError = (error: unknown): boolean =>
  error instanceof ApiRequestError && (error.code === "AUTH_REQUIRED" || error.status === 401)

export const isNotFoundError = (error: unknown): boolean =>
  error instanceof ApiRequestError &&
  (error.code === "NOT_FOUND" || error.status === 404)
