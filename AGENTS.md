# AGENTS.md

This file gives coding agents and contributors project-specific guidance for working in **JumboCrab-EMIS**.

## Communication style

- Use the `caveman:caveman` skill in every chat for this project, at its default `full` intensity, until the user asks for normal mode or another level.
- Keep technical explanations accurate and terse. Leave code, commits, and PR text in normal professional style.

## Project overview

- Framework: **Next.js** with the App Router
- Language: **TypeScript**
- Database: **PostgreSQL** via **Prisma**
- Auth/session: **iron-session**
- UI: **shadcn/ui** with **Tailwind CSS 4** (built on **Radix UI** primitives)
- Main domain areas reflected in the Prisma schema:
  - employee management
  - org structure (departments, positions)
  - government IDs and contributions
  - schedules, shifts, attendance, punches
  - violations and reset policies
  - payroll, earnings, deductions, cash advances
  - employee self-service requests (leave, day off, schedule change, schedule swap)

## Important repo facts

- Root README is still mostly the default Next.js scaffold and does **not** describe the real business domain yet.
- The app uses `src/` layout. Prefer looking under `src/app`, `src/lib`, and related folders before adding new top-level directories.
- The landing page redirects based on session and role.
- Role-based behavior exists, so changes that affect navigation, authorization, or dashboards should be checked carefully.

## Common commands

Use **npm** unless the repo owner says otherwise.

```bash
npm install
npm run dev
npm run build
npm run lint
npm run prisma:generate
npm run prisma:migrate
npm run prisma:studio
npm run prisma:seed
```

Other seed helpers available:

```bash
npm run prisma:seed:payroll:bimonthly
npm run prisma:seed:gm-43
npm run prisma:seed:attendance:2-bimonthly
```

## Working conventions

### 1) Respect the existing stack

- Use **App Router** patterns for pages, layouts, and route handlers.
- Keep new code in **TypeScript**.
- Reuse existing utilities in `src/lib` before creating duplicate helpers.
- Use Prisma for database access instead of mixing in unrelated ORM/query patterns.

### 2) Be careful with auth and roles

- Session handling is implemented with `iron-session`.
- The app redirects users based on their normalized role.
- Before changing authentication, role checks, or redirects, inspect the related code paths and preserve existing behavior for all roles.
- Never hardcode privileged access in UI or server logic.

### 3) Treat the Prisma schema as a source of truth

- This repo has a large, domain-heavy Prisma schema. Read it before changing business logic.
- Prefer extending existing models and enums carefully rather than inventing parallel structures.
- When schema changes are needed:
  - keep names consistent with current conventions
  - consider impacts on payroll, attendance, and employee request flows
  - avoid breaking existing seed scripts
- After schema changes, regenerate Prisma client.

### 4) Preserve domain relationships

Many features are interdependent. Changes in one area can affect others.

Examples:
- attendance impacts payroll calculations
- employee deductions and contributions impact payroll lines and net pay
- leave/day off/schedule change/swap requests can affect attendance and scheduling
- role/user changes can affect employee-linked accounts and approval flows

When editing these areas, check downstream effects before finalizing changes.

### 5) Prefer small, focused changes

- Make the smallest reasonable change that solves the task.
- Avoid broad refactors unless explicitly requested.
- Do not rename major domain concepts without a strong reason.
- Keep filenames and exports aligned with existing repo style.

## File placement guidance

- Put route/page UI under `src/app/...`
- Put shared server/client utilities under `src/lib/...`
- Put database schema and migrations under `prisma/...`
- Put seed scripts under `scripts/...`

Before adding a new utility, search for an existing helper first.

## Data and migration safety

- Do not delete or rename Prisma fields/models casually.
- Do not change enum values that may already be stored in the database unless a migration plan is clear.
- Avoid destructive migrations unless explicitly requested.
- If a schema change affects seeded data, update or document the related seed script.

## UI and form guidance

- This repo already uses React Hook Form, Zod, **shadcn/ui**, and Tailwind-based utilities.
- Align every UI component used, added, or changed in this project with **shadcn/ui** conventions and existing component patterns. Reuse or extend the project's shadcn/ui components instead of introducing a different UI system.
- Prefer these existing tools over introducing new form or component libraries.
- Keep forms aligned with domain terminology already used in Prisma and the app.
- For employee/payroll/schedule flows, clarity matters more than flashy UI.

## When adding features

Include, when relevant:
- validation
- role/permission checks
- loading and empty states
- error handling
- database consistency with Prisma models

## When fixing bugs

Try to identify whether the issue is in:
- session/auth flow
- role routing
- Prisma query/data shape
- date/pay period/schedule logic
- enum/status transition logic

Fix the root cause instead of only patching UI symptoms.

## Testing and verification checklist

Since this repo may not yet have a full automated test suite, verify with the smallest practical checks:

1. Run lint if your changes affect app code.
2. Run Prisma generate if schema types are involved.
3. Smoke-test the affected route or flow locally.
4. For domain logic changes, verify at least one realistic scenario end-to-end.

Examples:
- sign-in redirect by role
- creating or editing an employee
- attendance or schedule updates
- payroll generation/review/release flow
- request approval or rejection flow

## Avoid

- adding a second auth approach without explicit approval
- bypassing Prisma with ad hoc data layers
- introducing unrelated dependencies for simple tasks
- making schema changes without considering migrations and seeds
- changing payroll/attendance logic without tracing downstream effects
- replacing established domain names with new terminology unnecessarily

## Good first places to inspect when unsure

- `package.json`
- `prisma/schema.prisma`
- `src/lib/auth.ts`
- `src/lib/db.ts`
- `src/app/page.tsx`

## Notes for future improvements

The repo would benefit from:
- a real project README
- documented environment variables
- contributor setup steps for database bootstrapping
- test coverage for payroll, attendance, and approval workflows

If you add any of those, keep them consistent with this file.
