-- Drafts and named versions (M1). drizzle-kit generated the ADD COLUMN statements; the backfill is
-- hand-written. The migrator runs every pending migration in one transaction, so a failure leaves
-- the database as it was. `draft_content` is added nullable, copied from `content`, then made NOT NULL.
ALTER TABLE "documents" ADD COLUMN "draft_content" text;--> statement-breakpoint
UPDATE "documents" SET "draft_content" = "content";--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "draft_content" SET NOT NULL;--> statement-breakpoint
-- Existing rows start at draft version 1, like new documents.
ALTER TABLE "documents" ADD COLUMN "draft_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "draft_base_revision" integer;--> statement-breakpoint
UPDATE "documents" SET "draft_base_revision" = "revision";--> statement-breakpoint
-- Version label, separate from the title. Existing revisions have none.
ALTER TABLE "revisions" ADD COLUMN "name" text;
