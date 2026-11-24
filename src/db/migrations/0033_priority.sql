-- 0033 (holistic review 2026-11-20, lane 07 R8 / H-8, priority@2): additive only, no backfill.
-- priority_feedback: append-only, every manual reorder, snooze, "not today", pin and "do first" with the ranking's terms at
-- the time (ids and numbers only). priority_rules: mapping_rules-style learning rules (a bounded persona weight nudge)
-- the nightly priority.feedback job suggests and the user applies in Health. priority_runs: each run records both
-- rankings in shadow (ranking, shadow_engine_version, shadow_ranking, agreement3). priority_scores: value, urgency and
-- terms for priority@2 rows (the component columns stay null for them).
CREATE TABLE "priority_feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_rank" integer,
	"to_rank" integer,
	"engine_version" text NOT NULL,
	"run_id" bigint,
	"terms" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "priority_feedback_action_chk" CHECK ("priority_feedback"."action" in ('reorder', 'snooze', 'not_today', 'pin', 'do_first'))
);
--> statement-breakpoint
CREATE TABLE "priority_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"rule_key" text NOT NULL,
	"term" text NOT NULL,
	"target" text NOT NULL,
	"direction" smallint NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"pairs" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "priority_rules_status_chk" CHECK ("priority_rules"."status" in ('suggested', 'applied', 'dismissed')),
	CONSTRAINT "priority_rules_direction_chk" CHECK ("priority_rules"."direction" in (-1, 1)),
	CONSTRAINT "priority_rules_target_chk" CHECK ("priority_rules"."target" in ('who', 'deal', 'kind', 'importance', 'goal', 'urgencyFloor'))
);
--> statement-breakpoint
ALTER TABLE "priority_runs" ADD COLUMN "ranking" jsonb;--> statement-breakpoint
ALTER TABLE "priority_runs" ADD COLUMN "shadow_engine_version" text;--> statement-breakpoint
ALTER TABLE "priority_runs" ADD COLUMN "shadow_ranking" jsonb;--> statement-breakpoint
ALTER TABLE "priority_runs" ADD COLUMN "agreement3" numeric(4, 2);--> statement-breakpoint
ALTER TABLE "priority_scores" ADD COLUMN "value" numeric(7, 3);--> statement-breakpoint
ALTER TABLE "priority_scores" ADD COLUMN "urgency" numeric(5, 3);--> statement-breakpoint
ALTER TABLE "priority_scores" ADD COLUMN "terms" jsonb;--> statement-breakpoint
ALTER TABLE "priority_feedback" ADD CONSTRAINT "priority_feedback_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_feedback" ADD CONSTRAINT "priority_feedback_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_feedback" ADD CONSTRAINT "priority_feedback_run_id_priority_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."priority_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_rules" ADD CONSTRAINT "priority_rules_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "priority_feedback_owner_created_idx" ON "priority_feedback" USING btree ("owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "priority_rules_owner_status_idx" ON "priority_rules" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "priority_rules_owner_key_suggested_uidx" ON "priority_rules" USING btree ("owner_user_id","rule_key") WHERE "priority_rules"."status" = 'suggested';