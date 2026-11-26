-- Deleting a user (T52, the user's decision 2026-11-26): the row stays, so audit history keeps pointing to it.
-- On delete, the email moves to "deleted_email" and "email" gets a placeholder, which frees the address for a new account.
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "users" ADD COLUMN "deleted_email" VARCHAR(255);

-- A deleted account is always inactive and keeps its original email; a live one has neither field.
ALTER TABLE "users" ADD CONSTRAINT "users_deleted_check" CHECK (
  ("deleted_at" IS NULL AND "deleted_email" IS NULL)
  OR ("deleted_at" IS NOT NULL AND "deleted_email" IS NOT NULL AND "is_active" = false)
);
