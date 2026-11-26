# ADR-0023: A second AI gateway (MixRoute) and switching tasks between gateways

- Status: Accepted (owner, 2026-11-26: "thêm gateway mixroute.ai, có thể đổi gateway trong
  setting"; phased delivery, per-task routes plus a bulk switch)
- Date: 2026-11-26
- Milestone: post-MVP P5 (`docs/design/P5-design-review-package.md`)

## Context

OpenRouter was the only gateway in production use. The owner wants MixRoute as an alternative
and a way to change gateway from Settings. MixRoute is OpenAI-compatible but differs from
OpenRouter in ways that matter to the platform rules: it reports no per-call cost, publishes no
price API, and has no per-request zero-data-retention or no-training routing
(`docs/design/p5/mixroute-verification.md`).

## Decision

1. MixRoute is a second registry provider of kind `gateway` with its own capability adapters
   (`@acf/ai-core/mixroute`), wired only in `packages/ai-runtime/src/providers`. Business code
   stays provider-agnostic (ADR-0004).
2. Its calls are always recorded at the registry estimate (`cost_status = estimated`, or `unknown`
   when unpriced). Prices come from a curated catalog in code, sourced from the official model
   pages with URL and date.
3. A task route that requires zero-data-retention can never point at a gateway that cannot
   provide it.
4. Switching gateway is a routing operation, not a mode: `POST /ai/gateways/:key/switch` sets the
   routes of all chosen tasks in one transaction, each audited. There is still no automatic
   fallback between gateways.

## Consequences

- Cost figures for MixRoute calls are estimates until reconciliation exists; the UI says so.
- The curated catalog must be refreshed by hand when MixRoute changes prices or ids.
- Adding a third gateway follows the same pattern: adapters, a provider row, a catalog source,
  and a `supportsZeroDataRetention` answer.

## Alternatives considered

- **One global "active gateway" setting**: simpler to explain, but forces every task to move even
  when the gateway lacks a model (no MixRoute TTS yet) and duplicates the per-task routes.
- **Treat MixRoute as an OpenRouter base-URL swap**: rejected; request shape, errors, cost
  reporting and data-policy controls differ.
- **Read MixRoute's usage logs for actual cost**: needs a second credential, has no request-id
  filter and keeps logs 7 days; deferred.
