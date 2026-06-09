-- AlterTable
ALTER TABLE "study_sessions" ALTER COLUMN "cardIds" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "revisitCardIds" SET DEFAULT ARRAY[]::TEXT[];
