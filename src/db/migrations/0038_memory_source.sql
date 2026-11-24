-- 0038 (SEC-8, docs/reviews/2026-11-20-holistic/17-security-review.md): chat_memory.source_message_id, the user message
-- the turn that kept a note or preference answered, so Settings ▸ Assistant shows its source exactly instead of the
-- latest message by time. Nullable, no foreign key (a deleted message reads as gone, not as a guess); rows written
-- before 0038 keep the time-based fallback. Additive: one column, no index (the read looks messages up by their key).
ALTER TABLE "chat_memory" ADD COLUMN "source_message_id" uuid;
