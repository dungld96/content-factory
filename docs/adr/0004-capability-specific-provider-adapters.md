# ADR-0004: Capability-specific provider adapters

- Status: Accepted
- Date: 2026-11-17
- Milestone: M0 (decision); implementation in M2+

## Context

Providers differ widely: an OpenAI-compatible chat API says nothing about image, video or TTS
support. Pricing, quotas and terms change frequently (`docs/AI_PROVIDER_STRATEGY.md`).

## Decision

- Separate interfaces per capability: `LlmProvider`, `ImageProvider`, `VideoProvider`,
  `TtsProvider` (later `TranscriptionProvider`, `VisionEvaluationProvider`, ...). No universal
  `generate()` with optional fields.
- A provider registers each capability explicitly. Routing only considers models whose registry
  entry declares the capability and the required parameters.
- Adapters are injected via DI; business logic depends only on interfaces in `packages/ai-core`.
- Model/pricing data is registry data with an effective date and source URL, editable without a
  deploy. Unknown cost is recorded as unknown, never as zero.
- Every adapter ships a mock implementation and fixture-based contract tests; CI never makes paid
  calls.
- Provider credentials stay server-side; never logged, never returned to the frontend.

## Implementation note (M2)

Implemented for LLMs in M2: `packages/ai-core` holds the interfaces; the OpenRouter adapter is
reachable only as `@acf/ai-core/openrouter`, which ESLint allows only in
`apps/api/src/ai/providers`; tests use `MockLlmProvider` and a local fixture server, and a
network guard keeps every test off real hosts. See `docs/design/M2-design-review-package.md`.

## Consequences

- Adding a provider does not change content-domain code.
- No provider integration exists in M0 (explicitly out of scope).
