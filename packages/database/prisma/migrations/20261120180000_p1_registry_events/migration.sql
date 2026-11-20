-- P1 O6: append-only audit of AI registry changes (design: docs/design/P1-design-review-package.md §5).
-- CreateTable
CREATE TABLE "ai_registry_events" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "source" VARCHAR(8) NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "target" VARCHAR(300) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_registry_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_registry_events_created_at_id_idx" ON "ai_registry_events"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ai_registry_events_actor_id_idx" ON "ai_registry_events"("actor_id");

-- AddForeignKey
ALTER TABLE "ai_registry_events" ADD CONSTRAINT "ai_registry_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------- integrity layer

ALTER TABLE "ai_registry_events"
  ADD CONSTRAINT "ai_registry_events_source_known" CHECK ("source" IN ('api', 'cli')),
  -- API changes name their operator; the CLI has none.
  ADD CONSTRAINT "ai_registry_events_actor_matches_source" CHECK (("source" = 'api') = ("actor_id" IS NOT NULL)),
  ADD CONSTRAINT "ai_registry_events_action_known" CHECK ("action" IN
    ('provider_status', 'model_status', 'model_schema_mode', 'model_min_billed_seconds',
     'route_set', 'price_added', 'model_imported'));

CREATE TRIGGER ai_registry_events_append_only BEFORE UPDATE OR DELETE ON "ai_registry_events"
  FOR EACH ROW EXECUTE FUNCTION acf_ai_ledger_append_only();
