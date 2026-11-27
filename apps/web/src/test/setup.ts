import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach, vi } from "vitest"
import { installFetchRouter, resetApiMock } from "./apiMock"

class RelativeRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === "string" && input.startsWith("/")) {
      super(new URL(input, window.location.origin), init)
      return
    }
    super(input, init)
  }
}

vi.stubGlobal("Request", RelativeRequest)
vi.stubGlobal("scrollTo", vi.fn())
installFetchRouter()

afterEach(() => {
  cleanup()
  resetApiMock()
  window.localStorage.clear()
  document.documentElement.removeAttribute("data-theme")
})
