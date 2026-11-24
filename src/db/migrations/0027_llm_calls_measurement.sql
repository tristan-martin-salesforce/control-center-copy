-- 0027 (holistic review 2026-11-20, lane 04 §4.5, COST-12): measure before the scanning redesign. Additive and
-- nullable: rows from before this migration keep every new column null (the report says "not measured"). Per call:
-- the first and the largest request's prompt tokens and how many requests passed the model's long-prompt tier
-- (Haiku 5.5 > 100K, 5x price), model requests (turns), tools loaded and their schema tokens, a hash of everything
-- before the cache boundary (prefix identity), items in / settled by rules / out (proposed + linked), and for a
-- stronger-model escalation the cheaper call it re-did and how many verdicts it changed (D4). Counts, ids and hashes
-- only; never content. No backfill.
ALTER TABLE "llm_calls" ADD COLUMN "first_prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "max_prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "long_tier_requests" integer;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "turns" integer;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "tool_count" integer;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "tool_schema_tokens" integer;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "prefix_hash" text;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "items_in" integer;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "items_decided_by_rules" integer;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "items_out" integer;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "escalated_from_call_id" bigint;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "escalation_changed_items" integer;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_escalated_from_call_id_llm_calls_id_fk" FOREIGN KEY ("escalated_from_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE set null ON UPDATE no action;
