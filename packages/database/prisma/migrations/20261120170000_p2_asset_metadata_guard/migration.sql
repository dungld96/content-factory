-- P2a A2: the asset metadata keys the platform writes are immutable
-- (design: docs/design/P2a-design-review-package.md §3). No table change: the key list and the
-- asset guard are replaced. The list equals SYSTEM_METADATA_KEYS
-- (packages/content-domain/src/assets.ts); a database test keeps them equal.

CREATE FUNCTION acf_system_metadata_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['purpose','sceneHash','clipHash','voiceoverHash','model','audio','video',
    'requestedSeconds','resolution','voice','language','characters','exceedsScene','renderId',
    'upscaledFrom','cues','thumbnail']
$$;

CREATE OR REPLACE FUNCTION acf_asset_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  frozen_keys text[] := ARRAY['id','project_id','content_item_id','asset_type','source_type',
    'source_asset_id','source_note','storage_key','mime_type','size_bytes','checksum_sha256',
    'width','height','duration_ms','original_filename','created_by_id','created_at',
    'generation_job_id','storyboard_scene_id'];
  k text;
BEGIN
  FOREACH k IN ARRAY frozen_keys LOOP
    IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION USING ERRCODE = 'AC005', MESSAGE = format('asset column %s is immutable', k);
    END IF;
  END LOOP;

  -- P2a A2: reserved metadata keys keep the value written at insert (also: never removed).
  FOREACH k IN ARRAY acf_system_metadata_keys() LOOP
    IF (NEW.metadata -> k) IS DISTINCT FROM (OLD.metadata -> k) THEN
      RAISE EXCEPTION USING ERRCODE = 'AC005', MESSAGE = format('asset metadata key %s is immutable', k);
    END IF;
  END LOOP;

  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
    IF EXISTS (SELECT 1 FROM character_versions   WHERE primary_asset_id = NEW.id AND status = 'approved')
    OR EXISTS (SELECT 1 FROM environment_versions WHERE primary_asset_id = NEW.id AND status = 'approved')
    OR EXISTS (SELECT 1 FROM character_version_assets l JOIN character_versions v ON v.id = l.character_version_id
               WHERE l.asset_id = NEW.id AND v.status = 'approved')
    OR EXISTS (SELECT 1 FROM environment_version_assets l JOIN environment_versions v ON v.id = l.environment_version_id
               WHERE l.asset_id = NEW.id AND v.status = 'approved') THEN
      RAISE EXCEPTION USING ERRCODE = 'AC008', MESSAGE = 'asset is referenced by an approved version and cannot be archived';
    END IF;
    IF EXISTS (SELECT 1 FROM scene_keyframes WHERE asset_id = NEW.id) THEN
      RAISE EXCEPTION USING ERRCODE = 'AC008', MESSAGE = 'asset is a scene keyframe and cannot be archived';
    END IF;
    IF EXISTS (SELECT 1 FROM scene_clips WHERE asset_id = NEW.id)
    OR EXISTS (SELECT 1 FROM scene_voiceovers WHERE asset_id = NEW.id) THEN
      RAISE EXCEPTION USING ERRCODE = 'AC008', MESSAGE = 'asset is a selected scene clip or voice-over and cannot be archived';
    END IF;
  END IF;

  IF OLD.approval_status = 'approved' AND NEW.approval_status <> 'approved' THEN
    IF EXISTS (SELECT 1 FROM scene_keyframes WHERE asset_id = NEW.id) THEN
      RAISE EXCEPTION USING ERRCODE = 'AC015', MESSAGE = 'a scene keyframe must stay approved';
    END IF;
    IF EXISTS (SELECT 1 FROM scene_clips WHERE asset_id = NEW.id)
    OR EXISTS (SELECT 1 FROM scene_voiceovers WHERE asset_id = NEW.id) THEN
      RAISE EXCEPTION USING ERRCODE = 'AC016', MESSAGE = 'a selected scene clip or voice-over must stay approved';
    END IF;
  END IF;
  RETURN NEW;
END $$;
