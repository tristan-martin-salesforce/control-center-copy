-- 0032 (attribution engine, holistic review 2026-11-20 lane 06 R2-R5; src/engines/attribution, src/db/schema/attribution.ts).
--   mapping_rules         two new kinds (a contact's email -> account, a distinctive word -> opportunity) and miss_count /
--                         last_miss_at: the table existed since 0001 with no reader and no writer; the engine reads it first
--                         and every correction writes it (conflicting rules decay: replaced once misses reach hits).
--   opp_engagement        per opp x ISO week: what I did on it (derived; the nightly job rebuilds it). Not audited.
--   dc_suggestions        the DCs the app suggests claiming, decided by the user (audited: Accept / Edit / Reject undo).
--   attribution_outcomes  the accept-rate log of every suggestion decision (append-only, not audited).
-- Additive only: two enum values (Postgres 12+ allows ADD VALUE in the migration transaction; nothing here uses them),
-- two columns with defaults, three new tables. Nothing existing changes.
ALTER TYPE "public"."mapping_rule_kind" ADD VALUE IF NOT EXISTS 'person_to_account';--> statement-breakpoint
ALTER TYPE "public"."mapping_rule_kind" ADD VALUE IF NOT EXISTS 'keyword_to_opportunity';--> statement-breakpoint
CREATE TABLE "attribution_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"outcome" text NOT NULL,
	"basis" text,
	"top_reason" text,
	"shown_confidence" numeric(4, 3),
	"shown_target" text,
	"chosen_target" text,
	"rule_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attribution_outcomes_outcome_chk" CHECK ("attribution_outcomes"."outcome" IN ('accept', 'edit', 'reject'))
);
--> statement-breakpoint
CREATE TABLE "dc_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"quarter" text NOT NULL,
	"group_key" text NOT NULL,
	"state" text DEFAULT 'new' NOT NULL,
	"share_percent" integer DEFAULT 100 NOT NULL,
	"split_percent" integer,
	"pre_ticked" boolean DEFAULT false NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"covered_ae" text,
	"baseline" jsonb,
	"dc_request_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dc_suggestions_state_chk" CHECK ("dc_suggestions"."state" IN ('new', 'accepted', 'edited', 'rejected', 'closed', 'stale', 'resolved'))
);
--> statement-breakpoint
CREATE TABLE "opp_engagement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"meetings" numeric(8, 2) DEFAULT '0' NOT NULL,
	"external_meetings" numeric(8, 2) DEFAULT '0' NOT NULL,
	"slack_lines" numeric(10, 2) DEFAULT '0' NOT NULL,
	"mail_threads" numeric(8, 2) DEFAULT '0' NOT NULL,
	"docs_touched" numeric(8, 2) DEFAULT '0' NOT NULL,
	"sessions" numeric(8, 2) DEFAULT '0' NOT NULL,
	"notes" numeric(8, 2) DEFAULT '0' NOT NULL,
	"hours_logged" numeric(8, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(10, 2) DEFAULT '0' NOT NULL,
	"last_touch_at" timestamp with time zone,
	"source_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mapping_rules" ADD COLUMN "miss_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mapping_rules" ADD COLUMN "last_miss_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attribution_outcomes" ADD CONSTRAINT "attribution_outcomes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dc_suggestions" ADD CONSTRAINT "dc_suggestions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dc_suggestions" ADD CONSTRAINT "dc_suggestions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opp_engagement" ADD CONSTRAINT "opp_engagement_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opp_engagement" ADD CONSTRAINT "opp_engagement_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attribution_outcomes_owner_created_idx" ON "attribution_outcomes" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dc_suggestions_owner_opp_quarter_uidx" ON "dc_suggestions" USING btree ("owner_user_id","opportunity_id","quarter");--> statement-breakpoint
CREATE INDEX "dc_suggestions_owner_state_idx" ON "dc_suggestions" USING btree ("owner_user_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "opp_engagement_owner_opp_week_uidx" ON "opp_engagement" USING btree ("owner_user_id","opportunity_id","week_start");--> statement-breakpoint
CREATE INDEX "opp_engagement_owner_week_idx" ON "opp_engagement" USING btree ("owner_user_id","week_start");
--> statement-breakpoint
-- dc_suggestions is audited like deal_contribution_requests: its decisions are change sets (Undo restores the suggestion).
CREATE TRIGGER dc_suggestions_audit_trg AFTER INSERT OR UPDATE OR DELETE ON dc_suggestions FOR EACH ROW EXECUTE FUNCTION cc_audit('dc_suggestions', 'id', '{}');--> statement-breakpoint
-- opp_engagement is bulk-written by the worker: one notice per statement (no ids; Time refetches by topic, as 0026 does for the mirrors).
CREATE TRIGGER opp_engagement_live_stmt_trg AFTER INSERT OR UPDATE OR DELETE ON opp_engagement FOR EACH STATEMENT EXECUTE FUNCTION cc_live_notify_stmt();
