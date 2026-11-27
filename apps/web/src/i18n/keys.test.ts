import { describe, expect, it } from "vitest"
import { en } from "./en"
import { ru } from "./ru"

const flatten = (value: unknown, prefix = ""): Array<[string, string]> => {
  if (typeof value === "string") return [[prefix, value]]
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, nested]) =>
    flatten(nested, prefix === "" ? key : `${prefix}.${key}`),
  )
}

const keys = (resource: unknown): string[] => flatten(resource).map(([key]) => key).sort()

describe("i18n resources", () => {
  it("has every key in both locales", () => {
    expect(keys(en)).toEqual(keys(ru))
  })

  it("has no empty strings in either locale", () => {
    const empty = [...flatten(en), ...flatten(ru)].filter(([, value]) => value.trim() === "")
    expect(empty).toEqual([])
  })
})
