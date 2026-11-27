import { describe, expect, expectTypeOf, it } from "vitest"
import { en } from "../i18n/en"
import { ru } from "../i18n/ru"
import { isApiErrorBody, toApiError, type ApiErrorCode } from "./errors"
import type { paths } from "./schema"

describe("release channel errors in the web client", () => {
  it("carries the release channel path and error codes from the generated schema", () => {
    expectTypeOf<paths>().toHaveProperty("/api/runners/update")
    expectTypeOf<"UPSTREAM_FAILED" | "RELEASE_DISABLED">().toMatchTypeOf<ApiErrorCode>()
  })

  it("parses the release error bodies into typed errors", () => {
    for (const [code, status] of [
      ["UPSTREAM_FAILED", 502],
      ["RELEASE_DISABLED", 503],
    ] as const) {
      expect(isApiErrorBody({ code, message: `${code} message` })).toBe(true)
      expect(toApiError({ code, message: `${code} message` }, status)).toMatchObject({ code, status })
    }
    expect(toApiError({ code: "NOT_A_CODE", message: "x" }, 502).code).toBe("UNKNOWN")
  })

  it("has a message for both release codes in every locale", () => {
    for (const locale of [ru, en]) {
      expect(locale.errors.UPSTREAM_FAILED).not.toBe("")
      expect(locale.errors.RELEASE_DISABLED).not.toBe("")
    }
  })
})
