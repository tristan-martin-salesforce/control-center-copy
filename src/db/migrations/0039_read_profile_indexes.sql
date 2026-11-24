-- 0039 (post-2.0 read profile, docs/reviews/2026-11-20-holistic/27-read-profile.md): every page that shows connectors
-- (Home, Today, Triage, Outbox, Deals, Work, Health, Getting started) counts today's source items per connector by
-- `first_seen_at`, which read every source item of the user: a seq scan that grows with a year of scans. Additive: one index.
CREATE INDEX "source_items_owner_first_seen_idx" ON "source_items" USING btree ("owner_user_id","first_seen_at");
