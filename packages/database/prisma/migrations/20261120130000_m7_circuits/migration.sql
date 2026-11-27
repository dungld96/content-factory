-- M7 circuit breaker per provider (design: docs/design/M7-design-review-package.md §7). Generated
-- DDL first, then the integrity layer.
-- CreateEnum
CREATE TYPE "circuit_state" AS ENUM ('closed', 'open', 'half_open');

-- CreateTable
CREATE TABLE "provider_circuits" (
    "provider_id" UUID NOT NULL,
    "state" "circuit_state" NOT NULL DEFAULT 'closed',
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_failure_at" TIMESTAMPTZ(3),
    "opened_at" TIMESTAMPTZ(3),
    "retry_at" TIMESTAMPTZ(3),
    "open_for_ms" INTEGER NOT NULL DEFAULT 300000,
    "trial_job_id" UUID,
    "trial_started_at" TIMESTAMPTZ(3),
    "last_error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_circuits_pkey" PRIMARY KEY ("provider_id")
);

-- CreateTable
CREATE TABLE "provider_circuit_events" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "from_state" "circuit_state" NOT NULL,
    "to_state" "circuit_state" NOT NULL,
    "reason" VARCHAR(32) NOT NULL,
    "error_code" VARCHAR(64),
    "job_id" UUID,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_circuit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_circuit_events_provider_id_created_at_idx" ON "provider_circuit_events"("provider_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "provider_circuit_events_actor_id_idx" ON "provider_circuit_events"("actor_id");

-- AddForeignKey
ALTER TABLE "provider_circuits" ADD CONSTRAINT "provider_circuits_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "ai_providers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "provider_circuit_events" ADD CONSTRAINT "provider_circuit_events_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "ai_providers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "provider_circuit_events" ADD CONSTRAINT "provider_circuit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------- integrity layer

ALTER TABLE "provider_circuits"
  ADD CONSTRAINT "provider_circuits_failures_nonnegative" CHECK ("consecutive_failures" >= 0),
  ADD CONSTRAINT "provider_circuits_open_for_positive" CHECK ("open_for_ms" > 0),
  -- An open or half-open circuit knows when it opened and when it may be tried again.
  ADD CONSTRAINT "provider_circuits_open_consistent" CHECK (
    "state" = 'closed' OR ("opened_at" IS NOT NULL AND "retry_at" IS NOT NULL)),
  -- Only a half-open circuit has a trial job.
  ADD CONSTRAINT "provider_circuits_trial_consistent" CHECK (
    ("trial_job_id" IS NULL) = ("trial_started_at" IS NULL)
    AND ("trial_job_id" IS NULL OR "state" = 'half_open'));

ALTER TABLE "provider_circuit_events"
  ADD CONSTRAINT "provider_circuit_events_reason_known" CHECK ("reason" IN
    ('failures', 'trial', 'trial_failed', 'trial_succeeded', 'trial_expired', 'manual'));

-- A circuit is reset, never removed; its history is append-only.
CREATE TRIGGER provider_circuits_no_delete BEFORE DELETE ON "provider_circuits"
  FOR EACH ROW EXECUTE FUNCTION acf_ai_ledger_append_only();
CREATE TRIGGER provider_circuit_events_append_only BEFORE UPDATE OR DELETE ON "provider_circuit_events"
  FOR EACH ROW EXECUTE FUNCTION acf_ai_ledger_append_only();
