-- R0: content masters and variants (docs/design/M3.5-multiformat-architecture-review.md §3, §5;
-- ADR-0015). Additive only: no existing column is changed or dropped. Every existing content
-- item becomes the single variant of its own, newly created master (1:1 backfill).

-- CreateTable
CREATE TABLE "content_masters" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "brief" JSONB NOT NULL,
    "brief_revision" INTEGER NOT NULL DEFAULT 1,
    "language" VARCHAR(35) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_masters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_masters_project_id_created_at_id_idx" ON "content_masters"("project_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "content_masters_created_by_id_idx" ON "content_masters"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "content_masters_project_id_id_key" ON "content_masters"("project_id", "id");

-- AddForeignKey
ALTER TABLE "content_masters" ADD CONSTRAINT "content_masters_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "content_masters" ADD CONSTRAINT "content_masters_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AlterTable (content_master_id is nullable until the backfill below)
ALTER TABLE "content_items" ADD COLUMN     "content_master_id" UUID,
ADD COLUMN     "master_brief_revision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "target_platform" "channel_platform";

-- ---------------------------------------------------------------- backfill (1:1)

-- PostgreSQL 17 has no uuidv7(). This temporary function builds a UUIDv7 (RFC 9562) whose
-- timestamp is the content item's created_at, so backfilled masters order like the rows
-- Prisma creates (`uuid(7)`). It is dropped at the end of this migration.
CREATE FUNCTION acf_tmp_uuid_v7(ts timestamptz) RETURNS uuid LANGUAGE sql VOLATILE AS $$
  SELECT encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
              placing substring(int8send(floor(extract(epoch FROM ts) * 1000)::bigint) FROM 3)
              FROM 1 FOR 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;

-- Only content_master_id changes: no trigger on content_items fires for this column, and
-- updated_at is left as it was (it is maintained by the application, not the database).
UPDATE "content_items" SET "content_master_id" = acf_tmp_uuid_v7("created_at");

INSERT INTO "content_masters"
  ("id", "project_id", "title", "brief", "brief_revision", "language", "created_by_id",
   "archived_at", "created_at", "updated_at")
SELECT "content_master_id", "project_id", "title", "brief", 1, "language", "created_by_id",
       "archived_at", "created_at", "updated_at"
  FROM "content_items";

DROP FUNCTION acf_tmp_uuid_v7(timestamptz);

ALTER TABLE "content_items" ALTER COLUMN "content_master_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "content_items_content_master_id_idx" ON "content_items"("content_master_id");

-- AddForeignKey (composite: the master is in the variant's project)
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_project_id_content_master_id_fkey" FOREIGN KEY ("project_id", "content_master_id") REFERENCES "content_masters"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------- integrity

-- A variant with a channel takes the channel's platform; target_platform is only for variants
-- without a channel (owner decision, review §8). Storing it only then keeps it consistent when a
-- channel's platform is edited.
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_platform_xor_channel" CHECK ("channel_id" IS NULL OR "target_platform" IS NULL),
  ADD CONSTRAINT "content_items_master_brief_revision_positive" CHECK ("master_brief_revision" >= 1);

ALTER TABLE "content_masters"
  ADD CONSTRAINT "content_masters_brief_revision_positive" CHECK ("brief_revision" >= 1);

CREATE TRIGGER content_masters_no_delete BEFORE DELETE ON "content_masters" FOR EACH ROW EXECUTE FUNCTION acf_forbid_hard_delete();

-- A variant never moves to another master (AC014).
CREATE FUNCTION acf_content_master_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_master_id IS DISTINCT FROM OLD.content_master_id THEN
    RAISE EXCEPTION USING ERRCODE = 'AC014',
      MESSAGE = format('content item %s cannot move to another content master', OLD.id);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER content_items_master_link_guard
  BEFORE UPDATE OF content_master_id ON "content_items"
  FOR EACH ROW EXECUTE FUNCTION acf_content_master_link_guard();
