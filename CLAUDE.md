# CLAUDE.md

Guidance for Claude Code when working in **mnemio-backend** (Fastify + Prisma +
PostgreSQL REST API for the Mnemio learning platform).

## Read this first

The full agent guide — stack, commands, architecture, conventions, and the
"adding an endpoint" checklist — lives in **[AGENTS.md](./AGENTS.md)**. Treat it
as the source of truth and keep it in sync with the code. `README.md` and
`docs/` carry the long-form detail; **`docs/api-contract.md` is the authoritative
contract** for public request/response shapes.

## Fast facts

- **Run:** `npm run dev` (tsx watch → :3001). **Test:** `npm test` (Vitest).
  **Types:** `npm run typecheck`. **Lint:** `npx eslint .` (no npm script).
- **After a fresh clone or schema change:** `npx prisma generate` — the client in
  `generated/prisma/` is gitignored.
- **Layering is strict:** `route → controller (Zod parse) → service → repository
  (Prisma) → mapper → DTO`. Controllers don't touch Prisma; repositories own
  ownership filters (`authorId`); services throw `AppError` subclasses.
- **ESM gotcha:** import paths use explicit `.js` extensions and `import type`
  for types (`verbatimModuleSyntax`). tsconfig is strict
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- **Don't return raw Prisma rows** — map to DTOs via `shared/mappers*.ts`.
- **New env var?** Add it to `config/env.ts` (Zod) *and* `.env.example`.

## Working agreements

- Confirm before destructive DB actions (`prisma migrate reset` drops data).
- Don't implement out-of-MVP features (password reset, folders, leaderboards,
  account deletion, websockets) without an explicit ask — they 404 by design.
- When you change a public request/response shape, update `docs/api-contract.md`.
- `.claude/` is gitignored; don't rely on it for shared project config.
