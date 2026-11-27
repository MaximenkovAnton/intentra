import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { i18n } from "../i18n"
import { ThemeProvider } from "../theme/ThemeProvider"
import { ThemeToggle } from "./ThemeToggle"

describe("ThemeToggle", () => {
  it("applies the dark theme and persists the choice", async () => {
    await i18n.changeLanguage("ru")
    const user = userEvent.setup()
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    )

    expect(document.documentElement.dataset.theme).toBe("light")
    await user.click(screen.getByRole("button", { name: "Переключить тему" }))
    expect(document.documentElement.dataset.theme).toBe("dark")
    expect(window.localStorage.getItem("intentra.theme")).toBe("dark")
  })
})
