-- 0037 (post-2.0 Home SQL, docs/reviews/2026-11-20-holistic/15-page-reads.md): Home, Today, Time ▸ Log it and Deals
-- read the logging canvases (the DC and use-case holds) by `payload ->> 'action' = 'slack_canvas.create'`, which read
-- every one of the owner's drafts and its payload. A partial index finds the canvases alone. Additive: one index.
CREATE INDEX "drafts_owner_canvas_idx" ON "drafts" USING btree ("owner_user_id") WHERE "drafts"."payload" ->> 'action' = 'slack_canvas.create';
