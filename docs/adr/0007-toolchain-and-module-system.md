# ADR-0007: Toolchain baseline and ESM module system

- Status: Accepted for M0 — **review requested**
- Date: 2026-11-17
- Milestone: M0

## Context

`CLAUDE.md` requires pinned, currently supported, stable versions verified for compatibility. While
setting up M0, several "latest" releases turned out to be unsuitable or incompatible with each
other, and the module-system choice was forced by NestJS 12.

## Decision

### Versions (all pinned exactly; `.npmrc` has `save-exact=true`)

| Tool            | Version                            | Notes                                                                                                    |
| --------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Node.js         | ≥ 22.12 (`.nvmrc`: 22)             | Node 22 is the development baseline. CI also runs the full suite on Node 24 (compatibility target only). |
| pnpm            | 10.28.0 (`packageManager`)         | pnpm 11/12 exist; staying on 10 avoids config-format migrations in M0. Revisit.                          |
| TypeScript      | 6.0.3                              | TS 7 (native port) is out, but `typescript-eslint` supports `<6.1` and `@nestjs/cli` pins `~6.0`.        |
| NestJS          | 12.3.2 (`@nestjs/cli` 12.0.13)     | NestJS 12 ships **ESM only**.                                                                            |
| Next.js / React | 16.4.6 / 19.3.1                    | 16.4.6 fixes GHSA-mfr8-8qww-v76h, which affects ≤ 16.4.4.                                                |
| Prisma          | 7.10.1                             | `latest` npm tag is 8.0.0-rc (pre-release), so rejected. Uses `@prisma/adapter-pg`.                      |
| Zod             | 4.6.7                              | Shared validation (ADR-0008).                                                                            |
| ioredis         | 6.0.0                              | Satisfies BullMQ 6's `ioredis >=5` peer range.                                                           |
| Vitest          | 5.1.0                              | Single runner for all workspaces; SWC (`unplugin-swc`) for Nest decorator metadata.                      |
| ESLint          | 10.15.0 + typescript-eslint 8.73.0 | ESLint 9 is marked unsupported upstream.                                                                 |
| Prettier        | 3.9.10                             |                                                                                                          |
| PostgreSQL      | 17.12 (Docker)                     |                                                                                                          |
| Redis           | 7.4.12 (Docker)                    |                                                                                                          |

Selection rule used: the newest stable release at least ~2 weeks old, unless a newer patch
release fixes a published security advisory (Next.js 16.4.6, `@nestjs/cli` 12.0.13, ESLint 10.15.0,
typescript-eslint 8.73.0 were taken for that reason: each moves off a vulnerable `minimatch`/Next
version). `pnpm audit` reports no known vulnerabilities at the time of writing.

### Module system

All workspace packages are ESM (`"type": "module"`), compiled with `module`/`moduleResolution`
`NodeNext`. Relative imports use explicit `.js` extensions. The web app uses `Bundler` resolution
as Next.js requires.

### Linting

`eslint-config-next` is **not** used: its bundled `eslint-plugin-react`, `eslint-plugin-jsx-a11y`
and `eslint-plugin-import` do not declare ESLint 10 support. The web app uses
`@next/eslint-plugin-next` (recommended + core-web-vitals) and `eslint-plugin-react-hooks` directly.
Linting is type-aware (`typescript-eslint` `strictTypeChecked`).

## Consequences

- No JSX accessibility lint rules until `eslint-plugin-jsx-a11y` supports ESLint 10, so
  accessibility must be checked in review.
- Import ordering is enforced by Prettier only, not by lint rules.
- The `prisma-client` generator emits ESM TypeScript into `packages/database/src/generated`.

## Alternatives considered

- Stay on ESLint 9 to keep `eslint-config-next`: rejected because ESLint 9 is no longer supported.
- CommonJS for the API: not possible, because NestJS 12 packages are ESM only.
- Oxlint (used by the NestJS 12 starter): faster, but less type-aware coverage than
  typescript-eslint today. Could be revisited.

## Update 2026-11-17 (M0 review)

- **Runtime**: Node 22 stays the default (`.nvmrc`). CI runs a Node 22 + 24 matrix. A local run
  on Node 24.22.3 passed format, lint, typecheck, unit tests, integration tests and build, and the
  built API served readiness. The default runtime does not change until all apps and
  dependencies pass on Node 24 in CI.
- **CI actions** are pinned to commit SHAs: `actions/checkout` v7.0.1, `actions/setup-node`
  v7.1.0, `pnpm/action-setup` v6.1.1. `pnpm/action-setup`'s successor (`pnpm/setup`) requires
  pnpm ≥ 11, so it is tied to the deferred pnpm upgrade.
- **Accessibility lint investigation**:
  - `eslint-plugin-jsx-a11y` 6.10.2 still declares ESLint ≤ 9, so it is not used.
  - `eslint-plugin-jsx-a11y-x` 0.2.0 (es-tooling fork, declares `eslint ^9 || ^10`) was trialled
    in a throwaway run. It loaded under ESLint 10.15.0 and reported missing `alt`,
    click-without-key-handler, static-element interactions and invalid `href` in a fixture. The
    current web code passes its `recommended` set. Risks: 0.x version, single maintainer, low
    release cadence.
  - `@eslint-react/eslint-plugin` (ESLint-agnostic peer) covers React correctness, not
    accessibility.
  - **Pending owner decision**: adopt `eslint-plugin-jsx-a11y-x` (`recommended`, web only), or
    wait for upstream `eslint-plugin-jsx-a11y` ESLint 10 support.
