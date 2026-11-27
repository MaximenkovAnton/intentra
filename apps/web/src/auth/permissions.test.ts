import { describe, expect, it } from "vitest"
import { canEdit, canManage, isAdmin, manageRunner } from "./permissions"
import type { ProjectAccess } from "./permissions"

describe("role permissions", () => {
  const editCases: Array<[ProjectAccess | null, boolean]> = [
    [null, false],
    ["viewer", false],
    ["editor", true],
    ["owner", true],
    ["admin", true],
  ]

  it.each(editCases)("canEdit(%s) is %s", (access, expected) => {
    expect(canEdit(access)).toBe(expected)
  })

  const manageCases: Array<[ProjectAccess | null, boolean]> = [
    [null, false],
    ["viewer", false],
    ["editor", false],
    ["owner", true],
    ["admin", true],
  ]

  it.each(manageCases)("canManage(%s) is %s", (access, expected) => {
    expect(canManage(access)).toBe(expected)
  })

  it("isAdmin only accepts the admin access level", () => {
    expect(isAdmin("admin")).toBe(true)
    expect(isAdmin("owner")).toBe(false)
    expect(isAdmin(null)).toBe(false)
  })

  it("manageRunner allows the owner of the runner and any admin", () => {
    expect(manageRunner("viewer", "runner-1", "user-1")).toBe(false)
    expect(manageRunner("owner", "runner-1", "user-2")).toBe(false)
    expect(manageRunner("owner", "user-1", "user-1")).toBe(true)
    expect(manageRunner("admin", "runner-1", "user-2")).toBe(true)
    expect(manageRunner(null, "runner-1", undefined)).toBe(false)
  })
})
