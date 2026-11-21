-- CreateEnum
CREATE TYPE "ai_capability" AS ENUM ('llm', 'image_generation', 'image_edit', 'video_generation', 'tts', 'transcription', 'vision_evaluation');

-- CreateEnum
CREATE TYPE "ai_provider_status" AS ENUM ('enabled', 'disabled', 'degraded');

-- CreateEnum
CREATE TYPE "ai_quality_tier" AS ENUM ('economy', 'balanced', 'premium');

-- CreateEnum
CREATE TYPE "ai_price_metric" AS ENUM ('input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_tokens', 'reasoning_tokens', 'request');

-- CreateEnum
CREATE TYPE "ai_price_source" AS ENUM ('official_api', 'official_page', 'manual_estimate');

-- CreateEnum
CREATE TYPE "ai_invocation_status" AS ENUM ('started', 'succeeded', 'failed', 'outcome_unknown');

-- CreateEnum
CREATE TYPE "ai_cost_status" AS ENUM ('reported', 'estimated', 'unknown');

-- CreateEnum
CREATE TYPE "ai_usage_source" AS ENUM ('provider_reported', 'calculated', 'manual');

-- CreateTable
CREATE TABLE "ai_providers" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "status" "ai_provider_status" NOT NULL DEFAULT 'disabled',
    "terms_url" VARCHAR(2048),
    "data_policy_url" VARCHAR(2048),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_models" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "model_key" VARCHAR(200) NOT NULL,
    "canonical_slug" VARCHAR(200),
    "display_name" VARCHAR(200) NOT NULL,
    "supported_parameters" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "input_modalities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "output_modalities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "context_length" INTEGER,
    "max_output_tokens" INTEGER,
    "quality_tier" "ai_quality_tier" NOT NULL,
    "status" "ai_provider_status" NOT NULL DEFAULT 'disabled',
    "is_free_variant" BOOLEAN NOT NULL DEFAULT false,
    "rate_limit_notes" TEXT,
    "data_policy_notes" TEXT,
    "benchmark_score" DECIMAL(5,2),
    "last_tested_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_model_capabilities" (
    "model_id" UUID NOT NULL,
    "capability" "ai_capability" NOT NULL,

    CONSTRAINT "ai_model_capabilities_pkey" PRIMARY KEY ("model_id","capability")
);

-- CreateTable
CREATE TABLE "ai_model_prices" (
    "id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "metric" "ai_price_metric" NOT NULL,
    "unit_price" DECIMAL(38,18) NOT NULL,
    "source_value" VARCHAR(64) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "min_prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "source" "ai_price_source" NOT NULL,
    "source_url" VARCHAR(2048) NOT NULL,
    "captured_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_model_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_invocations" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "content_item_id" UUID,
    "generation_job_id" UUID,
    "correlation_id" VARCHAR(128) NOT NULL,
    "idempotency_key" VARCHAR(200),
    "capability" "ai_capability" NOT NULL,
    "provider_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "served_model" VARCHAR(200),
    "provider_request_id" VARCHAR(200),
    "status" "ai_invocation_status" NOT NULL DEFAULT 'started',
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(500),
    "request_summary" JSONB NOT NULL,
    "finish_reason" VARCHAR(32),
    "latency_ms" INTEGER,
    "reported_cost" DECIMAL(38,18),
    "estimated_cost" DECIMAL(38,18),
    "cost_status" "ai_cost_status" NOT NULL DEFAULT 'unknown',
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "ai_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_records" (
    "id" UUID NOT NULL,
    "invocation_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "metric" "ai_price_metric" NOT NULL,
    "quantity" BIGINT NOT NULL,
    "unit_price" DECIMAL(38,18),
    "cost" DECIMAL(38,18),
    "price_id" UUID,
    "source" "ai_usage_source" NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_providers_key_key" ON "ai_providers"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ai_models_provider_id_model_key_key" ON "ai_models"("provider_id", "model_key");

-- CreateIndex
CREATE UNIQUE INDEX "ai_models_provider_id_id_key" ON "ai_models"("provider_id", "id");

-- CreateIndex
CREATE INDEX "ai_model_capabilities_capability_idx" ON "ai_model_capabilities"("capability");

-- CreateIndex
CREATE INDEX "ai_model_prices_created_by_id_idx" ON "ai_model_prices"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_model_prices_model_id_metric_min_prompt_tokens_effective_key" ON "ai_model_prices"("model_id", "metric", "min_prompt_tokens", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "ai_invocations_idempotency_key_key" ON "ai_invocations"("idempotency_key");

-- CreateIndex
CREATE INDEX "ai_invocations_project_id_started_at_idx" ON "ai_invocations"("project_id", "started_at");

-- CreateIndex
CREATE INDEX "ai_invocations_provider_id_model_id_started_at_idx" ON "ai_invocations"("provider_id", "model_id", "started_at");

-- CreateIndex
CREATE INDEX "ai_invocations_status_started_at_idx" ON "ai_invocations"("status", "started_at");

-- CreateIndex
CREATE INDEX "ai_invocations_content_item_id_idx" ON "ai_invocations"("content_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_invocations_project_id_id_key" ON "ai_invocations"("project_id", "id");

-- CreateIndex
CREATE INDEX "ai_usage_records_invocation_id_idx" ON "ai_usage_records"("invocation_id");

-- CreateIndex
CREATE INDEX "ai_usage_records_project_id_recorded_at_idx" ON "ai_usage_records"("project_id", "recorded_at");

-- CreateIndex
CREATE INDEX "ai_usage_records_price_id_idx" ON "ai_usage_records"("price_id");

-- AddForeignKey
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "ai_providers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_model_capabilities" ADD CONSTRAINT "ai_model_capabilities_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "ai_models"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_model_prices" ADD CONSTRAINT "ai_model_prices_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "ai_models"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_model_prices" ADD CONSTRAINT "ai_model_prices_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_project_id_content_item_id_fkey" FOREIGN KEY ("project_id", "content_item_id") REFERENCES "content_items"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "ai_providers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_provider_id_model_id_fkey" FOREIGN KEY ("provider_id", "model_id") REFERENCES "ai_models"("provider_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_usage_records" ADD CONSTRAINT "ai_usage_records_project_id_invocation_id_fkey" FOREIGN KEY ("project_id", "invocation_id") REFERENCES "ai_invocations"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_usage_records" ADD CONSTRAINT "ai_usage_records_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "ai_model_prices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================
-- M2 integrity layer (docs/design/M2-design-review-package.md §6.4, ADR-0012).
-- Hand-written; Prisma does not model CHECKs, functions or triggers.
--   AC011  ledger row immutable: price and usage rows are append-only; an invocation is
--          updated once, from `started` to its outcome, and its identity never changes.
-- Locking: these tables take part in no M1 lock order (ADR-0011 §6). Inserting an invocation
-- takes FOR KEY SHARE on its project/content/model rows, which never conflicts with the
-- no-op `UPDATE projects` (FOR NO KEY UPDATE) of the owner-change protocol.
-- =============================================================================

ALTER TABLE "ai_providers"
  ADD CONSTRAINT "ai_providers_key_format" CHECK ("key" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "ai_providers_kind_known" CHECK ("kind" IN ('gateway', 'direct', 'mock')),
  ADD CONSTRAINT "ai_providers_name_nonempty" CHECK (length(btrim("name")) > 0);

ALTER TABLE "ai_models"
  ADD CONSTRAINT "ai_models_model_key_nonempty" CHECK (length(btrim("model_key")) > 0),
  ADD CONSTRAINT "ai_models_context_positive" CHECK ("context_length" IS NULL OR "context_length" > 0),
  ADD CONSTRAINT "ai_models_max_output_positive" CHECK ("max_output_tokens" IS NULL OR "max_output_tokens" > 0),
  ADD CONSTRAINT "ai_models_benchmark_range" CHECK ("benchmark_score" IS NULL OR "benchmark_score" BETWEEN 0 AND 100);

ALTER TABLE "ai_model_prices"
  ADD CONSTRAINT "ai_model_prices_unit_price_nonnegative" CHECK ("unit_price" >= 0),
  ADD CONSTRAINT "ai_model_prices_currency_usd" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "ai_model_prices_tier_nonnegative" CHECK ("min_prompt_tokens" >= 0),
  ADD CONSTRAINT "ai_model_prices_source_value_nonempty" CHECK (length(btrim("source_value")) > 0),
  ADD CONSTRAINT "ai_model_prices_source_url_nonempty" CHECK (length(btrim("source_url")) > 0);

ALTER TABLE "ai_invocations"
  ADD CONSTRAINT "ai_invocations_currency_usd" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "ai_invocations_latency_nonnegative" CHECK ("latency_ms" IS NULL OR "latency_ms" >= 0),
  ADD CONSTRAINT "ai_invocations_costs_nonnegative" CHECK (
    ("reported_cost" IS NULL OR "reported_cost" >= 0) AND ("estimated_cost" IS NULL OR "estimated_cost" >= 0)),
  -- `completed_at` is set exactly when the call has an outcome.
  ADD CONSTRAINT "ai_invocations_completion_consistent" CHECK (("status" = 'started') = ("completed_at" IS NULL)),
  -- Failures carry a normalized error code; successes never do.
  ADD CONSTRAINT "ai_invocations_error_consistent" CHECK (
    ("status" IN ('failed', 'outcome_unknown')) = ("error_code" IS NOT NULL)),
  -- Cost status matches the amounts (ADR-0012): unknown cost is never stored as an amount.
  ADD CONSTRAINT "ai_invocations_cost_status_consistent" CHECK (
    (("cost_status" = 'reported') = ("reported_cost" IS NOT NULL))
    AND ("cost_status" <> 'estimated' OR "estimated_cost" IS NOT NULL)
    AND ("cost_status" <> 'unknown' OR "estimated_cost" IS NULL)),
  ADD CONSTRAINT "ai_invocations_request_summary_object" CHECK (jsonb_typeof("request_summary") = 'object');

ALTER TABLE "ai_usage_records"
  ADD CONSTRAINT "ai_usage_records_quantity_nonnegative" CHECK ("quantity" >= 0),
  ADD CONSTRAINT "ai_usage_records_unit_price_nonnegative" CHECK ("unit_price" IS NULL OR "unit_price" >= 0),
  -- A cost exists exactly when a unit price is known, and equals quantity × unit price.
  ADD CONSTRAINT "ai_usage_records_cost_consistent" CHECK (
    ("unit_price" IS NULL) = ("cost" IS NULL) AND ("cost" IS NULL OR "cost" = "quantity" * "unit_price")),
  ADD CONSTRAINT "ai_usage_records_price_needs_unit_price" CHECK ("price_id" IS NULL OR "unit_price" IS NOT NULL);

-- ---------------------------------------------------------------- ledger guard (AC011)

CREATE FUNCTION acf_ai_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'AC011',
    MESSAGE = format('%s rows are append-only (%s refused)', TG_TABLE_NAME, lower(TG_OP));
END $$;

CREATE TRIGGER ai_model_prices_append_only BEFORE UPDATE OR DELETE ON "ai_model_prices"
  FOR EACH ROW EXECUTE FUNCTION acf_ai_ledger_append_only();
CREATE TRIGGER ai_usage_records_append_only BEFORE UPDATE OR DELETE ON "ai_usage_records"
  FOR EACH ROW EXECUTE FUNCTION acf_ai_ledger_append_only();

-- Invocations: inserted as `started`, then updated exactly once with the outcome.
CREATE FUNCTION acf_ai_invocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'ai_invocations rows cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'started' THEN
      RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'ai_invocations rows are inserted as started';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'started' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011',
      MESSAGE = format('ai_invocation %s already has an outcome (%s)', OLD.id, OLD.status);
  END IF;
  IF (NEW.id, NEW.project_id, NEW.content_item_id, NEW.generation_job_id, NEW.correlation_id,
      NEW.idempotency_key, NEW.capability, NEW.provider_id, NEW.model_id, NEW.request_summary,
      NEW.currency, NEW.started_at)
     IS DISTINCT FROM
     (OLD.id, OLD.project_id, OLD.content_item_id, OLD.generation_job_id, OLD.correlation_id,
      OLD.idempotency_key, OLD.capability, OLD.provider_id, OLD.model_id, OLD.request_summary,
      OLD.currency, OLD.started_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'ai_invocations identity columns are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ai_invocations_guard BEFORE INSERT OR UPDATE OR DELETE ON "ai_invocations"
  FOR EACH ROW EXECUTE FUNCTION acf_ai_invocation_guard();
