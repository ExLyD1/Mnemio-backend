-- AlterTable
ALTER TABLE "user_achievements" ADD COLUMN     "notifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "user_achievements_userId_notifiedAt_idx" ON "user_achievements"("userId", "notifiedAt");
