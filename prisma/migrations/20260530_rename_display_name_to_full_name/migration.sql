-- Rename users.displayName to users.fullName to match the frontend integration contract.
ALTER TABLE "users" RENAME COLUMN "displayName" TO "fullName";
