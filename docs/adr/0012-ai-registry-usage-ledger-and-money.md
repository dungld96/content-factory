# ADR-0012: AI registry, usage ledger and money precision

- Status: Accepted (M2 design package, revision 1, approved 2026-11-17)
- Date: 2026-11-17
- Milestone: M2

## Context

M2 introduces the provider/model registry, the first LLM adapter (OpenRouter) and usage/cost
normalization (`docs/design/M2-design-review-package.md`). Verification of OpenRouter's official
documentation (`docs/design/m2/openrouter-verification.md`) showed:

- prices are published as USD per token with up to 22 decimal places, and a single call can cost
  less than one micro-dollar;
- prices are multi-part (input, output, cache read/write, per request) and can be tiered by prompt
  size;
- the provider reports cost per call, not per metric, and the field can be absent.

`CLAUDE.md` requires integer micros or Decimal for money, unknown cost never shown as zero, and
traceable generation operations. `docs/DATABASE.md` sketched `*Micros` columns.

## Decision

1. **Money** is exact decimal USD: `NUMERIC(38,18)` in PostgreSQL, a `bigint`-backed `UsdAmount` (10⁻¹⁸
   USD units) in `packages/ai-core`, decimal strings in the API. Currency is an explicit column;
   M2 accepts only `USD`.
2. **Registry as data.** Providers, models, capabilities and prices live in PostgreSQL and are
   edited by an operator CLI (import from the provider's public catalog, or manual entry). Nothing is
   enabled automatically. The API exposes the registry read-only.
3. **Prices are append-only.** A price change is a new row with a new `effective_from`; the price
   active at the call's start is used. Missing price rows mean unknown cost.
4. **Usage ledger.** One `ai_invocations` row per provider call (written before the call, updated
   once with the outcome) and append-only `ai_usage_records` per metric. Reported cost, estimated cost
   and a `cost_status` (`reported` / `estimated` / `unknown`) are stored separately.
5. Price and usage rows are protected by a trigger (`AC011`), as in ADR-0011.

## Consequences

- Sub-micro costs are recorded exactly; totals do not drift from rounding.
- Prisma returns `Decimal` for these columns; API contracts use strings.
- `DATABASE.md`, `AI_PROVIDER_STRATEGY.md` and `COST_STRATEGY.md` change `*Micros` wording to the
  decimal form when M2 lands.
- The job layer (M5) links `ai_invocations.generation_job_id` to `GenerationJob` with a foreign key.

## Alternatives considered

- **Integer micros (`BIGINT`, 10⁻⁶ USD):** rejected; many LLM calls round to zero.
- **Integer nano-USD (10⁻⁹):** workable for totals, but unit prices still need more precision and
  rounding happens per call.
- **Usage rows only, without invocations:** the provider-reported per-call cost would have no place,
  and the call's lifecycle (intent before the call, unknown outcome) could not be recorded.
- **Registry in configuration files:** prices would need a deploy, contrary to
  AI_PROVIDER_STRATEGY §3.
