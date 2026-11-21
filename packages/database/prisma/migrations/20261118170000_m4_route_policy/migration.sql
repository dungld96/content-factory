-- M4d: zero data retention per task route (M4 design decision G9).
-- AlterTable
ALTER TABLE "ai_task_routes" ADD COLUMN     "zero_data_retention" BOOLEAN NOT NULL DEFAULT false;

