-- 0035 (2026-11-20 holistic review, lane 05 §5.3; H-6 Assistant v2): chat_memory, the Assistant's notes, the user's
-- preferences (thread_id null) and per-thread compaction summaries. New table only; nothing existing changes.
-- chat_threads.sdk_session_id (the SDK session a thread resumes) already exists.
CREATE TABLE "chat_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"thread_id" uuid,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"covers_through_seq" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_memory_kind_chk" CHECK ("chat_memory"."kind" IN ('note', 'preference', 'summary'))
);
--> statement-breakpoint
ALTER TABLE "chat_memory" ADD CONSTRAINT "chat_memory_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_memory" ADD CONSTRAINT "chat_memory_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_memory_owner_thread_idx" ON "chat_memory" USING btree ("owner_user_id","thread_id");
