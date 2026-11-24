-- 0034 (use-case candidates, holistic review 2026-11-20 lane 06 R6; src/engines/use-cases, src/db/schema/use-cases.ts).
--   use_case_candidates   the use cases the app noticed in notes, meetings, Slack and mail with a customer: source and
--                         evidence, the opp / account attribute() chose (confidence, why, the rundown's top 3 when
--                         unsure), the use case's words, status (suggested · edited · accepted · staged_org62 ·
--                         staged_vdp · landed · rejected with why), the Org62 / VDP ids once landed, the dedupe key.
--                         Audited: Accept / Edit / Reject are change sets (Undo restores it, with the VDP Outbox item
--                         and the learned rules written in the same change set). The trigram index serves the fuzzy
--                         dedupe (pg_trgm, 0000).
-- Additive only: one new table, its indexes, its audit trigger. Nothing existing changes.
CREATE TABLE "use_case_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_key" text NOT NULL,
	"account_id" uuid,
	"opportunity_id" uuid,
	"confidence" numeric(4, 3) DEFAULT '0' NOT NULL,
	"why" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"needs_pick" boolean DEFAULT false NOT NULL,
	"alternates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title" text NOT NULL,
	"problem" text DEFAULT '' NOT NULL,
	"products" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text DEFAULT '' NOT NULL,
	"track" text,
	"stage_hint" text,
	"status" text DEFAULT 'suggested' NOT NULL,
	"reject_reason" text,
	"basis" text DEFAULT 'rules' NOT NULL,
	"dedupe_key" text NOT NULL,
	"problem_key" text DEFAULT '' NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signal" jsonb,
	"matched_kind" text,
	"use_case_id" uuid,
	"org62_use_case_id" text,
	"vdp_use_case_id" text,
	"vdp_slug" text,
	"vdp_draft_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "use_case_candidates_status_chk" CHECK ("use_case_candidates"."status" IN ('suggested', 'accepted', 'edited', 'rejected', 'staged_org62', 'staged_vdp', 'landed')),
	CONSTRAINT "use_case_candidates_source_chk" CHECK ("use_case_candidates"."source" IN ('gemini_note', 'meeting', 'slack_burst', 'mail_thread', 'manual')),
	CONSTRAINT "use_case_candidates_reject_reason_chk" CHECK ("use_case_candidates"."reject_reason" IS NULL OR "use_case_candidates"."reject_reason" IN ('not_use_case', 'wrong_opp', 'duplicate', 'already_in_org62')),
	CONSTRAINT "use_case_candidates_track_chk" CHECK ("use_case_candidates"."track" IS NULL OR "use_case_candidates"."track" IN ('d360', 'agentforce'))
);
--> statement-breakpoint
ALTER TABLE "use_case_candidates" ADD CONSTRAINT "use_case_candidates_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "use_case_candidates" ADD CONSTRAINT "use_case_candidates_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "use_case_candidates" ADD CONSTRAINT "use_case_candidates_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "use_case_candidates_owner_dedupe_uidx" ON "use_case_candidates" USING btree ("owner_user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "use_case_candidates_owner_status_idx" ON "use_case_candidates" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "use_case_candidates_title_trgm_idx" ON "use_case_candidates" USING gin (lower("title") gin_trgm_ops);
--> statement-breakpoint
-- use_case_candidates is audited like dc_suggestions: its decisions are change sets (Undo restores the candidate).
CREATE TRIGGER use_case_candidates_audit_trg AFTER INSERT OR UPDATE OR DELETE ON use_case_candidates FOR EACH ROW EXECUTE FUNCTION cc_audit('use_case_candidates', 'id', '{}');