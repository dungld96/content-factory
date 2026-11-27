-- M7 operations: an owner settling a held reservation records the charge the ledger could not
-- price (design: docs/design/M7-design-review-package.md §4, §8); it keeps counting as spent.

-- AlterTable
ALTER TABLE "budget_reservations" ADD COLUMN "settled_charge_usd" DECIMAL(14,6);

ALTER TABLE "budget_reservations"
  ADD CONSTRAINT "budget_reservations_settled_charge_consistent" CHECK (
    "settled_charge_usd" IS NULL OR ("status" = 'settled' AND "settled_charge_usd" >= 0));

-- As before, plus: the settled charge is set only when a held reservation is settled, then frozen.
CREATE OR REPLACE FUNCTION acf_budget_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'budget reservations are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.settled_charge_usd IS NOT NULL THEN
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
  IF NEW.settled_charge_usd IS DISTINCT FROM OLD.settled_charge_usd
     AND NOT (OLD.status = 'held' AND NEW.status = 'settled' AND OLD.settled_charge_usd IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011',
      MESSAGE = 'a settled charge is recorded only when a held reservation is settled';
  END IF;
  RETURN NEW;
END $$;
