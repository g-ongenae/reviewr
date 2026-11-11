-- A document can be untitled (M1). drizzle-kit generated the DROP NOT NULL statements; the backfill is
-- hand-written. A revision snapshots the title, so it can be absent too. Titles that were left empty
-- or blank (the web Composer created documents with '') become NULL; nothing else is touched.
ALTER TABLE "documents" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "revisions" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint
UPDATE "documents" SET "title" = NULL WHERE "title" ~ '^[[:space:]]*$';--> statement-breakpoint
UPDATE "revisions" SET "title" = NULL WHERE "title" ~ '^[[:space:]]*$';
