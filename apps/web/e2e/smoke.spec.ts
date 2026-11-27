import { expect, test } from "@playwright/test"

const user = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "ada@example.com",
  name: "Ada Lovelace",
  avatarUrl: null,
  locale: "ru",
  isAdmin: false,
}

const project = {
  id: "00000000-0000-4000-8000-000000000001",
  key: "alpha",
  name: "Alpha",
  description: null,
  repoUrl: null,
  defaultBranch: "main",
  createdBy: "00000000-0000-4000-8000-000000000002",
  createdAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
}

test("signs in with the mocked provider and switches the interface language", async ({ page }) => {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(user),
    }),
  )
  await page.route("**/api/projects", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [project], nextCursor: null }),
      })
    }
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(project),
    })
  })
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({
      status: 302,
      headers: { location: "/" },
    }),
  )

  await page.goto("/login")
  await expect(page.getByRole("heading", { name: "Вход в Intentra" })).toBeVisible()
  await page.getByRole("link", { name: "Войти через Pocket ID" }).click()
  await expect(page.getByRole("heading", { name: "Проекты" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible()

  await page.getByLabel("Язык интерфейса").selectOption("en")
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible()

  await page.route("**/api/auth/logout", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ redirectUrl: "/login?logged-out=1" }),
    }),
  )
  await page.getByRole("button", { name: "Sign out" }).click()
  await expect(page).toHaveURL(/logged-out=1/)
})
