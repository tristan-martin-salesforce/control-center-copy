-- 0029 (2026-11-20 holistic review, lane 03 R13 / SCN-13): one form for Drive file refs.
-- Slack and the scanner agents wrote `drive:<ID>`; the store kept a ref as `drive_file` only when it was a bare id, so
-- `drive:<ID>` landed as kind `url` and every "same file" join on `kind = 'drive_file'` (workItemsByFile, the Drive
-- digest) missed it. New rows are normalized at write (src/scanner/store-db.ts upsertItem, normDriveRef); this fixes the
-- old ones. Idempotent and dupe-safe: the bare-id twin is inserted with ON CONFLICT DO NOTHING (the unique index is
-- (source_item_id, kind, value)), then the `drive:` form is removed. A second run finds nothing to do.
INSERT INTO "source_item_refs" ("source_item_id", "kind", "value", "created_at")
SELECT "source_item_id", 'drive_file', substr("value", 7), "created_at"
  FROM "source_item_refs"
 WHERE "value" LIKE 'drive:%' AND substr("value", 7) ~ '^[A-Za-z0-9_-]{15,}$'
ON CONFLICT ("source_item_id", "kind", "value") DO NOTHING;--> statement-breakpoint
DELETE FROM "source_item_refs"
 WHERE "value" LIKE 'drive:%' AND substr("value", 7) ~ '^[A-Za-z0-9_-]{15,}$';
