export type ProjectRole = "owner" | "editor" | "viewer"

export type ProjectAccess = ProjectRole | "admin"

const ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
}

export const canEdit = (access: ProjectAccess | null): boolean =>
  access !== null && (access === "admin" || ROLE_RANK[access] >= ROLE_RANK.editor)

export const canManage = (access: ProjectAccess | null): boolean =>
  access !== null && (access === "admin" || ROLE_RANK[access] >= ROLE_RANK.owner)

export const isAdmin = (access: ProjectAccess | null): boolean => access === "admin"

export const manageRunner = (
  access: ProjectAccess | null,
  runnerOwnerId: string,
  userId: string | undefined,
): boolean => isAdmin(access) || (userId !== undefined && runnerOwnerId === userId)
