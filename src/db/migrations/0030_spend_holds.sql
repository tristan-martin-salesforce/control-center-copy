-- 0030 (holistic review 2026-11-20, 04 §4.3, H-5): the spend governor's holds (src/llm/spend). Additive: one row per
-- estimate → hold → ask → settle. Amounts, states and ids only; never content. No backfill.
CREATE TABLE "spend_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"job_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"estimate_p50" numeric(12, 6) DEFAULT 0 NOT NULL,
	"estimate_p90" numeric(12, 6) DEFAULT 0 NOT NULL,
	"estimate_basis" text DEFAULT 'default' NOT NULL,
	"held_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"spent_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"asked_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"answer_usd" numeric(12, 6),
	"budget_day" date NOT NULL,
	"budget" text DEFAULT 'daily' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"call_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "spend_holds_scope_chk" CHECK ("spend_holds"."scope" IN ('chat_message', 'scan_run', 'settle_pass', 'relay', 'research', 'feedback', 'job')),
	CONSTRAINT "spend_holds_state_chk" CHECK ("spend_holds"."state" IN ('open', 'asked', 'approved', 'denied', 'settled', 'abandoned')),
	CONSTRAINT "spend_holds_budget_chk" CHECK ("spend_holds"."budget" IN ('daily', 'first_scan'))
);
--> statement-breakpoint
ALTER TABLE "spend_holds" ADD CONSTRAINT "spend_holds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spend_holds_user_day_idx" ON "spend_holds" USING btree ("user_id","budget_day");--> statement-breakpoint
CREATE INDEX "spend_holds_open_idx" ON "spend_holds" USING btree ("user_id","state") WHERE "spend_holds"."state" IN ('open', 'asked', 'approved');--> statement-breakpoint
CREATE INDEX "spend_holds_job_key_idx" ON "spend_holds" USING btree ("user_id","job_key");