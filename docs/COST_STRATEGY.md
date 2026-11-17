# Cost Strategy

## 1. Principles

- Optimize cost per approved video, not raw generation count.
- Use low-cost LLMs for routine text tasks.
- Spend on image/video generation only after script/storyboard approval.
- Render only failed or changed scenes again.
- Reuse approved brand assets.
- Never assume free-tier quota is guaranteed.
- Track estimated and actual cost separately.

## 2. Cost categories

- LLM input tokens.
- LLM output tokens.
- Image generation count/resolution.
- Video generation duration/resolution/credits.
- TTS characters or audio duration.
- Transcription usage.
- Storage and egress.
- Compute for rendering.
- Retry and failed-generation cost.

## 3. Cost estimation

Use integer micros for currency calculations or Decimal. Keep currency explicit.

`estimated_cost = Σ(quantity × configured_unit_price)`

Each pricing record must include:
- Provider.
- Model.
- Unit.
- Price.
- Currency.
- Effective date.
- Source URL.
- Whether pricing is official or manually estimated.

If price is unknown, mark it unknown and require explicit confirmation or a configured hard budget policy. Do not display `$0` for unknown cost.

## 4. Budget enforcement

Support:
- Per-generation-job limit.
- Per-content-item limit.
- Per-project daily/monthly limit.

Enforcement modes:
- `hard`: block job if estimated cost exceeds remaining budget.
- `soft`: warn and require user confirmation.

For async providers with uncertain final billing, reserve estimated budget at submission and reconcile actual cost on completion.

## 5. Retry policy

- Retry transient network/5xx errors with exponential backoff and jitter.
- Respect provider `Retry-After`.
- Do not retry policy rejection or invalid requests.
- Limit attempts per job.
- Require approval for expensive regeneration after configured threshold.
- Store failed-attempt costs when charged.

## 6. Cost dashboard

Show:
- Cost by content item.
- Cost by stage.
- Cost by provider/model.
- Cost per approved video.
- Estimated vs actual.
- Retry cost.
- Free-tier vs paid usage.
- Monthly trend.

## 7. Initial pilot budget

Use a capped test budget rather than a promised per-video price. Suggested initial API test envelope: USD 50–100 for controlled experiments, subject to current provider prices and account quotas.

Before each test:
1. Confirm current official pricing.
2. Set per-job and per-project caps.
3. Generate a small benchmark batch.
4. Record actual cost.
5. Recalculate the cost model.

Do not extrapolate one successful generation into guaranteed monthly capacity.

## 8. Optimization order

1. Reduce unnecessary generation.
2. Approve script/storyboard before media calls.
3. Generate low-cost drafts before premium outputs.
4. Use candidate selection and scene-level regeneration.
5. Reuse reference assets and backgrounds.
6. Batch text tasks where supported.
7. Select cheaper providers only after quality benchmark.
8. Optimize storage and rendering after API spend is understood.
