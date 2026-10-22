ALTER TABLE "preferences" ADD COLUMN "mascot" TEXT, ADD COLUMN "palette" TEXT;

ALTER TABLE "subscriptions"
  ADD COLUMN "scheduledChangeAction" TEXT,
  ADD COLUMN "scheduledChangeAt" TIMESTAMP(3),
  ADD COLUMN "scheduledResumeAt" TIMESTAMP(3),
  ADD COLUMN "priceAmount" INTEGER,
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "cardBrand" TEXT,
  ADD COLUMN "cardLast4" TEXT,
  ADD COLUMN "cardExpMonth" INTEGER,
  ADD COLUMN "cardExpYear" INTEGER,
  ADD COLUMN "declineReason" TEXT,
  ADD COLUMN "pastDueAmount" INTEGER,
  ADD COLUMN "pastDueCurrency" TEXT,
  ADD COLUMN "pastDueAt" TIMESTAMP(3),
  ADD COLUMN "scheduledPlan" TEXT,
  ADD COLUMN "cancelReason" TEXT,
  ADD COLUMN "cancelFeedback" TEXT,
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "trialEndingEmailSentAt" TIMESTAMP(3);
