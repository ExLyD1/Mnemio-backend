-- AlterTable
ALTER TABLE "study_sessions" ADD COLUMN     "runId" TEXT;

-- CreateIndex
CREATE INDEX "study_sessions_userId_runId_idx" ON "study_sessions"("userId", "runId");
