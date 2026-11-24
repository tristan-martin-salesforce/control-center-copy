-- 0036 (D-98, holistic review 2026-11-20 lane 09 R1/R3/R4/R5; docs/DATA-MIGRATIONS.md): the kv side-car → columns.
--   Columns  business state that lived in `user_settings` `cc.ext/<table>/<id>`: accounts.dc_status / org62_url;
--            opportunities.dc_assigned / next_step / products / owner_person_id / left_book_at;
--            activity_entries.log_note / log_note_basis; work_items.start_by_user / dismissed.
--   Tables   need_decisions (was `cc.need/<rule>/<subject>`), canvas_row_overrides (was `canvas.row_overrides`),
--            data_backfills (the kv.backfill job's progress); the VDP mirror's children vdp_use_cases, vdp_assets,
--            vdp_members, vdp_use_case_phases (were only `vdp_records.detail`) and mirror_reads (one row per read).
--   id15     generated `*_id15` columns (`left(id, 15)`, stored) beside every Org62 id that is joined to a 15-character
--            one, indexed where the matchers look them up.
-- Additive only: new nullable columns (dc_assigned defaults false), new tables, indexes, two audit triggers. No data
-- moves here: the `kv.backfill` job copies the side-car into the columns in chunks after migrate (D-96), and readers
-- fall back to the kv until it reports done. The kv keys and `vdp_records.detail` are dropped by a later migration.
CREATE TABLE "canvas_row_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"row_key" text NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"edited_at" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_backfills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_backfills_state_chk" CHECK ("data_backfills"."state" IN ('pending', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "need_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"subject_id" text NOT NULL,
	"kind" text NOT NULL,
	"until" timestamp with time zone,
	"reason" text,
	"label" text,
	"baseline" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mirror_reads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"scope" text NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	"rows" integer DEFAULT 0 NOT NULL,
	"complete" boolean DEFAULT false NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vdp_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"vdp_record_id" uuid NOT NULL,
	"vdp_asset_id" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"title" text,
	"url" text NOT NULL,
	"type" text,
	"description" text,
	"deliverable_type" text,
	"deliverable_read" boolean DEFAULT false NOT NULL,
	"mirrored_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vdp_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"vdp_record_id" uuid NOT NULL,
	"role" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"email" text,
	"name" text,
	"placeholder" boolean DEFAULT false NOT NULL,
	"mirrored_at" timestamp with time zone NOT NULL,
	CONSTRAINT "vdp_members_role_chk" CHECK ("vdp_members"."role" IN ('ae', 'ta', 'collaborator', 'creator'))
);
--> statement-breakpoint
CREATE TABLE "vdp_use_case_phases" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"vdp_record_id" uuid NOT NULL,
	"vdp_use_case_id" text NOT NULL,
	"phase" text,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vdp_use_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"vdp_record_id" uuid NOT NULL,
	"vdp_use_case_id" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"track" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"title" text,
	"priority" text,
	"division" text,
	"persona" text,
	"details_input" text,
	"execution_phase" text,
	"execution_start_date" text,
	"execution_target_date" text,
	"execution_duration_value" numeric,
	"execution_duration_unit" text,
	"has_ai" boolean DEFAULT false NOT NULL,
	"generated_fields" jsonb,
	"pain_theme_id" text,
	"source_library_id" text,
	"vdp_created_at" text,
	"vdp_updated_at" text,
	"detail_loaded" boolean DEFAULT false NOT NULL,
	"mirrored_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "dc_status" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "org62_url" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "org62_account_id15" text GENERATED ALWAYS AS (left("org62_account_id", 15)) STORED;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "dc_assigned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "next_step" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "products" text[];--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "owner_person_id" uuid;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "left_book_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "org62_opportunity_id15" text GENERATED ALWAYS AS (left("org62_opportunity_id", 15)) STORED;--> statement-breakpoint
ALTER TABLE "vdp_records" ADD COLUMN "salesforce_account_id15" text GENERATED ALWAYS AS (left("salesforce_account_id", 15)) STORED;--> statement-breakpoint
ALTER TABLE "vdp_records" ADD COLUMN "salesforce_opportunity_id15" text GENERATED ALWAYS AS (left("salesforce_opportunity_id", 15)) STORED;--> statement-breakpoint
ALTER TABLE "vdp_records" ADD COLUMN "mirrored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "start_by_user" jsonb;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "dismissed" jsonb;--> statement-breakpoint
ALTER TABLE "activity_entries" ADD COLUMN "log_note" text;--> statement-breakpoint
ALTER TABLE "activity_entries" ADD COLUMN "log_note_basis" text;--> statement-breakpoint
ALTER TABLE "activity_entries" ADD COLUMN "target_org62_event_id15" text GENERATED ALWAYS AS (left("target_org62_event_id", 15)) STORED;--> statement-breakpoint
ALTER TABLE "activity_entries" ADD COLUMN "what_org62_id15" text GENERATED ALWAYS AS (left("what_org62_id", 15)) STORED;--> statement-breakpoint
ALTER TABLE "org62_events" ADD COLUMN "org62_event_id15" text GENERATED ALWAYS AS (left("org62_event_id", 15)) STORED;--> statement-breakpoint
ALTER TABLE "org62_events" ADD COLUMN "what_org62_id15" text GENERATED ALWAYS AS (left("what_org62_id", 15)) STORED;--> statement-breakpoint
ALTER TABLE "org62_use_cases" ADD COLUMN "org62_use_case_id15" text GENERATED ALWAYS AS (left("org62_use_case_id", 15)) STORED;--> statement-breakpoint
ALTER TABLE "org62_use_cases" ADD COLUMN "org62_opportunity_id15" text GENERATED ALWAYS AS (left("org62_opportunity_id", 15)) STORED;--> statement-breakpoint
ALTER TABLE "org62_use_cases" ADD COLUMN "org62_account_id15" text GENERATED ALWAYS AS (left("org62_account_id", 15)) STORED;--> statement-breakpoint
ALTER TABLE "specialist_forecasts" ADD COLUMN "org62_opportunity_id15" text GENERATED ALWAYS AS (left("org62_opportunity_id", 15)) STORED;--> statement-breakpoint
ALTER TABLE "use_cases" ADD COLUMN "org62_opportunity_id15" text GENERATED ALWAYS AS (left("org62_opportunity_id", 15)) STORED;--> statement-breakpoint
ALTER TABLE "canvas_row_overrides" ADD CONSTRAINT "canvas_row_overrides_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_backfills" ADD CONSTRAINT "data_backfills_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "need_decisions" ADD CONSTRAINT "need_decisions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_reads" ADD CONSTRAINT "mirror_reads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vdp_assets" ADD CONSTRAINT "vdp_assets_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vdp_assets" ADD CONSTRAINT "vdp_assets_vdp_record_id_vdp_records_id_fk" FOREIGN KEY ("vdp_record_id") REFERENCES "public"."vdp_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vdp_members" ADD CONSTRAINT "vdp_members_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vdp_members" ADD CONSTRAINT "vdp_members_vdp_record_id_vdp_records_id_fk" FOREIGN KEY ("vdp_record_id") REFERENCES "public"."vdp_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vdp_use_case_phases" ADD CONSTRAINT "vdp_use_case_phases_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vdp_use_case_phases" ADD CONSTRAINT "vdp_use_case_phases_vdp_record_id_vdp_records_id_fk" FOREIGN KEY ("vdp_record_id") REFERENCES "public"."vdp_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vdp_use_cases" ADD CONSTRAINT "vdp_use_cases_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vdp_use_cases" ADD CONSTRAINT "vdp_use_cases_vdp_record_id_vdp_records_id_fk" FOREIGN KEY ("vdp_record_id") REFERENCES "public"."vdp_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_row_overrides_owner_key_uidx" ON "canvas_row_overrides" USING btree ("owner_user_id","row_key");--> statement-breakpoint
CREATE UNIQUE INDEX "data_backfills_owner_name_uidx" ON "data_backfills" USING btree ("owner_user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "need_decisions_owner_rule_subject_uidx" ON "need_decisions" USING btree ("owner_user_id","rule","subject_id");--> statement-breakpoint
CREATE INDEX "need_decisions_owner_until_idx" ON "need_decisions" USING btree ("owner_user_id","until");--> statement-breakpoint
CREATE INDEX "mirror_reads_owner_source_scope_idx" ON "mirror_reads" USING btree ("owner_user_id","source","scope","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vdp_assets_record_ordinal_uidx" ON "vdp_assets" USING btree ("vdp_record_id","ordinal");--> statement-breakpoint
CREATE INDEX "vdp_assets_owner_url_idx" ON "vdp_assets" USING btree ("owner_user_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "vdp_members_record_role_ordinal_uidx" ON "vdp_members" USING btree ("vdp_record_id","role","ordinal");--> statement-breakpoint
CREATE INDEX "vdp_members_owner_email_idx" ON "vdp_members" USING btree ("owner_user_id",lower("email"));--> statement-breakpoint
CREATE INDEX "vdp_use_case_phases_record_uc_idx" ON "vdp_use_case_phases" USING btree ("vdp_record_id","vdp_use_case_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vdp_use_cases_record_uc_uidx" ON "vdp_use_cases" USING btree ("vdp_record_id","vdp_use_case_id");--> statement-breakpoint
CREATE INDEX "vdp_use_cases_owner_uc_idx" ON "vdp_use_cases" USING btree ("owner_user_id","vdp_use_case_id");--> statement-breakpoint
CREATE INDEX "accounts_owner_org62_id15_idx" ON "accounts" USING btree ("owner_user_id","org62_account_id15");--> statement-breakpoint
CREATE INDEX "opportunities_owner_org62_id15_idx" ON "opportunities" USING btree ("owner_user_id","org62_opportunity_id15");--> statement-breakpoint
CREATE INDEX "vdp_records_owner_opp_id15_idx" ON "vdp_records" USING btree ("owner_user_id","salesforce_opportunity_id15");--> statement-breakpoint
CREATE INDEX "activity_entries_owner_what_id15_idx" ON "activity_entries" USING btree ("owner_user_id","what_org62_id15");--> statement-breakpoint
CREATE INDEX "org62_events_owner_event_id15_idx" ON "org62_events" USING btree ("owner_user_id","org62_event_id15");--> statement-breakpoint
CREATE INDEX "org62_use_cases_owner_opp_id15_idx" ON "org62_use_cases" USING btree ("owner_user_id","org62_opportunity_id15");
--> statement-breakpoint
-- need_decisions and canvas_row_overrides are audited like the kv rows they replace: a decision and a canvas edit are
-- change sets, and Undo restores them.
CREATE TRIGGER need_decisions_audit_trg AFTER INSERT OR UPDATE OR DELETE ON need_decisions FOR EACH ROW EXECUTE FUNCTION cc_audit('need_decisions', 'id', '{}');
--> statement-breakpoint
CREATE TRIGGER canvas_row_overrides_audit_trg AFTER INSERT OR UPDATE OR DELETE ON canvas_row_overrides FOR EACH ROW EXECUTE FUNCTION cc_audit('canvas_row_overrides', 'id', '{}');
