-- M7 budgets and reservations (design: docs/design/M7-design-review-package.md §3–§4). Generated
-- DDL first, then the integrity layer and the backfill of existing projects.

-- CreateEnum
CREATE TYPE "budget_mode" AS ENUM ('hard', 'soft');

-- CreateEnum
CREATE TYPE "reservation_kind" AS ENUM ('estimate', 'unknown_placeholder');

-- CreateEnum
CREATE TYPE "reservation_status" AS ENUM ('open', 'settled', 'released', 'held');

-- CreateTable
CREATE TABLE "project_budgets" (
    "project_id" UUID NOT NULL,
    "monthly_limit_usd" DECIMAL(14,6) NOT NULL,
    "monthly_mode" "budget_mode" NOT NULL DEFAULT 'hard',
    "item_limit_usd" DECIMAL(14,6),
    "item_mode" "budget_mode" NOT NULL DEFAULT 'soft',
    "request_limit_usd" DECIMAL(14,6),
    "request_mode" "budget_mode" NOT NULL DEFAULT 'hard',
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_budgets_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable
CREATE TABLE "budget_events" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "actor_id" UUID,
    "type" VARCHAR(16) NOT NULL,
    "detail" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_reservations" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "amount_usd" DECIMAL(14,6) NOT NULL,
    "kind" "reservation_kind" NOT NULL,
    "status" "reservation_status" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "budget_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_budgets_updated_by_id_idx" ON "project_budgets"("updated_by_id");

-- CreateIndex
CREATE INDEX "budget_events_project_id_created_at_idx" ON "budget_events"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "budget_events_actor_id_idx" ON "budget_events"("actor_id");

-- CreateIndex
CREATE INDEX "budget_reservations_project_id_status_created_at_idx" ON "budget_reservations"("project_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "budget_reservations_content_item_id_status_idx" ON "budget_reservations"("content_item_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "budget_reservations_job_id_key" ON "budget_reservations"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_reservations_project_id_job_id_key" ON "budget_reservations"("project_id", "job_id");

-- AddForeignKey
ALTER TABLE "project_budgets" ADD CONSTRAINT "project_budgets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_budgets" ADD CONSTRAINT "project_budgets_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "budget_events" ADD CONSTRAINT "budget_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "budget_events" ADD CONSTRAINT "budget_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_project_id_content_item_id_fkey" FOREIGN KEY ("project_id", "content_item_id") REFERENCES "content_items"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_project_id_job_id_fkey" FOREIGN KEY ("project_id", "job_id") REFERENCES "generation_jobs"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------- budgets

ALTER TABLE "project_budgets"
  ADD CONSTRAINT "project_budgets_monthly_nonnegative" CHECK ("monthly_limit_usd" >= 0),
  ADD CONSTRAINT "project_budgets_item_nonnegative" CHECK ("item_limit_usd" IS NULL OR "item_limit_usd" >= 0),
  ADD CONSTRAINT "project_budgets_request_nonnegative" CHECK ("request_limit_usd" IS NULL OR "request_limit_usd" >= 0);

ALTER TABLE "budget_events"
  ADD CONSTRAINT "budget_events_type_known" CHECK ("type" IN ('changed', 'override', 'blocked', 'settled', 'released')),
  ADD CONSTRAINT "budget_events_detail_object" CHECK (jsonb_typeof("detail") = 'object');

-- A project's budget is changed, never removed.
CREATE TRIGGER project_budgets_no_delete BEFORE DELETE ON "project_budgets"
  FOR EACH ROW EXECUTE FUNCTION acf_ai_ledger_append_only();
CREATE TRIGGER budget_events_append_only BEFORE UPDATE OR DELETE ON "budget_events"
  FOR EACH ROW EXECUTE FUNCTION acf_ai_ledger_append_only();

-- ---------------------------------------------------------------- reservations

ALTER TABLE "budget_reservations"
  ADD CONSTRAINT "budget_reservations_amount_nonnegative" CHECK ("amount_usd" >= 0),
  ADD CONSTRAINT "budget_reservations_resolved_consistent" CHECK (
    ("status" IN ('open', 'held')) = ("resolved_at" IS NULL));

-- What was reserved never changes; a reservation only moves forward:
-- open → settled | released | held, held → settled | released. Never deleted.
CREATE FUNCTION acf_budget_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'budget reservations are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'a reservation is created open';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.project_id, NEW.content_item_id, NEW.job_id, NEW.amount_usd, NEW.kind, NEW.created_at)
     IS DISTINCT FROM (OLD.project_id, OLD.content_item_id, OLD.job_id, OLD.amount_usd, OLD.kind, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'a reservation''s amount and job are immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('settled', 'released', 'held'))
    OR (OLD.status = 'held' AND NEW.status IN ('settled', 'released'))) THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011',
      MESSAGE = format('a reservation cannot move from %s to %s', OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER budget_reservations_guard BEFORE INSERT OR UPDATE OR DELETE ON "budget_reservations"
  FOR EACH ROW EXECUTE FUNCTION acf_budget_reservation_guard();

-- ---------------------------------------------------------------- backfill (B2 defaults)

INSERT INTO "project_budgets" ("project_id", "monthly_limit_usd", "monthly_mode", "item_limit_usd",
    "item_mode", "request_limit_usd", "request_mode", "updated_at")
  SELECT "id", 10, 'hard', 3, 'soft', 2, 'hard', now() FROM "projects"
  ON CONFLICT ("project_id") DO NOTHING;
