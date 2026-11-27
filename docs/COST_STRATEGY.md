# Cost Strategy

## 1. Principles

- Optimize **cost per approved video**, not generation count.
- Spend on images and video only after the script and storyboard are approved.
- Reuse identical results; redo only failed or changed scenes.
- Track provider-reported and estimated cost separately.
- **Unknown cost is not zero**: never stored or shown as `$0`.
- Free tiers are not production capacity; none is relied on.

## 2. Money

- AI costs are exact decimal USD: `NUMERIC(38,18)` in PostgreSQL, `UsdAmount` (10⁻¹⁸ USD,
  `bigint`) in code (ADR-0012). Integer micros cannot hold per-token prices such as
  USD 0.000000072.
- Budgets use `DECIMAL(14,6)` USD.
- The API returns money as decimal strings, never JSON numbers.

## 3. Prices

Prices are append-only registry rows (`ai_model_prices`): model, metric, unit price, published
value, optional variant, effective date, source and URL. The active price is the latest row in
effect. A metric with no price means unknown cost.

`estimated_cost = Σ(quantity × unit_price)` over the metrics the model is priced on.

| Media | Metrics | Notes |
|---|---|---|
| LLM | input/output tokens (prompt-size tiers) | Text jobs reserve their worst case, twice (repair call) |
| Image | `output_images`, `input_images`, `output_pixels`, `input_pixels`, image tokens; variant per resolution (`2k`) | Token-priced models: estimate unknown, needs confirmation |
| Video | `output_video_seconds`, variant per resolution/audio (`720p-silent`, `720p`, …); first-frame fee `input_images` | Billed seconds = the supported duration chosen for the scene, or the model's minimum. Token-priced: unknown |
| TTS | `input_characters` (Unicode code points) | Token-priced: unknown before the call |
| Render | none | Local FFmpeg, USD 0 |

Each call writes an `ai_invocations` row with `cost_status`: `reported` (provider figure),
`estimated` (registry figure) or `unknown`. OpenRouter returns no per-call cost for TTS, so TTS
is recorded as an estimate.

## 4. Budgets

Per project (ADR-0019), owners set them on the **Costs** page:

| Limit | Default | Mode |
|---|---|---|
| Monthly (UTC calendar month) | USD 10 | hard |
| Per content item | USD 3 | soft |
| Per request | USD 2 | hard |

- **Hard** limit: `402 BUDGET_EXCEEDED`, nothing is queued. **Soft** limit: `409
  BUDGET_CONFIRMATION_REQUIRED`; accepting is recorded. A hard breach always decides.
- **Reservations**: every paid request reserves its estimate (unknown cost: USD 0.50 per call)
  in the same transaction that queues the jobs, under a lock on the budget, so concurrent requests
  cannot together exceed it.
- **Two checks**: the API at request time, the worker right before each paid call.
- **Resolution**: success settles, failure releases, an unknown provider outcome is **held**
  until an owner records it as charged or not charged (Operations page).
- **Usage** = ledger costs not covered by a reservation + open and held reservations + confirmed
  charges.
- New-project defaults come from `DEFAULT_MONTHLY_BUDGET_USD`, `DEFAULT_ITEM_BUDGET_USD`,
  `DEFAULT_REQUEST_BUDGET_USD`.

## 5. Cost reports

- **Costs page** (`GET /projects/:projectId/costs`): month total vs limit; by content item, stage
  and model; retry cost; cost per approved video; six-month trend. Reported, estimated, unknown
  (count) and held amounts are kept apart.
- **Render cost report** (`GET /renders/:renderId/cost-report`): every AI call of the content
  item by stage, part of the export package.

## 6. Retries and cost

- Retries only for transient errors, with backoff and jitter; at most 3 attempts.
- Failed attempts that were charged are counted as retry cost.
- A paid call whose outcome is unknown is never sent again automatically: video submissions
  (`SUBMIT_OUTCOME_UNKNOWN`) and text or speech calls (`CALL_OUTCOME_UNKNOWN`). The reservation is
  held until an owner records it as charged or not; Resume asks before a possible double charge.
  Image calls are retried (all-or-nothing billing).

## 7. Testing paid models

- No paid calls in automated tests (a network guard blocks real hosts).
- Paid smoke tests need `ACF_PAID_SMOKE=1` and a `--max-cost-usd` cap.
- Before a test: check current official prices, set caps, run a small batch, record the actual
  cost, then update the registry. One successful run is not guaranteed monthly capacity.

Measured: a 30 s video costs about USD 1.05 with the pilot routes
(`docs/design/m8/pilot-report.md`).

## 8. Where to save next

1. Avoid unnecessary generation (approve script and storyboard first).
2. Start with one candidate per scene; regenerate single scenes.
3. Reuse reference assets and identical results.
4. Switch to cheaper models only after a quality benchmark.
