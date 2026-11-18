# AI Provider Strategy

## 0. Implementation status (M2)

Implemented per `docs/design/M2-design-review-package.md` (ADR-0004, ADR-0012):
- `packages/ai-core`: capability enum, `LlmProvider` (image/video/TTS declared only), normalized
  `ProviderError` with a retry/fallback policy per code (§7 below), exact money, cost assessment,
  candidate filtering (steps 1–3 and 7 of §4; budget, data policy and circuit breaking come with
  M7), and `MockLlmProvider` for tests.
- One adapter: OpenRouter, text only (`@acf/ai-core/openrouter`), verified against official
  documentation on 2026-11-17 (`docs/design/m2/openrouter-verification.md`). Every request sends
  `provider.data_collection: "deny"`, `require_parameters: true` and same-model host fallback
  only; zero data retention is opt-in per call; the cross-model `models` list is never sent.
- Registry in PostgreSQL, edited by the operator CLI (`pnpm ai:registry`), read-only over the
  API. New models are disabled until enabled explicitly; none is a production default until
  benchmarked (§9).

## 0.1 Implementation status (M4: image generation)

Per `docs/design/M4-design-review-package.md` §3 (verification record
`docs/design/m4/openrouter-image-verification.md`):
- `ImageProvider` (`packages/ai-core`, `media.ts`): typed request (prompt, aspect ratio,
  resolution tier, count, seed, reference images) and result (decoded images, usage, reported
  cost); `imageConstraintIssues` checks a model's recorded limits (`ai_models.image_constraints`).
- One adapter: the OpenRouter **Image API** (`POST /api/v1/images`, synchronous, base64 output,
  all-or-nothing billing). Every request sends `provider.data_collection: "deny"`; `zdr` is set
  per route. Only parameters the request uses are sent. `MockImageProvider` for tests and E2E.
- `ImageService` (`packages/ai-runtime`): route → persist intent → call → persist usage and cost,
  like `LlmService`. Image prices are registry data: per image, per pixel (per-megapixel prices),
  or per image token, optionally per resolution tier (`ai_model_prices.variant`).
- Registry CLI: `model import-openrouter-images` (public endpoint records → disabled models with
  limits and prices), `route set image_generation <modelKey>`, and the paid, capped
  `smoke-image` used for the benchmark (AI_PROVIDER_STRATEGY §9). The development seed routes
  image generation to the free `mock/solid-image` model; the three benchmark candidates are
  seeded disabled.

## 1. Objectives

- Avoid vendor lock-in.
- Route each task to a model suitable for its capability and cost.
- Support free, low-cost, and premium tiers.
- Track provider usage and cost.
- Fail over only to compatible alternatives.
- Protect project assets and prompts according to provider data policies.

## 2. Capability-based interfaces

Implement separate interfaces:

```typescript
type Capability =
  | "llm"
  | "image_generation"
  | "image_edit"
  | "video_generation"
  | "tts"
  | "transcription"
  | "vision_evaluation";

interface ProviderDescriptor {
  id: string;
  name: string;
  capabilities: Capability[];
  status: "enabled" | "disabled" | "degraded";
}

interface GenerationContext {
  projectId: string;
  contentId: string;
  jobId: string;
  qualityTier: "economy" | "balanced" | "premium";
  maxCostMicros?: number;
  deadlineAt?: string;
}
```

Capability-specific input/output types must be defined. Do not create one universal `generate()` method with dozens of optional fields.

## 3. Model registry

Each model record should include:
- Provider and model identifier.
- Capabilities.
- Supported input/output modalities.
- Reference image support.
- Editing support.
- Maximum duration/resolution where applicable.
- Input/output pricing and pricing unit.
- Pricing effective date and source URL.
- Rate-limit notes.
- Free-tier flag and quota notes.
- Data retention/training policy link.
- Enabled/disabled state.
- Internal benchmark score and last-tested date.

Pricing and free-tier information must be editable without code deployment.

## 4. Routing policy

Candidate filtering:
1. Provider enabled.
2. Capability supported.
3. Required parameters supported.
4. Project allowlist/data policy satisfied.
5. Budget available.
6. Provider not currently circuit-broken.
7. Model meets minimum quality tier.

Candidate scoring can consider:
- Cost.
- Quality benchmark.
- Latency.
- Reliability.
- User preference.

Return routing explanation and estimated cost.

## 5. Suggested task tiers

| Task | Default tier | Notes |
|---|---|---|
| Topic classification | Economy | Small/fast LLM |
| Caption and hashtags | Economy | Batch where possible |
| Research synthesis | Balanced | Requires source-grounded output |
| Script writing | Balanced | Structured output |
| Storyboard | Balanced | Schema validation |
| Image prompt refinement | Economy/Balanced | Reuse prompts and references |
| Image generation | Balanced | Benchmark consistency |
| Video generation | Balanced | Cost is usually dominant |
| Final quality evaluation | Balanced/Premium | Vision-capable model if useful |
| Difficult failure diagnosis | Premium | On demand |

## 6. Gateway policy

OpenRouter and OmniRoute may be used as LLM gateways where their supported API and model capabilities fit. They are not assumed to be universal media gateways.

For image/video/TTS, use direct provider adapters unless a gateway explicitly documents the required capability and parameters.

Do not assume:
- All models are available through every gateway.
- Free model quotas are stable.
- A provider's “free” tier permits commercial use.
- API-compatible means behaviorally identical.
- Chat-completion pricing applies to image/video generation.

## 7. Fallback

Fallback conditions:
- Transient network error.
- Provider 5xx.
- Rate limit, if retry-after and budget allow.
- Provider outage.

Do not fallback automatically for:
- Invalid prompt.
- Content policy rejection.
- Unsupported parameter.
- Authentication failure.
- Insufficient budget.
- User rejection of generated output.

Fallback must preserve required features. If no equivalent model exists, stop and request user decision rather than silently changing output requirements.

## 8. Provider adapter contract

Each adapter must:
- Validate capability-specific input.
- Normalize provider response.
- Normalize errors.
- Expose provider job ID for async tasks.
- Support polling or webhook completion.
- Report usage if provider supplies it.
- Mark estimated cost when calculated locally.
- Redact secrets.
- Include request correlation ID.

## 9. Benchmark protocol

Before selecting a default model:
1. Use the same prompt and reference inputs.
2. Generate a minimum test set (e.g. 10 samples per candidate).
3. Score prompt adherence, character consistency, visual quality, motion quality, latency, failure rate, and cost.
4. Save outputs and scores.
5. Re-run after material provider/model changes.

Never promote a model to production default based only on marketing examples.

## 10. Data governance

Before sending a character master, unreleased product, or proprietary asset to a provider:
- Review provider terms.
- Review data retention and model-training settings.
- Confirm commercial-use permissions.
- Prefer providers/settings with appropriate privacy commitments.
- Allow project-level provider deny lists.
