-- P4d: voice-over on/off per content item, chosen before the voice-over stage. Off: no TTS jobs,
-- no TTS estimate or reservation, and renders use no voice-over. Existing items keep voice on.
ALTER TABLE "content_items" ADD COLUMN "voice_enabled" BOOLEAN NOT NULL DEFAULT true;
