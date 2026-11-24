-- 0031 (2026-11-20 holistic review, lane 03 R4/R9): closure_checks, one row per resolution check (rules D1-D6, the
-- cheap model, the narrow escalation), shadow or live. Ids, codes, numbers and a pack digest only, never message text.
-- New table only; nothing existing changes.
CREATE TABLE "closure_checks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger" text NOT NULL,
	"mode" text NOT NULL,
	"status_before" text NOT NULL,
	"pack_digest" text NOT NULL,
	"pack_tokens" integer DEFAULT 0 NOT NULL,
	"pack_lines" integer DEFAULT 0 NOT NULL,
	"rules_fired" text[] DEFAULT '{}'::text[] NOT NULL,
	"rule_hit" text,
	"decided_by" text NOT NULL,
	"verdict" text,
	"basis" text,
	"confidence" numeric(4, 3),
	"cite_alias" text,
	"cite_source_item_id" uuid,
	"escalated" boolean DEFAULT false NOT NULL,
	"escalation_reason" text,
	"escalation_changed" boolean,
	"outcome" text NOT NULL,
	"blocked_by" text,
	"model" text,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"llm_call_id" bigint,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"engine_version" text NOT NULL,
	CONSTRAINT "closure_checks_outcome_chk" CHECK ("closure_checks"."outcome" IN ('closed', 'likely', 'asked', 'left', 'reopened')),
	CONSTRAINT "closure_checks_mode_chk" CHECK ("closure_checks"."mode" IN ('shadow', 'live')),
	CONSTRAINT "closure_checks_decided_by_chk" CHECK ("closure_checks"."decided_by" IN ('rule', 'model', 'escalation', 'skip', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "closure_checks" ADD CONSTRAINT "closure_checks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closure_checks" ADD CONSTRAINT "closure_checks_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closure_checks" ADD CONSTRAINT "closure_checks_cite_source_item_id_source_items_id_fk" FOREIGN KEY ("cite_source_item_id") REFERENCES "public"."source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closure_checks" ADD CONSTRAINT "closure_checks_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "closure_checks_item_at_idx" ON "closure_checks" USING btree ("owner_user_id","work_item_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "closure_checks_owner_at_idx" ON "closure_checks" USING btree ("owner_user_id","at" DESC NULLS LAST);