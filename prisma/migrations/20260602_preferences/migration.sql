-- Preferences (P1.4): replaces FE stores/preferences.ts (localStorage).
-- 1:1 with User; lazily created on first GET/PATCH.

CREATE TABLE "preferences" (
    "userId"            TEXT NOT NULL,
    "interests"         TEXT[] NOT NULL DEFAULT '{}',
    "goal"              TEXT,
    "nativeLanguage"    TEXT,
    "learningLanguages" TEXT[] NOT NULL DEFAULT '{}',
    "avatarHue"         INTEGER,
    "mimiPlacement"     TEXT,
    "favorites"         TEXT[] NOT NULL DEFAULT '{}',
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,
    CONSTRAINT "preferences_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "preferences"
    ADD CONSTRAINT "preferences_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
