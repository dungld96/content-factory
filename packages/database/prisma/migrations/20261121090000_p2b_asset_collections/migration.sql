-- P2b L5: asset collections per project (design: docs/design/P2b-design-review-package.md §6).
-- CreateTable
CREATE TABLE "asset_collections" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "asset_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_collection_items" (
    "project_id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "added_by_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_collection_items_pkey" PRIMARY KEY ("collection_id","asset_id")
);

-- CreateIndex
CREATE INDEX "asset_collections_project_id_created_at_id_idx" ON "asset_collections"("project_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "asset_collections_created_by_id_idx" ON "asset_collections"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_collections_project_id_id_key" ON "asset_collections"("project_id", "id");

-- CreateIndex
CREATE INDEX "asset_collection_items_asset_id_idx" ON "asset_collection_items"("asset_id");

-- CreateIndex
CREATE INDEX "asset_collection_items_added_by_id_idx" ON "asset_collection_items"("added_by_id");

-- AddForeignKey
ALTER TABLE "asset_collections" ADD CONSTRAINT "asset_collections_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "asset_collections" ADD CONSTRAINT "asset_collections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "asset_collection_items" ADD CONSTRAINT "asset_collection_items_project_id_collection_id_fkey" FOREIGN KEY ("project_id", "collection_id") REFERENCES "asset_collections"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "asset_collection_items" ADD CONSTRAINT "asset_collection_items_project_id_asset_id_fkey" FOREIGN KEY ("project_id", "asset_id") REFERENCES "assets"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "asset_collection_items" ADD CONSTRAINT "asset_collection_items_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- ---------------------------------------------------------------- integrity layer

ALTER TABLE "asset_collections"
  ADD CONSTRAINT "asset_collections_name_nonempty" CHECK (length(btrim("name")) > 0);

-- Collections are archived, never deleted (items stay for history).
CREATE TRIGGER asset_collections_no_delete BEFORE DELETE ON "asset_collections"
  FOR EACH ROW EXECUTE FUNCTION acf_forbid_hard_delete();
