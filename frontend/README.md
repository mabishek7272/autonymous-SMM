# E-Kalavya Frontend

Admin dashboard for the E-Kalavya admissions and academy platform. React 19, Vite, TypeScript (strict),
react-router, TanStack Query, Lucide icons. All data comes from the Express backend in `../backend`; the UI has
no mock data: empty results render an empty state and failed requests render an error state with a Retry button.

## Setup

```bash
cp .env.example .env     # optional; defaults work with the dev proxy
npm install
npm run dev              # http://localhost:3000, proxies /api to http://localhost:3001
```

The backend must be running on port 3001 (see `../backend`). Configuration:

| Variable            | Default   | Purpose                  |
| ------------------- | --------- | ------------------------ |
| `VITE_API_BASE_URL` | `/api/v1` | Base URL of the REST API |

## Scripts

| Script               | What it does                          |
| -------------------- | ------------------------------------- |
| `npm run dev`        | Vite dev server                       |
| `npm run build`      | Type-check (`tsc -b`) and build       |
| `npm run typecheck`  | `tsc -b --noEmit`                     |
| `npm run lint`       | oxlint                                |
| `npm test`           | Vitest + Testing Library (single run) |
| `npm run test:watch` | Vitest in watch mode                  |

## Structure

```
src/
  main.tsx, App.tsx, AppProviders.tsx   entry, routes (lazy), providers
  auth/        AuthContext, useAuth, RequirePermission, LoginPage, token storage (session.ts)
  shell/       Header, Shell layout, navigation (tab -> permission map), activity summary
  services/    http.ts (request, ApiError), api.ts (typed endpoints), stream.ts (Ollama SSE), queryClient.ts
  types/       backend-mirroring domain types, permissions, lead-stages (UI stage <-> LeadStatus)
  ui/          shared primitives (Button, Modal, Table, KpiBar, toasts, confirm, charts, ...) + ui.css
  features/    one folder per tab: admissions, students, teacher, reports, overview, admin
  test/        setup + renderWithProviders
```

## Access control (RBAC)

The UI never checks role names. `GET /auth/me` returns the caller's `permissions` (from
`backend/src/utils/permissions.ts`) and every tab, button and route is gated with `hasPermission(...)` /
`<RequirePermission>`. The backend enforces the same permissions on every endpoint.

| Tab (route)             | Permission        |
| ----------------------- | ----------------- |
| Admissions `/admissions`| `leads:manage`    |
| Student Health `/students` | `students:read` |
| Teachers `/teachers`    | `attendance:mark` |
| Reports `/reports`      | `reports:review`  |
| Overview `/overview`    | `dashboard:view`  |
| Users `/admin`          | `users:manage`    |
| Dev Console `/dev`      | `dev:console`     |

Header extras: WhatsApp status pill (`dashboard:view`), AI activity pill and Logs drawer (`agents:view`).
Unknown or forbidden routes redirect to the first tab the user may see.

## Conventions

- Fetch through `src/services/api.ts` (or `request` from `src/services/http.ts`); never fabricate fallback data.
- Mutations: disable the button while pending, toast the real result (`useToast`), toast the real error message.
- Destructive actions use `useConfirm()`.
- Session: token in `localStorage` under `ekalavya_token`; any 401 clears it and returns to `/login`.
