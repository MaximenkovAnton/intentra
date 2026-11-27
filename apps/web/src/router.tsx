import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router"
import { AuthenticatedLayout } from "./components/AuthenticatedLayout"
import { AuthErrorPage } from "./pages/AuthErrorPage"
import { IntentShellPage } from "./pages/IntentShellPage"
import { IntentBuildTab } from "./pages/IntentBuildTab"
import { IntentCriticTab } from "./pages/IntentCriticTab"
import { IntentEvidenceTab } from "./pages/IntentEvidenceTab"
import { IntentMemoryTab } from "./pages/IntentMemoryTab"
import { IntentOfficeTab } from "./pages/IntentOfficeTab"
import { IntentPlanTab } from "./pages/IntentPlanTab"
import { IntentSpecTab } from "./pages/IntentSpecTab"
import { ProjectIntentsPage } from "./pages/ProjectIntentsPage"
import { ProjectMembersPage } from "./pages/ProjectMembersPage"
import { ProjectMemoryPage } from "./pages/ProjectMemoryPage"
import { ProjectOverviewPage } from "./pages/ProjectOverviewPage"
import { ProjectRunnersPage } from "./pages/ProjectRunnersPage"
import { ProjectSettingsPage } from "./pages/ProjectSettingsPage"
import { RunnersPage } from "./pages/RunnersPage"
import { SettingsPage } from "./pages/SettingsPage"
import { LoginPage } from "./pages/LoginPage"
import { MemoryPage } from "./pages/MemoryPage"
import { NotFoundPage } from "./pages/NotFoundPage"
import { ProjectShellPage } from "./pages/ProjectShellPage"
import { ProjectsPage } from "./pages/ProjectsPage"


const RootLayout = () => <Outlet />

const rootRoute = createRootRoute({ component: RootLayout })

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
})

type AuthErrorSearch = {
  error?: string
}

const authErrorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/error",
  validateSearch: (search: Record<string, unknown>): AuthErrorSearch => ({
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: AuthErrorRouteComponent,
})

function AuthErrorRouteComponent() {
  const search = authErrorRoute.useSearch()
  return <AuthErrorPage errorCode={search.error} />
}

const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authenticated",
  component: AuthenticatedLayout,
})

const projectsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/",
  component: ProjectsPage,
})

const projectsAliasRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/projects",
  component: ProjectsPage,
})

const projectRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/projects/$key",
  component: ProjectRouteComponent,
})

function ProjectRouteComponent() {
  const { key } = projectRoute.useParams()
  return <ProjectShellPage projectKey={key} />
}

const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  component: ProjectIndexRouteComponent,
})

function ProjectIndexRouteComponent() {
  const { key } = projectRoute.useParams()
  return <ProjectOverviewPage projectKey={key} />
}

const projectMembersRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "members",
  component: ProjectMembersRouteComponent,
})

function ProjectMembersRouteComponent() {
  const { key } = projectRoute.useParams()
  return <ProjectMembersPage projectKey={key} />
}

const projectSettingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "settings",
  component: ProjectSettingsRouteComponent,
})

function ProjectSettingsRouteComponent() {
  const { key } = projectRoute.useParams()
  return <ProjectSettingsPage projectKey={key} />
}

const projectRunnersRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "runners",
  component: ProjectRunnersRouteComponent,
})

function ProjectRunnersRouteComponent() {
  const { key } = projectRoute.useParams()
  return <ProjectRunnersPage projectKey={key} />
}

const projectIntentsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "intents",
  component: ProjectIntentsRouteComponent,
})

function ProjectIntentsRouteComponent() {
  const { key } = projectRoute.useParams()
  return <ProjectIntentsPage projectKey={key} />
}

const projectMemoryRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "memory",
  component: ProjectMemoryRouteComponent,
})

function ProjectMemoryRouteComponent() {
  const { key } = projectRoute.useParams()
  return <ProjectMemoryPage projectKey={key} />
}

const intentRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/intents/$id",
  component: IntentRouteComponent,
})

function IntentRouteComponent() {
  const { id } = intentRoute.useParams()
  return <IntentShellPage intentId={id} />
}

const intentIndexRoute = createRoute({
  getParentRoute: () => intentRoute,
  path: "/",
  component: IntentIndexRouteComponent,
})

function IntentIndexRouteComponent() {
  const { id } = intentRoute.useParams()
  return <IntentOfficeTab intentId={id} />
}

const intentSpecRoute = createRoute({
  getParentRoute: () => intentRoute,
  path: "spec",
  component: IntentSpecRouteComponent,
})

function IntentSpecRouteComponent() {
  const { id } = intentRoute.useParams()
  return <IntentSpecTab intentId={id} />
}

const intentCriticRoute = createRoute({
  getParentRoute: () => intentRoute,
  path: "critic",
  component: IntentCriticRouteComponent,
})

function IntentCriticRouteComponent() {
  const { id } = intentRoute.useParams()
  return <IntentCriticTab intentId={id} />
}

const intentPlanRoute = createRoute({
  getParentRoute: () => intentRoute,
  path: "plan",
  component: IntentPlanRouteComponent,
})

function IntentPlanRouteComponent() {
  const { id } = intentRoute.useParams()
  return <IntentPlanTab intentId={id} />
}

const intentBuildRoute = createRoute({
  getParentRoute: () => intentRoute,
  path: "build",
  component: IntentBuildRouteComponent,
})

function IntentBuildRouteComponent() {
  const { id } = intentRoute.useParams()
  return <IntentBuildTab intentId={id} />
}

const intentMemoryRoute = createRoute({
  getParentRoute: () => intentRoute,
  path: "memory",
  component: IntentMemoryTab,
})

const intentEvidenceRoute = createRoute({
  getParentRoute: () => intentRoute,
  path: "evidence",
  component: IntentEvidenceRouteComponent,
})

function IntentEvidenceRouteComponent() {
  const { id } = intentRoute.useParams()
  return <IntentEvidenceTab intentId={id} />
}

const runnersRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/runners",
  component: RunnersPage,
})

const memoryRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/memory",
  component: MemoryPage,
})

const settingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings",
  component: SettingsPage,
})

const notFoundRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/$",
  component: NotFoundPage,
})

export const routeTree = rootRoute.addChildren([
  loginRoute,
  authErrorRoute,
  authenticatedRoute.addChildren([
    projectsRoute,
    projectsAliasRoute,
    projectRoute.addChildren([
      projectIndexRoute,
      projectMembersRoute,
      projectSettingsRoute,
      projectRunnersRoute,
      projectIntentsRoute,
      projectMemoryRoute,
    ]),
    intentRoute.addChildren([
      intentIndexRoute,
      intentSpecRoute,
      intentCriticRoute,
      intentPlanRoute,
      intentBuildRoute,
      intentMemoryRoute,
      intentEvidenceRoute,
    ]),
    runnersRoute,
    memoryRoute,
    settingsRoute,
    notFoundRoute,
  ]),
])

export const router = createRouter({ routeTree, defaultPreload: "intent" })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
