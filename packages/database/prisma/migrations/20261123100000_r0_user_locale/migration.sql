-- Redesign R-D6: the interface language a user chose (docs/design/R-redesign-package.md §5).
-- NULL follows the browser (Accept-Language).
ALTER TABLE "users" ADD COLUMN "locale" VARCHAR(8);
ALTER TABLE "users" ADD CONSTRAINT "users_locale_known" CHECK ("locale" IS NULL OR "locale" IN ('en', 'vi'));
