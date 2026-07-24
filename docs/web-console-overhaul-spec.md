# 정비 콘솔 App Shell + Routing Overhaul Spec

**Version:** 1.0  
**Domain:** Field-service maintenance console (B2B SaaS, Korean UI)  
**Benchmark apps:** Linear, Stripe Dashboard, Vercel, Datadog, Retool  
**Stack:** React 19 + Vite 8 + Tailwind v4 + shadcn-style primitives + `lucide-react` 0.555 + `openapi-fetch`

---

## 0. Current State Summary

`src/App.tsx` (375 lines) is a monolith that owns:

- All session state + auth mutations (login/logout/refresh)
- All data fetching (work orders, approvals, KPI, equipment lookup)
- All write mutations (createWorkOrder, assignWorkOrder, approveWorkOrder, rejectWorkOrder)
- Route-detection via `window.location.pathname === "/wallboard"` (no router)
- A single page that stacks every feature vertically

The feature components under `src/features/` are clean and well-tested — they are NOT rewritten. This spec decomposes only the shell, routing, and state ownership.

---

## 1. Dependencies to Install

### Router
Install `react-router` v8 (component routing is appropriate for this console):

```bash
npm install react-router@^8.3.0
```

No other new runtime dependencies are required. `lucide-react` is already installed at `0.555.0`. `@fontsource/pretendard` is already installed. All shadcn-style primitives (`button`, `card`, `input`, `textarea`, `badge`) already exist in `src/components/ui/`.

### Router version note
React Router v8 retains the declarative `<BrowserRouter>` + `<Routes>` API from `react-router`. This console intentionally stays in declarative mode; the DOM-specific `RouterProvider` data-router surface from `react-router/dom` is outside this migration's scope.

---

## 2. Information Architecture

### 2.1 Domain Mapping

| Korean Domain | English Key | Current Component | New Route |
|---|---|---|---|
| 배차 (Dispatch) | dispatch | `DispatchBoard` + `WorkOrderList` | `/dispatch` |
| 접수 (Intake) | intake | `IntakeForm` | `/intake` |
| 승인 (Approvals) | approvals | `ApprovalQueue` | `/approvals` |
| KPI 대시보드 | kpi | `KpiDashboard` | `/kpi` |
| 메신저 | messenger | `MessengerPanel` | `/messenger` |
| 장비 (Equipment) | equipment | _(inline in App.tsx — equipment lookup state)_ | `/equipment` |
| 위치 동의 (Location Consent) | location | `LocationConsentPanel` | `/settings/location` |
| 월보드 (Wallboard) | wallboard | `WallBoard` | `/wallboard` |
| 로그인 | auth | `PasskeyLoginPage` | `/login` |

### 2.2 Full Route Table

```
/                       → redirect to /dispatch (or /login if unauthenticated)
/login                  → LoginPage  [shell-less, full-screen]
/wallboard              → WallBoardPage  [shell-less, full-screen kiosk]

/dispatch               → DispatchPage  [default landing, all roles]
/intake                 → IntakePage  [admin, super-admin, technician]
/approvals              → ApprovalsPage  [admin, super-admin]
/kpi                    → KpiPage  [executive, admin, super-admin]
/messenger              → MessengerPage  [all roles]
/equipment              → EquipmentPage  [all roles — equipment lookup]
/settings/location      → LocationSettingsPage  [all roles — self-service]
/settings               → redirect to /settings/location
```

**Redirect rules:**

| Condition | Source | Destination |
|---|---|---|
| No session | any protected route | `/login?next=<original-path>` |
| Session exists | `/login` | `/dispatch` (or `?next=` param) |
| Root | `/` | `/dispatch` |
| Settings index | `/settings` | `/settings/location` |

**Role-gating (advisory — enforce on backend; client shows/hides nav items):**

| Route | Visible to roles |
|---|---|
| `/kpi` | `executive`, `admin`, `super-admin` |
| `/approvals` | `admin`, `super-admin` |
| `/intake` | `admin`, `super-admin`, `technician` |
| `/dispatch` | all |
| `/messenger` | all |
| `/equipment` | all |
| `/settings/location` | all (own record only) |
| `/wallboard` | unauthenticated OK (kiosk mode) |

---

## 3. AuthContext

### 3.1 Shape

```typescript
// src/context/auth.tsx

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  /** Decoded from JWT or returned by backend — add to API response if not present */
  role?: "technician" | "admin" | "executive" | "super-admin";
  user_id?: string;
}

export interface AuthContextValue {
  session: AuthSession | undefined;
  isLoading: boolean;             // true during initial hydration from storage
  login: (userId: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  api: ConsoleApiClient;          // re-created when access_token changes
}

export const AuthContext = React.createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
```

### 3.2 AuthProvider Implementation

```typescript
// src/context/auth.tsx (continued)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AuthSession | undefined>(
    () => loadSessionFromStorage()   // see §3.3
  );
  const [isLoading, setIsLoading] = useState(false);

  // api client is memoised on access_token so all consumers get the same instance
  const api = useMemo(
    () => createConsoleApiClient(session?.access_token),
    [session?.access_token],
  );

  async function login(userId: string) {
    const ceremony = await startPasskeyLogin(api, userId.trim());
    const tokens = await finishPasskeyLogin(api, ceremony);
    const next: AuthSession = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    };
    setSession(next);
    saveSessionToStorage(next);
  }

  async function logout() {
    if (session) {
      await logoutWebAuthn(api, session.refresh_token).catch(() => {});
    }
    setSession(undefined);
    clearSessionFromStorage();
  }

  async function refresh() {
    if (!session) return;
    const tokens = await refreshToken(api, session.refresh_token);
    const next: AuthSession = {
      ...session,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    };
    setSession(next);
    saveSessionToStorage(next);
  }

  return (
    <AuthContext.Provider value={{ session, isLoading, login, logout, refresh, api }}>
      {children}
    </AuthContext.Provider>
  );
}
```

### 3.3 Session Persistence

Use `sessionStorage` (not `localStorage`) to avoid stale tokens surviving a browser restart. Key: `"maintenance_console_session"`. Store only `{ access_token, refresh_token }` — no PII.

```typescript
const STORAGE_KEY = "maintenance_console_session";

function loadSessionFromStorage(): AuthSession | undefined {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    return JSON.parse(raw) as AuthSession;
  } catch {
    return undefined;
  }
}

function saveSessionToStorage(session: AuthSession) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function clearSessionFromStorage() {
  sessionStorage.removeItem(STORAGE_KEY);
}
```

### 3.4 Protected Route Guard

```typescript
// src/components/ProtectedRoute.tsx

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { session, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <PageSpinner />;  // see §6.3
  }

  if (!session) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  }

  return <>{children}</>;
}
```

### 3.5 API Token Plumbing

The `api` instance is consumed via `useAuth().api` in every page. No prop-drilling. `MessengerPanel` additionally needs `accessToken` (string) and `apiBaseUrl` (string) — pass `session.access_token` and `import.meta.env.VITE_API_BASE_URL ?? window.location.origin` from the page component.

---

## 4. App Shell

### 4.1 Layout Regions

```
┌──────────────────────────────────────────────────────┐
│  TOPBAR  h-14 (56px), sticky, z-30                   │
│  [hamburger|logo]  [breadcrumb/title]  [user menu]   │
├─────────┬────────────────────────────────────────────┤
│         │                                            │
│ SIDEBAR │  MAIN CONTENT                              │
│  w-60   │  flex-1, overflow-y-auto                   │
│ (w-16   │  px-4 sm:px-6 lg:px-8  py-6               │
│ collapsed│                                            │
│ on <lg) │                                            │
│         │                                            │
└─────────┴────────────────────────────────────────────┘
```

**CSS layout (Tailwind v4):**

```
<div class="flex h-screen overflow-hidden bg-slate-50">
  <Sidebar />
  <div class="flex flex-1 flex-col overflow-hidden">
    <Topbar />
    <main class="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
      <Outlet />  {/* react-router outlet */}
    </main>
  </div>
</div>
```

The wallboard and login routes render outside this shell entirely (see §4.4).

### 4.2 Sidebar

**File:** `src/components/shell/Sidebar.tsx`

**Behaviour:**
- Desktop (≥ lg, 1024px): always visible, `w-60` expanded or `w-16` icon-only collapsed. Collapse toggled by a chevron button at the bottom.
- Mobile (< lg): hidden by default; slides in as a fixed overlay when the hamburger in the Topbar is pressed. A semi-transparent backdrop (`bg-slate-950/40`) sits behind it; clicking the backdrop closes it.
- Collapse state: `useState` local to the shell layout component. No URL param needed.

**Structure:**

```tsx
<aside aria-label="메인 내비게이션" class="
  flex flex-col h-full
  bg-white border-r border-slate-200
  transition-all duration-200
  w-60          {/* expanded */}
  lg:w-60       {/* desktop expanded */}
  data-[collapsed]:w-16
">
  {/* Brand */}
  <div class="flex h-14 items-center gap-3 px-4 border-b border-slate-200 shrink-0">
    <WrenchIcon size={20} class="text-slate-950 shrink-0" aria-hidden />
    <span class="font-bold text-slate-950 truncate" hidden={collapsed}>정비 콘솔</span>
  </div>

  {/* Nav groups */}
  <nav class="flex-1 overflow-y-auto py-4 px-2 grid gap-6">
    {NAV_GROUPS.map(group => <NavGroup group={group} collapsed={collapsed} />)}
  </nav>

  {/* Collapse toggle */}
  <div class="border-t border-slate-200 px-2 py-3">
    <button aria-label={collapsed ? "메뉴 펼치기" : "메뉴 접기"}
            class="flex w-full items-center gap-2 rounded-md px-3 py-2
                   text-sm text-slate-600 hover:bg-slate-100">
      {collapsed ? <ChevronsRight size={16}/> : <ChevronsLeft size={16}/>}
      {!collapsed && <span>접기</span>}
    </button>
  </div>
</aside>
```

**Active state:** Use `NavLink` from react-router. Active item: `bg-slate-100 text-slate-950 font-semibold`. Inactive: `text-slate-600 hover:bg-slate-50 hover:text-slate-950`.

**NavItem structure:**

```tsx
<NavLink
  to={item.href}
  className={({ isActive }) =>
    cn(
      "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
      isActive
        ? "bg-slate-100 text-slate-950 font-semibold"
        : "text-slate-600 hover:bg-slate-50 hover:text-slate-950",
    )
  }
>
  <item.Icon size={18} aria-hidden className="shrink-0" />
  {!collapsed && <span className="truncate">{item.label}</span>}
  {!collapsed && item.badge != null && (
    <Badge className="ml-auto">{item.badge}</Badge>
  )}
</NavLink>
```

When collapsed, wrap each `NavLink` in a `title` attribute or Radix `Tooltip` so keyboard/mouse users see the label.

### 4.3 Nav Groups and Items

```typescript
// src/components/shell/nav.ts

import {
  ClipboardList,     // 배차
  FilePlus,          // 접수
  CheckSquare,       // 승인
  BarChart2,         // KPI
  MessageSquare,     // 메신저
  Wrench,            // 장비
  MapPin,            // 위치 동의 (in Settings group)
  Settings,          // Settings group header icon
} from "lucide-react";

export const NAV_GROUPS = [
  {
    key: "operations",
    label: "운영",           // shown as group label when expanded
    items: [
      { key: "dispatch",   href: "/dispatch",  label: "배차",   Icon: ClipboardList },
      { key: "intake",     href: "/intake",    label: "접수",   Icon: FilePlus },
      { key: "approvals",  href: "/approvals", label: "승인",   Icon: CheckSquare },
      { key: "messenger",  href: "/messenger", label: "메신저", Icon: MessageSquare },
    ],
  },
  {
    key: "data",
    label: "데이터",
    items: [
      { key: "kpi",        href: "/kpi",       label: "KPI 대시보드", Icon: BarChart2 },
      { key: "equipment",  href: "/equipment", label: "장비 조회",    Icon: Wrench },
    ],
  },
  {
    key: "settings",
    label: "설정",
    items: [
      { key: "location",   href: "/settings/location", label: "GPS 위치 동의", Icon: MapPin },
    ],
  },
] as const;
```

Role-gating: the shell component reads `session.role` from `useAuth()` and filters `NAV_GROUPS` items before rendering. Example: omit the `kpi` item for `technician` role.

### 4.4 Topbar

**File:** `src/components/shell/Topbar.tsx`

```tsx
<header class="h-14 flex items-center gap-4 px-4 border-b border-slate-200 bg-white shrink-0 z-30 sticky top-0">
  {/* Mobile hamburger */}
  <button
    class="lg:hidden rounded-md p-2 text-slate-600 hover:bg-slate-100"
    aria-label="메뉴 열기"
    onClick={openMobileSidebar}
  >
    <Menu size={20} aria-hidden />
  </button>

  {/* Page title / breadcrumb — injected by each page via context or outlet */}
  <div class="flex-1 min-w-0">
    <PageTitle />   {/* reads from a TitleContext or react-router `handle` */}
  </div>

  {/* Branch context chip — optional, shown when branchId is in scope */}
  <BranchChip />

  {/* User / account menu */}
  <UserMenu />
</header>
```

**Page title injection:** Each page sets its title using a `usePageTitle(title: string)` hook that writes to a `React.Context<string>` or uses the react-router v7 `<meta handle>` mechanism. The Topbar reads this context to render the `<h1>` for the current page (avoids duplicating `<h1>` inside each feature component).

**UserMenu (dropdown):**

```
[Avatar/initials] ▾
  ─────────────────
  사용자: {userId}
  ─────────────────
  토큰 갱신        (→ calls auth.refresh())
  GPS 위치 동의    (→ navigate to /settings/location)
  ─────────────────
  로그아웃         (→ calls auth.logout() then navigate /login)
```

Implement using a `<details>`/`<summary>` or a lightweight Radix `DropdownMenu` if added as a dependency. Since Radix is already a peer dep via `@radix-ui/react-slot`, add `@radix-ui/react-dropdown-menu` for this. Alternatively, build a simple focus-trap div if you want zero new deps.

**BranchChip:** A read-only `<span>` badge showing the current branch name/ID. For now, reads from a `useBranch()` hook that returns a hardcoded default (mirrors `defaultBranchId` in the old `App.tsx`). This becomes dynamic when branch-selection is added.

### 4.5 Shell Layout Component

**File:** `src/components/shell/AppShell.tsx`

```tsx
export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);   // mobile
  const [collapsed, setCollapsed] = useState(false);        // desktop

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-slate-950/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      <Sidebar
        collapsed={collapsed}
        mobileOpen={sidebarOpen}
        onCollapse={() => setCollapsed((c) => !c)}
        onMobileClose={() => setSidebarOpen(false)}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar onOpenMobileSidebar={() => setSidebarOpen(true)} />
        <main
          id="main-content"
          className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8 focus:outline-none"
          tabIndex={-1}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
```

**Skip-to-main link:** Add `<a href="#main-content" class="sr-only focus:not-sr-only ...">본문으로 이동</a>` as the very first child of `<body>` / root `<div>`.

---

## 5. Router Setup (main.tsx + App.tsx replacement)

### 5.1 New main.tsx

```tsx
// src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AuthProvider } from "./context/auth";
import { AppRouter } from "./AppRouter";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <AppRouter />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
```

### 5.2 AppRouter.tsx

```tsx
// src/AppRouter.tsx
import { Routes, Route, Navigate } from "react-router";
import { AppShell } from "./components/shell/AppShell";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { LoginPage } from "./pages/LoginPage";
import { WallBoardPage } from "./pages/WallBoardPage";
import { DispatchPage } from "./pages/DispatchPage";
import { IntakePage } from "./pages/IntakePage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { KpiPage } from "./pages/KpiPage";
import { MessengerPage } from "./pages/MessengerPage";
import { EquipmentPage } from "./pages/EquipmentPage";
import { LocationSettingsPage } from "./pages/LocationSettingsPage";

export function AppRouter() {
  return (
    <Routes>
      {/* Shell-less routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/wallboard" element={<WallBoardPage />} />

      {/* Protected shell routes */}
      <Route
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dispatch" replace />} />
        <Route path="/dispatch" element={<DispatchPage />} />
        <Route path="/intake" element={<IntakePage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/kpi" element={<KpiPage />} />
        <Route path="/messenger" element={<MessengerPage />} />
        <Route path="/equipment" element={<EquipmentPage />} />
        <Route path="/settings" element={<Navigate to="/settings/location" replace />} />
        <Route path="/settings/location" element={<LocationSettingsPage />} />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/dispatch" replace />} />
    </Routes>
  );
}
```

---

## 6. Page Layout Pattern

### 6.1 PageHeader Component

**File:** `src/components/shell/PageHeader.tsx`

Every page starts with a consistent header. The shell renders `<Outlet />` and each page is responsible for its own `PageHeader`:

```tsx
interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;  // CTA buttons top-right
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-bold text-slate-950">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-slate-600">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
```

### 6.2 Standard Loading / Empty / Error States

```tsx
// src/components/states/PageSpinner.tsx
export function PageSpinner() {
  return (
    <div className="flex h-40 items-center justify-center" role="status">
      <span className="text-sm font-medium text-slate-600">{ko.common.loading}</span>
    </div>
  );
}

// src/components/states/PageError.tsx
export function PageError({ onRetry }: { onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4">
      <p className="text-sm font-semibold text-red-700">{ko.common.loadFailed}</p>
      {onRetry && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden /> 다시 시도
        </Button>
      )}
    </div>
  );
}

// src/components/states/PageEmpty.tsx
export function PageEmpty({ message }: { message: string }) {
  return (
    <p className="rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-600">
      {message}
    </p>
  );
}
```

### 6.3 Responsive Behaviour

All pages use the shell's content padding (`px-4 py-6 sm:px-6 lg:px-8`). Individual pages may use `max-w-7xl mx-auto` for very wide layouts (dispatch board). No page imposes its own horizontal padding — the shell provides it.

Breakpoints:
- `< 768px` (md): single column. Sidebar is off-canvas.
- `768px–1023px` (md–lg): sidebar off-canvas, content full-width.
- `≥ 1024px` (lg): persistent sidebar, content fills remaining width.
- `≥ 1280px` (xl): dispatch board switches to 6-column kanban.

---

## 7. Individual Page Specs

### 7.1 LoginPage — `/login`

**File:** `src/pages/LoginPage.tsx`  
**Shell:** None (full-screen)  
**Reuses:** `PasskeyLoginPage` logic extracted into `useAuth().login()`

```
Full viewport: bg-slate-50
Centered card: max-w-sm, bg-white, border, rounded-xl, p-8, shadow-sm

Layout:
  [WrenchIcon 32px]
  [h1: "정비 콘솔" font-bold text-2xl]
  [p: "패스키로 로그인하세요" text-slate-600 text-sm mt-1]
  [gap-6 separator]
  [label + Input: 사용자 ID]
  [Button (full-width): 패스키로 로그인]
  [p role="status" or role="alert": feedback message]
```

**Behaviour:**
- On mount: if `session` already exists in `AuthContext`, immediately `<Navigate to="/dispatch" replace />`.
- `handleLogin` calls `useAuth().login(userId)`.
- On success, react-router `navigate` is called to `/dispatch` (or `?next=` param).
- `?next=` param: after successful login, redirect to `decodeURIComponent(searchParams.get("next") ?? "/dispatch")`. Sanitise: only allow paths starting with `/`, reject `//` and `http` to prevent open-redirect.
- Error: show `ko.auth.loginFailed` with `role="alert"`.
- No sidebar, no topbar, no nav. The login card is the only content.

**Does NOT reuse the `PasskeyLoginPage` component directly** — that component conflates UI + auth logic + session display. Instead:
- Move the auth logic to `AuthContext` (already specified in §3).
- Build a new thin `LoginPage` that calls `useAuth().login()`.
- The old `PasskeyLoginPage` component at `src/features/auth/PasskeyLoginPage.tsx` can remain for now (the tests reference it) but is superseded for routing purposes. Deprecation comment should be added.

### 7.2 DispatchPage — `/dispatch`

**File:** `src/pages/DispatchPage.tsx`  
**Default landing for all authenticated roles.**

**State owned by this page:**
```typescript
const [workOrders, setWorkOrders] = useState<WorkOrderListItem[]>([]);
const [readState, setReadState] = useState<"idle" | "loading" | "error">("loading");
const [writeState, setWriteState] = useState<"idle" | "error">("idle");
const [selectedMechanicId, setSelectedMechanicId] = useState(defaultMechanicId);
const { api } = useAuth();
```

**Data fetching:** `useEffect` on mount (and on manual refresh) → `GET /api/v1/work-orders` with `limit: 100, offset: 0`.

**Mutations:**
- `assignWorkOrder(workOrderId, mechanicId)` → `PUT /api/work-orders/{workOrderId}/assignments` — lifted verbatim from `App.tsx` lines 205–230, but scoped to this page.
- After mutation success: re-fetch work orders.
- On mutation error: set `writeState = "error"`.

**Render:**
```tsx
<>
  <PageHeader
    title={ko.dispatch.title}
    actions={<RefreshButton onClick={load} isLoading={readState === "loading"} />}
  />
  {readState === "error" && <PageError onRetry={load} />}
  {writeState === "error" && (
    <p role="alert" className="mb-4 text-sm font-semibold text-red-700">
      {ko.common.writeFailed}
    </p>
  )}
  <WorkOrderList workOrders={workOrders} isLoading={readState === "loading"} />
  <div className="mt-6">
    <DispatchBoard
      workOrders={workOrders}
      selectedMechanicId={selectedMechanicId}
      isLoading={readState === "loading"}
      onAssignWorkOrder={assignWorkOrder}
    />
  </div>
</>
```

**Components reused:** `src/features/dispatch/WorkOrderList.tsx`, `src/features/dispatch/DispatchBoard.tsx` — no changes to either.

### 7.3 IntakePage — `/intake`

**File:** `src/pages/IntakePage.tsx`

**State owned by this page:**
```typescript
const [managementNo, setManagementNo] = useState("");
const [equipmentSuggestions, setEquipmentSuggestions] = useState<EquipmentLookupResponse[]>([]);
const [equipmentLookupState, setEquipmentLookupState] = useState<EquipmentLookupState>({ status: "idle" });
const { api, session } = useAuth();
const branchId = useBranch();  // hook returning defaultBranchId for now
```

**Equipment debounce logic:** Lifted verbatim from `App.tsx` lines 116–163. The `useEffect` on `managementNo` + debounce timer (300ms) + dual `GET /api/v1/equipment` + `GET /api/v1/equipment/lookup` calls move here.

**Render:**
```tsx
<>
  <PageHeader title={ko.intake.title} />
  <div className="max-w-2xl">
    <IntakeForm
      branchId={branchId}
      equipmentLookupState={equipmentLookupState}
      equipmentSuggestions={equipmentSuggestions}
      onManagementNoChange={handleManagementNoChange}
      onCreateWorkOrder={createWorkOrder}
      onCreated={() => {/* no-op or show success toast */}}
    />
  </div>
</>
```

**`createWorkOrder` function:** Lifted verbatim from `App.tsx` lines 197–203. Calls `POST /api/work-orders`.

**Components reused:** `src/features/intake/IntakeForm.tsx` — no changes.

### 7.4 ApprovalsPage — `/approvals`

**File:** `src/pages/ApprovalsPage.tsx`

**State owned by this page:**
```typescript
const [approvalWorkOrders, setApprovalWorkOrders] = useState<WorkOrderListItem[]>([]);
const [readState, setReadState] = useState<"idle" | "loading" | "error">("loading");
const [writeState, setWriteState] = useState<"idle" | "error">("idle");
const { api } = useAuth();
```

**Data fetching:** `GET /api/v1/work-orders` with `status: ["REPORT_SUBMITTED", "ADMIN_REVIEW"], limit: 100, offset: 0`.

**Mutations:**
- `approveWorkOrder(workOrderId)` — verbatim from `App.tsx` lines 232–248, `POST /api/work-orders/{workOrderId}/approve`.
- `rejectWorkOrder(workOrderId, memo)` — verbatim from `App.tsx` lines 250–273, `POST /api/v1/work-orders/{workOrderId}/reject`.
- After mutation: re-fetch approvals.

**Render:**
```tsx
<>
  <PageHeader
    title={ko.approvals.title}
    actions={<Badge>{approvalWorkOrders.length}</Badge>}
  />
  {readState === "error" && <PageError onRetry={load} />}
  {writeState === "error" && (
    <p role="alert" className="mb-4 text-sm font-semibold text-red-700">
      {ko.common.writeFailed}
    </p>
  )}
  <ApprovalQueue
    workOrders={approvalWorkOrders}
    onApprove={approveWorkOrder}
    onReject={rejectWorkOrder}
  />
</>
```

**Components reused:** `src/features/approvals/ApprovalQueue.tsx` — no changes.

**Note on existing review fixes:** `ApprovalQueue.tsx` already has `role="alert"` for write errors, `disabled={Boolean(busy)}` busy states, and memo validation. These are preserved untouched.

### 7.5 KpiPage — `/kpi`

**File:** `src/pages/KpiPage.tsx`

**State owned by this page:**
```typescript
const [kpiReport, setKpiReport] = useState<KpiReport>();
const [kpiPeriod, setKpiPeriod] = useState(getDefaultKpiPeriod);
const [readState, setReadState] = useState<"idle" | "loading" | "error">("loading");
const { api } = useAuth();
```

**Data fetching:** `GET /api/v1/kpi` with `period: kpiPeriod`. Re-fetches when `kpiPeriod` changes (debounced inside `KpiDashboard` — already implemented there).

**Render:**
```tsx
<>
  <PageHeader title={ko.kpi.title} />
  {readState === "error" && <PageError onRetry={load} />}
  <KpiDashboard
    isLoading={readState === "loading"}
    period={kpiPeriod}
    report={kpiReport}
    onPeriodChange={handleKpiPeriodChange}
  />
</>
```

**Components reused:** `src/features/kpi/KpiDashboard.tsx` — no changes.

### 7.6 MessengerPage — `/messenger`

**File:** `src/pages/MessengerPage.tsx`

**State:** All state is owned internally by `MessengerPanel`. This page is a thin wrapper.

```typescript
const { api, session } = useAuth();
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? window.location.origin;
```

**Render:**
```tsx
<>
  <PageHeader title={ko.messenger.title} />
  <MessengerPanel
    api={api}
    accessToken={session?.access_token}
    apiBaseUrl={apiBaseUrl}
  />
</>
```

**Components reused:** `src/features/messenger/MessengerPanel.tsx` — no changes.

### 7.7 EquipmentPage — `/equipment`

**File:** `src/pages/EquipmentPage.tsx`

This page exposes the equipment lookup UI as a standalone page. In the monolith, equipment lookup state was entangled with `IntakeForm` via `App.tsx`. Here it becomes self-contained.

**State owned by this page:** Same as `IntakePage` equipment state (§7.3) but without the intake form:
```typescript
const [managementNo, setManagementNo] = useState("");
const [equipmentSuggestions, setEquipmentSuggestions] = useState<EquipmentLookupResponse[]>([]);
const [equipmentLookupState, setEquipmentLookupState] = useState<EquipmentLookupState>({ status: "idle" });
const { api } = useAuth();
```

**Render:**
```tsx
<>
  <PageHeader
    title="장비 조회"
    description="호기 번호로 장비·고객 정보를 조회합니다."
  />
  <div className="max-w-xl">
    {/* Inline the search input + EquipmentLookupPanel display */}
    <div className="grid gap-4">
      <div className="grid gap-2">
        <label htmlFor="equipment-search" className="text-sm font-medium text-slate-700">
          호기
        </label>
        <Input
          id="equipment-search"
          value={managementNo}
          placeholder="#290"
          list="equipment-suggestions-standalone"
          onChange={(e) => handleManagementNoChange(e.currentTarget.value)}
        />
        {equipmentSuggestions.length > 0 && (
          <datalist id="equipment-suggestions-standalone">
            {equipmentSuggestions.map((eq) => (
              <option key={eq.id} value={eq.management_no ?? eq.equipment_no}
                      label={`${eq.model ?? ko.common.unknown} / ${eq.customer.name}`} />
            ))}
          </datalist>
        )}
      </div>
      <EquipmentLookupDisplay state={equipmentLookupState} />
    </div>
  </div>
</>
```

**`EquipmentLookupDisplay`:** Extract the `EquipmentLookupPanel` inner component from `IntakeForm.tsx` into a shared file `src/features/intake/EquipmentLookupPanel.tsx` and export it. Then `IntakeForm.tsx` imports it from there, and `EquipmentPage` also imports it. This is the only refactor needed inside a feature file.

### 7.8 LocationSettingsPage — `/settings/location`

**File:** `src/pages/LocationSettingsPage.tsx`

**State:** All state is internal to `LocationConsentPanel`. This page is a thin wrapper.

```typescript
const { api, session } = useAuth();
const branchId = useBranch();
```

**Render:**
```tsx
<>
  <PageHeader
    title={ko.location.title}
    description={ko.location.subtitle}
  />
  <div className="max-w-xl">
    <LocationConsentPanel
      api={api}
      branchId={branchId}
      session={session}
    />
  </div>
</>
```

**Note:** `LocationConsentPanel` already has the loader, busy states, error `role="alert"`, and export — these are preserved untouched.

**Components reused:** `src/features/location/LocationConsentPanel.tsx` — no changes.

### 7.9 WallBoardPage — `/wallboard`

**File:** `src/pages/WallBoardPage.tsx`  
**Shell:** None (full-screen kiosk)  
**Authentication:** Optional — the wallboard should work unauthenticated (kiosk use case). If the backend requires auth for the KPI/work-order endpoints, provide a dedicated read-only wallboard token via `VITE_WALLBOARD_TOKEN` env var, or accept that the wallboard silently shows empty state when no session exists.

**State owned by this page:**
```typescript
const [workOrders, setWorkOrders] = useState<WorkOrderListItem[]>([]);
const [kpiReport, setKpiReport] = useState<KpiReport>();
const [readState, setReadState] = useState<"idle" | "loading" | "error">("loading");
// Use unauthenticated api or wallboard token api:
const api = useMemo(() => createConsoleApiClient(
  import.meta.env.VITE_WALLBOARD_TOKEN
), []);
```

**Data fetching:** `loadDashboardData` function calling both `GET /api/v1/work-orders` and `GET /api/v1/kpi`. Passed as `onRefresh` to `WallBoard`.

**Render:**
```tsx
<WallBoard
  isLoading={readState === "loading"}
  refreshIntervalMs={getWallboardRefreshIntervalMs()}
  report={kpiReport}
  workOrders={workOrders}
  onRefresh={loadDashboardData}
/>
```

**Components reused:** `src/features/kpi/WallBoard.tsx` — no changes.

---

## 8. Spacing Scale and Design Tokens

The existing design system uses Tailwind v4 utility-first with no custom config beyond font. The following conventions are formalised:

### 8.1 Spacing

| Context | Value |
|---|---|
| Shell content padding (x) | `px-4 sm:px-6 lg:px-8` |
| Shell content padding (y) | `py-6` |
| Page header bottom margin | `mb-6` |
| Card internal padding | `p-4` (existing Card component) |
| Card gap | `gap-4` (existing convention) |
| Section gap (between cards on a page) | `gap-6` |
| Form field gap | `gap-2` |
| Button group gap | `gap-2` |
| Sidebar width expanded | `w-60` (240px) |
| Sidebar width collapsed | `w-16` (64px) |
| Topbar height | `h-14` (56px) |

### 8.2 Color Roles

All colours come from Tailwind v4's default palette with no custom additions. The existing codebase already uses this palette consistently:

| Role | Tailwind token | Hex |
|---|---|---|
| Page background | `slate-50` | `#f8fafc` |
| Card / sidebar / topbar | `white` | `#ffffff` |
| Border default | `slate-200` | `#e2e8f0` |
| Border emphasis | `slate-300` | `#cbd5e1` |
| Text primary | `slate-950` | `#020617` |
| Text secondary | `slate-600` | `#475569` |
| Text muted | `slate-500` | `#64748b` |
| Interactive default | `slate-950` bg | — |
| Interactive hover | `slate-800` bg | — |
| Nav active bg | `slate-100` | `#f1f5f9` |
| Error | `red-700` | `#b91c1c` |
| Success | `emerald-800` | `#065f46` |
| Warning (priority hint) | `amber-*` | — |

### 8.3 Typography

Font: `Pretendard` (already loaded via `@fontsource/pretendard` in `styles.css`). This is the correct choice for a Korean B2B console — professional, highly legible at small sizes, full Korean glyph coverage. Do not change it.

| Usage | Classes |
|---|---|
| Page h1 | `text-xl font-bold text-slate-950` |
| Section h2 (card title) | `text-lg font-semibold text-slate-950` |
| Sub-section h3 | `text-sm font-semibold text-slate-800` |
| Body / label | `text-sm font-medium text-slate-700` |
| Secondary / meta | `text-sm text-slate-600` |
| Micro / timestamp | `text-xs text-slate-500` |
| Metric value (KPI, wallboard) | `text-2xl font-bold` / `text-5xl font-bold` |

### 8.4 Motion

The existing codebase has minimal animation — `transition-colors` on buttons and the thread-selector hover. Additions:

- Sidebar collapse: `transition-all duration-200` on the sidebar `width`.
- Mobile sidebar slide-in: `translate-x-0` / `-translate-x-full` with `transition-transform duration-200`.
- Dropdown (UserMenu): `transition-opacity duration-100` on open/close.
- No page transition animations — this is a dense operational tool, transitions slow down frequent navigation.

---

## 9. File Structure After Overhaul

```
src/
├── AppRouter.tsx                        ← NEW: route table
├── App.tsx                              ← DELETE or keep as re-export shim for tests
├── main.tsx                             ← MODIFY: wrap with BrowserRouter + AuthProvider
│
├── context/
│   └── auth.tsx                         ← NEW: AuthContext + AuthProvider + useAuth
│
├── components/
│   ├── shell/
│   │   ├── AppShell.tsx                 ← NEW: layout with sidebar + topbar + outlet
│   │   ├── Sidebar.tsx                  ← NEW: nav sidebar
│   │   ├── Topbar.tsx                   ← NEW: header bar + user menu
│   │   ├── PageHeader.tsx               ← NEW: reusable page title + actions row
│   │   └── nav.ts                       ← NEW: NAV_GROUPS config
│   ├── states/
│   │   ├── PageSpinner.tsx              ← NEW
│   │   ├── PageError.tsx                ← NEW
│   │   └── PageEmpty.tsx                ← NEW
│   ├── ProtectedRoute.tsx               ← NEW
│   └── ui/                              ← UNCHANGED
│       ├── badge.tsx
│       ├── button.tsx
│       ├── card.tsx
│       ├── input.tsx
│       └── textarea.tsx
│
├── pages/
│   ├── LoginPage.tsx                    ← NEW
│   ├── WallBoardPage.tsx                ← NEW (thin wrapper over WallBoard)
│   ├── DispatchPage.tsx                 ← NEW (owns work-order fetch + assign mutation)
│   ├── IntakePage.tsx                   ← NEW (owns equipment lookup + createWorkOrder)
│   ├── ApprovalsPage.tsx                ← NEW (owns approval fetch + approve/reject)
│   ├── KpiPage.tsx                      ← NEW (owns KPI fetch)
│   ├── MessengerPage.tsx                ← NEW (thin wrapper over MessengerPanel)
│   ├── EquipmentPage.tsx                ← NEW (standalone equipment search)
│   └── LocationSettingsPage.tsx         ← NEW (thin wrapper over LocationConsentPanel)
│
├── features/                            ← UNCHANGED (all components kept as-is)
│   ├── auth/
│   │   └── PasskeyLoginPage.tsx         ← KEEP (has passing tests); add deprecation comment
│   ├── approvals/ApprovalQueue.tsx
│   ├── dispatch/DispatchBoard.tsx
│   ├── dispatch/WorkOrderList.tsx
│   ├── intake/
│   │   ├── IntakeForm.tsx
│   │   └── EquipmentLookupPanel.tsx     ← NEW: extracted from IntakeForm for reuse
│   ├── kpi/KpiDashboard.tsx
│   ├── kpi/WallBoard.tsx
│   ├── kpi/kpi-format.ts
│   ├── location/LocationConsentPanel.tsx
│   └── messenger/MessengerPanel.tsx
│
├── api/
│   ├── client.ts                        ← UNCHANGED
│   └── types.ts                         ← UNCHANGED
│
├── auth/
│   └── webauthn.ts                      ← UNCHANGED
│
└── i18n/
    └── ko.ts                            ← ADD nav group labels if desired
```

---

## 10. Preservation Checklist (Do Not Regress)

The following review fixes must survive the decomposition:

| Fix | Location | Preserved by |
|---|---|---|
| Write error `role="alert"` surfacing | `ApprovalQueue.tsx` lines 95–98 | Component untouched; page passes `onApprove`/`onReject` callbacks |
| Busy/disabled states on approve/reject buttons | `ApprovalQueue.tsx` lines 121–146 | Component untouched |
| Debounced autocomplete (300ms) | `App.tsx` lines 150–158 | Logic moved verbatim to `IntakePage.tsx` |
| Consent loader `role="status"` | `LocationConsentPanel.tsx` line 153 | Component untouched |
| KPI period debounce (400ms) | `KpiDashboard.tsx` lines 58–69 | Component untouched |
| ARIA labels on approval buttons | `ApprovalQueue.tsx` lines 127, 137 | Component untouched |
| `aria-invalid` + `aria-describedby` on form inputs | `IntakeForm.tsx`, `ApprovalQueue.tsx` | Components untouched |

---

## 11. Implementation Order (Recommended)

1. **Install React Router** — `npm install react-router@^8.3.0`
2. **Create `AuthContext`** (`src/context/auth.tsx`) with `useState` only; no storage yet. Wire up `main.tsx`.
3. **Create `AppShell`** with stub sidebar (no active states yet) and topbar skeleton. Confirm layout renders.
4. **Create `AppRouter`** with all routes. Confirm navigation works between stub pages.
5. **Implement `LoginPage`** — wire to `useAuth().login()`. Test passkey flow.
6. **Implement `DispatchPage`** — lift `loadDashboardData` and `assignWorkOrder` from `App.tsx`. Delete those from `App.tsx`.
7. **Implement `IntakePage`** — lift equipment debounce logic and `createWorkOrder`.
8. **Implement `ApprovalsPage`** — lift `approveWorkOrder` and `rejectWorkOrder`.
9. **Implement `KpiPage`** — lift KPI fetch.
10. **Implement `MessengerPage`** and `LocationSettingsPage`  — thin wrappers.
11. **Implement `EquipmentPage`** — extract `EquipmentLookupPanel`.
12. **Implement `WallBoardPage`** — lift wallboard data fetch.
13. **Add session storage** to `AuthContext`.
14. **Add UserMenu** to Topbar with logout/refresh/location links.
15. **Add nav active states** and collapsed sidebar behaviour.
16. **Delete `App.tsx`** (or reduce to a re-export shim if tests import it directly — check `App.test.tsx`).
17. **Run `npm test`** — all existing tests should pass since feature components are untouched.

---

## 12. App.test.tsx Migration Note

`src/App.test.tsx` likely tests the monolith via `render(<App />)`. After the decomposition:
- The component-level tests in `src/features/*/` are unaffected.
- `App.test.tsx` should be refactored to test individual pages (e.g. `render(<DispatchPage />)` inside a `MemoryRouter` + `AuthProvider` with a mock session).
- Or keep `App.tsx` as a thin integration shim that renders `<BrowserRouter><AuthProvider><AppRouter /></AuthProvider></BrowserRouter>` and update the test to use `MemoryRouter`.

---

## 13. i18n Additions (ko.ts)

Add the following keys for new shell UI text:

```typescript
// Additions to src/i18n/ko.ts
nav: {
  operations: "운영",
  data: "데이터",
  settings: "설정",
  dispatch: "배차",
  intake: "접수",
  approvals: "승인",
  kpi: "KPI 대시보드",
  messenger: "메신저",
  equipment: "장비 조회",
  locationSettings: "GPS 위치 동의",
  collapse: "메뉴 접기",
  expand: "메뉴 펼치기",
  openMenu: "메뉴 열기",
  skipToMain: "본문으로 이동",
},
user: {
  accountMenu: "계정 메뉴",
  refreshToken: "토큰 갱신",
  locationSettings: "위치 동의 설정",
  logout: "로그아웃",
},
equipment: {
  title: "장비 조회",
  description: "호기 번호로 장비·고객 정보를 조회합니다.",
},
```

---

## Summary Reference

| Concern | Before | After |
|---|---|---|
| Router | `window.location.pathname` check | `react-router` v8 `<Routes>` |
| Auth state | `useState` in `App.tsx` | `AuthContext` + `AuthProvider` |
| Data fetching | All in `App.tsx` | Each page owns its own fetch |
| Mutations | All in `App.tsx` | Each page owns its mutations |
| Shell | `<main className="mx-auto grid max-w-7xl ...">` | Persistent sidebar + topbar + `<Outlet />` |
| Login | Stacked card on main page | `/login` full-screen route |
| Wallboard | `window.location.pathname` branch | `/wallboard` shell-less route |
| Feature components | Unchanged | Unchanged |
| Tests | Feature tests pass unchanged | Feature tests pass unchanged |
