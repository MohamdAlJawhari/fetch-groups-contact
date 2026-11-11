-- Existing audit records retain a null target: their target cannot be inferred.
ALTER TABLE "audit_log" ADD COLUMN "target_user_id" UUID;

ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_target_user_id_fkey"
FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
