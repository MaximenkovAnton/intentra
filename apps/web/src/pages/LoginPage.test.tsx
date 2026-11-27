import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { i18n } from "../i18n"
import { renderWithProviders } from "../test/render"
import { LoginPage } from "./LoginPage"

describe("LoginPage", () => {
  it("renders the Russian sign-in call to action and links to the OIDC endpoint", async () => {
    await i18n.changeLanguage("ru")
    const { container } = renderWithProviders(<LoginPage />)

    expect(screen.getByRole("heading", { name: "Вход в Intentra" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Войти через Pocket ID" })).toHaveAttribute(
      "href",
      "/api/auth/login",
    )
    expect(container.querySelector('input[type="password"]')).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByText(/^Пароль не запрашивается/)).toBeInTheDocument()
    expect(screen.getByText(/^Аутентификация выполняется/)).toBeInTheDocument()
  })

  it("renders the English sign-in call to action", async () => {
    await i18n.changeLanguage("en")
    renderWithProviders(<LoginPage />)

    expect(screen.getByRole("heading", { name: "Sign in to Intentra" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Sign in with Pocket ID" })).toHaveAttribute(
      "href",
      "/api/auth/login",
    )
    expect(screen.getByText(/^No password is requested/)).toBeInTheDocument()
    expect(document.documentElement.lang).toBe("en")
  })

  it("switches the language through the switcher and persists the choice", async () => {
    await i18n.changeLanguage("ru")
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />)

    await user.selectOptions(screen.getByLabelText("Язык интерфейса"), "en")

    expect(await screen.findByRole("heading", { name: "Sign in to Intentra" })).toBeInTheDocument()
    expect(document.documentElement.lang).toBe("en")
    expect(window.localStorage.getItem("intentra.language")).toBe("en")
  })
})
