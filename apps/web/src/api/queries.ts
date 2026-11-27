import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, expectNoContent, unwrapResponse } from "./client"
import type {
  CreateIntentInput,
  CreateProjectInput,
  IntentAnswerResult,
  IntentDetail,
  IntentList,
  IntentMessage,
  JobList,
  AnswerIntentInput,
  PostIntentMessageInput,
  ReworkIntentInput,
  UpdatePolicyInput,
  UpdateProjectInput,
} from "./types"
import type { ProjectAccess } from "../auth/permissions"

export const queryKeys = {
  me: ["me"] as const,
  projects: ["projects"] as const,
  project: (key: string) => ["projects", "detail", key] as const,
  members: (key: string) => ["projects", "members", key] as const,
  runners: ["runners"] as const,
  intents: ["intents"] as const,
  intentList: (key: string) => ["intents", "list", key] as const,
  intent: (id: string) => ["intents", "detail", id] as const,
  messages: (id: string) => ["intents", "messages", id] as const,
  spec: (id: string) => ["intents", "spec", id] as const,
  findings: (id: string) => ["intents", "findings", id] as const,
  plan: (id: string) => ["intents", "plan", id] as const,
  jobs: (id: string) => ["intents", "jobs", id] as const,
  evidence: (id: string) => ["intents", "evidence", id] as const,
  memorySearch: (key: string, q: string) => ["memory", "search", key, q] as const,
}

export const meQueryOptions = queryOptions({
  queryKey: queryKeys.me,
  queryFn: () => unwrapResponse(api.GET("/api/auth/me")),
  retry: false,
  staleTime: 60_000,
})

export const useMe = () => useQuery(meQueryOptions)

export const useProjects = () =>
  useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => unwrapResponse(api.GET("/api/projects")),
  })

export const useProject = (key: string) =>
  useQuery({
    queryKey: queryKeys.project(key),
    queryFn: () => unwrapResponse(api.GET("/api/projects/{key}", { params: { path: { key } } })),
  })

export const useMembers = (key: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.members(key),
    queryFn: () =>
      unwrapResponse(api.GET("/api/projects/{key}/members", { params: { path: { key } } })),
    enabled: enabled && key.length > 0,
  })

export const useRunners = () =>
  useQuery({
    queryKey: queryKeys.runners,
    queryFn: () => unwrapResponse(api.GET("/api/runners")),
  })

export const useMyProjectRole = (projectKey: string | undefined): ProjectAccess | null => {
  const me = useMe()
  const members = useMembers(projectKey ?? "", projectKey !== undefined)
  if (me.data?.isAdmin === true) return "admin"
  if (me.data === undefined || members.data === undefined) return null
  return members.data.items.find((member) => member.userId === me.data?.id)?.role ?? null
}

export const useIntentRole = (projectId: string | undefined) => {
  const projects = useProjects()
  const projectKey =
    projectId === undefined
      ? undefined
      : projects.data?.items.find((project) => project.id === projectId)?.key
  const role = useMyProjectRole(projectKey)
  return { projectKey: projectKey ?? null, role }
}

export const useIntents = (projectKey: string) =>
  useQuery({
    queryKey: queryKeys.intentList(projectKey),
    queryFn: () =>
      unwrapResponse(
        api.GET("/api/projects/{key}/intents", { params: { path: { key: projectKey } } }),
      ),
  })

export const useIntent = (intentId: string) =>
  useQuery({
    queryKey: queryKeys.intent(intentId),
    queryFn: () =>
      unwrapResponse(
        api.GET("/api/intents/{id}", { params: { path: { id: intentId } } }),
      ),
  })

export const useSpec = (intentId: string) =>
  useQuery({
    queryKey: queryKeys.spec(intentId),
    queryFn: () =>
      unwrapResponse(api.GET("/api/intents/{id}/spec", { params: { path: { id: intentId } } })),
  })

export const useFindings = (intentId: string) =>
  useQuery({
    queryKey: queryKeys.findings(intentId),
    queryFn: () =>
      unwrapResponse(
        api.GET("/api/intents/{id}/findings", { params: { path: { id: intentId } } }),
      ),
  })

export const usePlan = (intentId: string) =>
  useQuery({
    queryKey: queryKeys.plan(intentId),
    queryFn: () =>
      unwrapResponse(api.GET("/api/intents/{id}/plan", { params: { path: { id: intentId } } })),
  })

export const useJobs = (intentId: string) =>
  useQuery({
    queryKey: queryKeys.jobs(intentId),
    queryFn: () =>
      unwrapResponse(api.GET("/api/intents/{id}/jobs", { params: { path: { id: intentId } } })),
  })

export const useEvidence = (intentId: string) =>
  useQuery({
    queryKey: queryKeys.evidence(intentId),
    queryFn: () =>
      unwrapResponse(
        api.GET("/api/intents/{id}/evidence", { params: { path: { id: intentId } } }),
      ),
  })

export const useIntentMessages = (intentId: string) =>
  useQuery({
    queryKey: queryKeys.messages(intentId),
    queryFn: () => Promise.resolve<IntentMessage[]>([]),
    staleTime: Number.POSITIVE_INFINITY,
  })

export const useCreateProject = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateProjectInput) => unwrapResponse(api.POST("/api/projects", { body: input })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects })
    },
  })
}

export const useUpdateProject = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, input }: { key: string; input: UpdateProjectInput }) =>
      unwrapResponse(api.PATCH("/api/projects/{key}", { params: { path: { key } }, body: input })),
    onSuccess: (project, variables) => {
      queryClient.setQueryData(queryKeys.project(variables.key), project)
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects })
    },
  })
}

export const useDeleteProject = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (key: string) =>
      expectNoContent(api.DELETE("/api/projects/{key}", { params: { path: { key } } })),
    onSuccess: (_data, key) => {
      queryClient.removeQueries({ queryKey: queryKeys.project(key) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects })
    },
  })
}

export const useAddMember = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, input }: { key: string; input: { email: string; role: "owner" | "editor" | "viewer" } }) =>
      unwrapResponse(api.POST("/api/projects/{key}/members", { params: { path: { key } }, body: input })),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(variables.key) })
    },
  })
}

export const useRemoveMember = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, userId }: { key: string; userId: string }) =>
      expectNoContent(
        api.DELETE("/api/projects/{key}/members/{userId}", { params: { path: { key, userId } } }),
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(variables.key) })
    },
  })
}

export const useCreateIntent = (projectKey: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateIntentInput) =>
      unwrapResponse(
        api.POST("/api/projects/{key}/intents", {
          params: { path: { key: projectKey } },
          body: input,
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.intents })
    },
  })
}

export const usePostMessage = (intentId: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: PostIntentMessageInput) =>
      unwrapResponse(
        api.POST("/api/intents/{id}/messages", {
          params: { path: { id: intentId } },
          body: input,
        }),
      ),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.messages(intentId) })
      const previous = queryClient.getQueryData<IntentMessage[]>(queryKeys.messages(intentId)) ?? []
      const optimisticId = crypto.randomUUID()
      const optimistic: IntentMessage = {
        id: optimisticId,
        intentId,
        role: "user",
        body: input.body,
        createdAt: new Date().toISOString(),
      }
      queryClient.setQueryData<IntentMessage[]>(queryKeys.messages(intentId), [
        ...previous,
        optimistic,
      ])
      return { previous, optimisticId }
    },
    onSuccess: (message, _input, context) => {
      queryClient.setQueryData<IntentMessage[]>(queryKeys.messages(intentId), (current = []) =>
        current.map((item) => (item.id === context.optimisticId ? message : item)),
      )
    },
    onError: (_error, _input, context) => {
      queryClient.setQueryData<IntentMessage[]>(
        queryKeys.messages(intentId),
        context?.previous ?? [],
      )
    },
  })
}

export const useAnswerEscalation = (intentId: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: AnswerIntentInput) =>
      unwrapResponse(
        api.POST("/api/intents/{id}/answer", {
          params: { path: { id: intentId } },
          body: input,
        }),
      ),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.intent(intentId) })
      const previous = queryClient.getQueryData<IntentDetail>(queryKeys.intent(intentId))
      if (previous !== undefined) {
        queryClient.setQueryData<IntentDetail>(queryKeys.intent(intentId), {
          ...previous,
          openEscalations: previous.openEscalations.filter(
            (escalation) => escalation.id !== input.escalationId,
          ),
        })
      }
      return { previous }
    },
    onError: (_error, _input, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(queryKeys.intent(intentId), context.previous)
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.intents })
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.intent(intentId) })
    },
  })
}

export const useAcceptIntent = (intentId: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      unwrapResponse(api.POST("/api/intents/{id}/accept", { params: { path: { id: intentId } } })),
    onSuccess: (intent) => {
      queryClient.setQueryData<IntentDetail>(queryKeys.intent(intentId), (current) =>
        current === undefined ? current : { ...current, intent },
      )
      void queryClient.invalidateQueries({ queryKey: queryKeys.intents })
    },
  })
}

export const useReworkIntent = (intentId: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ReworkIntentInput) =>
      unwrapResponse(
        api.POST("/api/intents/{id}/rework", {
          params: { path: { id: intentId } },
          body: input,
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.intents })
    },
  })
}

export const useCancelIntent = (intentId: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      unwrapResponse(api.POST("/api/intents/{id}/cancel", { params: { path: { id: intentId } } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.intents })
    },
  })
}

export const useRevokeRunner = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (runnerId: string) =>
      expectNoContent(api.DELETE("/api/runners/{id}", { params: { path: { id: runnerId } } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.runners })
    },
  })
}

export const useRotateRunnerToken = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (runnerId: string) =>
      unwrapResponse(
        api.POST("/api/runners/{id}/rotate-token", { params: { path: { id: runnerId } } }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.runners })
    },
  })
}

export const useUpdateRunnerPolicy = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ runnerId, input }: { runnerId: string; input: UpdatePolicyInput }) =>
      expectNoContent(
        api.PUT("/api/runners/{id}/update-policy", {
          params: { path: { id: runnerId } },
          body: input,
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.runners })
    },
  })
}

export const useCreateRegistrationToken = (projectKey: string) =>
  useMutation({
    mutationFn: () =>
      unwrapResponse(
        api.POST("/api/projects/{key}/runners/registration-token", {
          params: { path: { key: projectKey } },
        }),
      ),
  })

export const useMemorySearch = (projectKey: string, q: string) =>
  useQuery({
    queryKey: queryKeys.memorySearch(projectKey, q),
    queryFn: () =>
      unwrapResponse(
        api.GET("/api/projects/{key}/memory/search", {
          params: { path: { key: projectKey }, query: { q } },
        }),
      ),
    enabled: q.length > 0,
  })

export const useLogout = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => unwrapResponse(api.POST("/api/auth/logout")),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: queryKeys.me })
    },
  })
}

export type { IntentAnswerResult, IntentList, JobList }
