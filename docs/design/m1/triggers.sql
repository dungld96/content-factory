-- =============================================================================
-- AI Content Factory — M1 integrity constraints and triggers (PROPOSAL)
-- Appended to the initial Prisma migration (prisma migrate dev --create-only).
-- Prisma does not model CHECK constraints, functions or triggers and does not drop them.
--
-- Custom SQLSTATEs (class "AC") let the API map trigger failures to stable error codes:
--   AC001 approved version is immutable          AC002 approved version links are frozen
--   AC003 invalid master pointer change          AC004 approval without master update
--   AC005 asset file identity is immutable       AC006 hard delete forbidden (archive instead)
--   AC007 project must keep at least one owner   AC008 asset in use by an approved version
--   AC009 versions must be created as drafts
-- Isolation: triggers are correct under READ COMMITTED (default) and SERIALIZABLE.
-- =============================================================================

-- ---------------------------------------------------------------- CHECK constraints

ALTER TABLE "character_versions"
  ADD CONSTRAINT "character_versions_version_positive" CHECK ("version" >= 1),
  ADD CONSTRAINT "character_versions_approval_consistent" CHECK (
    ("status" = 'approved' AND "approved_at" IS NOT NULL AND "approved_by_id" IS NOT NULL)
    OR ("status" = 'draft' AND "approved_at" IS NULL AND "approved_by_id" IS NULL)),
  ADD CONSTRAINT "character_versions_not_based_on_self" CHECK ("based_on_version_id" IS DISTINCT FROM "id");

ALTER TABLE "environment_versions"
  ADD CONSTRAINT "environment_versions_version_positive" CHECK ("version" >= 1),
  ADD CONSTRAINT "environment_versions_approval_consistent" CHECK (
    ("status" = 'approved' AND "approved_at" IS NOT NULL AND "approved_by_id" IS NOT NULL)
    OR ("status" = 'draft' AND "approved_at" IS NULL AND "approved_by_id" IS NULL)),
  ADD CONSTRAINT "environment_versions_not_based_on_self" CHECK ("based_on_version_id" IS DISTINCT FROM "id");

ALTER TABLE "assets"
  ADD CONSTRAINT "assets_size_nonnegative" CHECK ("size_bytes" >= 0),
  ADD CONSTRAINT "assets_checksum_format" CHECK ("checksum_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "assets_dimensions_positive" CHECK (("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0)),
  ADD CONSTRAINT "assets_duration_nonnegative" CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0),
  ADD CONSTRAINT "assets_not_own_source" CHECK ("source_asset_id" IS DISTINCT FROM "id"),
  ADD CONSTRAINT "assets_derived_has_source" CHECK ("source_type" <> 'derived' OR "source_asset_id" IS NOT NULL),
  ADD CONSTRAINT "assets_storage_key_nonempty" CHECK (length("storage_key") > 0);

ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_duration_range" CHECK ("target_duration_seconds" BETWEEN 1 AND 600);

ALTER TABLE "users"
  ADD CONSTRAINT "users_email_normalized" CHECK ("email" = lower(btrim("email")) AND position('@' IN "email") > 1);

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_id_hash_len" CHECK (octet_length("id_hash") = 32),
  ADD CONSTRAINT "sessions_expiry_order" CHECK ("expires_at" <= "absolute_expires_at");

-- ---------------------------------------------------------------- archive-only tables

CREATE FUNCTION acf_forbid_hard_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'AC006',
    MESSAGE = format('%s rows cannot be deleted; archive them instead', TG_TABLE_NAME);
END $$;

CREATE TRIGGER projects_no_delete      BEFORE DELETE ON "projects"      FOR EACH ROW EXECUTE FUNCTION acf_forbid_hard_delete();
CREATE TRIGGER channels_no_delete      BEFORE DELETE ON "channels"      FOR EACH ROW EXECUTE FUNCTION acf_forbid_hard_delete();
CREATE TRIGGER characters_no_delete    BEFORE DELETE ON "characters"    FOR EACH ROW EXECUTE FUNCTION acf_forbid_hard_delete();
CREATE TRIGGER environments_no_delete  BEFORE DELETE ON "environments"  FOR EACH ROW EXECUTE FUNCTION acf_forbid_hard_delete();
CREATE TRIGGER assets_no_delete        BEFORE DELETE ON "assets"        FOR EACH ROW EXECUTE FUNCTION acf_forbid_hard_delete();
CREATE TRIGGER content_items_no_delete BEFORE DELETE ON "content_items" FOR EACH ROW EXECUTE FUNCTION acf_forbid_hard_delete();

-- ---------------------------------------------------------------- versions

-- Versions are always born as drafts; approval is an UPDATE (so it goes through the
-- master-pointer checks below). Approved rows are frozen: no UPDATE, no DELETE.
-- Identity columns of drafts cannot change either.
CREATE FUNCTION acf_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  frozen_keys text[] := ARRAY['id','project_id','character_id','environment_id','version',
                              'based_on_version_id','created_by_id','created_at'];
  k text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION USING ERRCODE = 'AC009', MESSAGE = 'versions must be created as drafts';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC001',
      MESSAGE = format('%s %s is approved and immutable', TG_TABLE_NAME, OLD.id);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;  -- drafts may be discarded
  END IF;

  FOREACH k IN ARRAY frozen_keys LOOP
    IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION USING ERRCODE = 'AC001', MESSAGE = format('column %s of a version is immutable', k);
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER character_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON "character_versions"
  FOR EACH ROW EXECUTE FUNCTION acf_version_guard();
CREATE TRIGGER environment_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON "environment_versions"
  FOR EACH ROW EXECUTE FUNCTION acf_version_guard();

-- Asset links of an approved version are frozen. The parent version row is read FOR SHARE,
-- which waits for an in-flight approval (which holds FOR UPDATE) and then sees its result.
-- TG_ARGV[0] = version table, TG_ARGV[1] = FK column in the link table.
CREATE FUNCTION acf_version_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) -> TG_ARGV[1]) IS DISTINCT FROM (to_jsonb(OLD) -> TG_ARGV[1])
       OR NEW.asset_id IS DISTINCT FROM OLD.asset_id OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
      RAISE EXCEPTION USING ERRCODE = 'AC002', MESSAGE = 'link keys are immutable; delete and re-add instead';
    END IF;
  END IF;

  v_id := ((to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)) ->> TG_ARGV[1])::uuid;
  EXECUTE format('SELECT status::text FROM %I WHERE id = $1 FOR SHARE', TG_ARGV[0]) INTO v_status USING v_id;

  IF v_status = 'approved' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC002',
      MESSAGE = format('asset links of approved %s %s are frozen', TG_ARGV[0], v_id);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER character_version_assets_guard BEFORE INSERT OR UPDATE OR DELETE ON "character_version_assets"
  FOR EACH ROW EXECUTE FUNCTION acf_version_link_guard('character_versions', 'character_version_id');
CREATE TRIGGER environment_version_assets_guard BEFORE INSERT OR UPDATE OR DELETE ON "environment_version_assets"
  FOR EACH ROW EXECUTE FUNCTION acf_version_link_guard('environment_versions', 'environment_version_id');

-- ---------------------------------------------------------------- master pointer

-- The master pointer may only move forward to an approved version with a higher number.
-- It can never be cleared. (Same-parent is guaranteed by the composite FK.)
-- TG_ARGV[0] = version table.
CREATE FUNCTION acf_master_pointer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  new_status text; new_num int; old_num int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.master_version_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'AC003', MESSAGE = 'master_version_id must be NULL on insert';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.master_version_id IS NOT DISTINCT FROM OLD.master_version_id THEN
    RETURN NEW;
  END IF;
  IF NEW.master_version_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'AC003', MESSAGE = 'master version cannot be cleared';
  END IF;

  EXECUTE format('SELECT status::text, version FROM %I WHERE id = $1', TG_ARGV[0])
    INTO new_status, new_num USING NEW.master_version_id;
  IF new_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC003', MESSAGE = 'master must point to an approved version';
  END IF;

  IF OLD.master_version_id IS NOT NULL THEN
    EXECUTE format('SELECT version FROM %I WHERE id = $1', TG_ARGV[0]) INTO old_num USING OLD.master_version_id;
    IF new_num <= old_num THEN
      RAISE EXCEPTION USING ERRCODE = 'AC003',
        MESSAGE = format('master can only move forward (v%s -> v%s rejected)', old_num, new_num);
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER characters_master_guard BEFORE INSERT OR UPDATE ON "characters"
  FOR EACH ROW EXECUTE FUNCTION acf_master_pointer_guard('character_versions');
CREATE TRIGGER environments_master_guard BEFORE INSERT OR UPDATE ON "environments"
  FOR EACH ROW EXECUTE FUNCTION acf_master_pointer_guard('environment_versions');

-- Atomicity: a version approved in a transaction must be the parent's master when that
-- transaction commits. Deferred, so the service can update the version and then the pointer.
-- TG_ARGV[0] = parent table, TG_ARGV[1] = parent FK column on the version.
CREATE FUNCTION acf_approval_sets_master() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_master uuid;
BEGIN
  IF NEW.status = 'approved' AND OLD.status = 'draft' THEN
    EXECUTE format('SELECT master_version_id FROM %I WHERE id = $1', TG_ARGV[0])
      INTO current_master USING ((to_jsonb(NEW) ->> TG_ARGV[1])::uuid);
    IF current_master IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION USING ERRCODE = 'AC004',
        MESSAGE = format('approving %s %s must also make it the master in the same transaction', TG_TABLE_NAME, NEW.id);
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER character_versions_approval_sets_master
  AFTER UPDATE OF status ON "character_versions" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION acf_approval_sets_master('characters', 'character_id');
CREATE CONSTRAINT TRIGGER environment_versions_approval_sets_master
  AFTER UPDATE OF status ON "environment_versions" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION acf_approval_sets_master('environments', 'environment_id');

-- ---------------------------------------------------------------- assets

-- File identity and provenance are immutable. Archiving an asset that an approved
-- version references is forbidden.
CREATE FUNCTION acf_asset_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  frozen_keys text[] := ARRAY['id','project_id','content_item_id','asset_type','source_type',
    'source_asset_id','source_note','storage_key','mime_type','size_bytes','checksum_sha256',
    'width','height','duration_ms','original_filename','created_by_id','created_at'];
  k text;
BEGIN
  FOREACH k IN ARRAY frozen_keys LOOP
    IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION USING ERRCODE = 'AC005', MESSAGE = format('asset column %s is immutable', k);
    END IF;
  END LOOP;

  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL AND (
       EXISTS (SELECT 1 FROM character_versions   WHERE primary_asset_id = NEW.id AND status = 'approved')
    OR EXISTS (SELECT 1 FROM environment_versions WHERE primary_asset_id = NEW.id AND status = 'approved')
    OR EXISTS (SELECT 1 FROM character_version_assets l JOIN character_versions v ON v.id = l.character_version_id
               WHERE l.asset_id = NEW.id AND v.status = 'approved')
    OR EXISTS (SELECT 1 FROM environment_version_assets l JOIN environment_versions v ON v.id = l.environment_version_id
               WHERE l.asset_id = NEW.id AND v.status = 'approved')) THEN
    RAISE EXCEPTION USING ERRCODE = 'AC008', MESSAGE = 'asset is referenced by an approved version and cannot be archived';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER assets_guard BEFORE UPDATE ON "assets" FOR EACH ROW EXECUTE FUNCTION acf_asset_guard();

-- ---------------------------------------------------------------- last owner

-- At commit, every affected project must still have >= 1 owner.
-- 1) Lock the project row: concurrent owner changes for the same project serialize here.
-- 2) Lock the remaining owner rows FOR UPDATE: under READ COMMITTED this re-reads the latest
--    committed rows; under REPEATABLE READ / SERIALIZABLE a row changed by a concurrent
--    committed transaction raises a serialization failure (40001) instead of passing on a
--    stale snapshot (verified: without step 2, REPEATABLE READ can leave zero owners).
CREATE FUNCTION acf_assert_project_has_owner(pid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  owners int;
BEGIN
  PERFORM 1 FROM projects WHERE id = pid FOR NO KEY UPDATE;
  SELECT count(*) INTO owners FROM (
    SELECT 1 FROM project_members WHERE project_id = pid AND role = 'owner' FOR UPDATE) o;
  IF owners = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'AC007', MESSAGE = format('project %s must keep at least one owner', pid);
  END IF;
END $$;

CREATE FUNCTION acf_member_change_keeps_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM acf_assert_project_has_owner(OLD.project_id);
  RETURN NULL;
END $$;

CREATE FUNCTION acf_project_created_with_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM acf_assert_project_has_owner(NEW.id);
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER project_members_keep_owner
  AFTER UPDATE OR DELETE ON "project_members" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.role = 'owner')
  EXECUTE FUNCTION acf_member_change_keeps_owner();
CREATE CONSTRAINT TRIGGER projects_created_with_owner
  AFTER INSERT ON "projects" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION acf_project_created_with_owner();
