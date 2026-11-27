ALTER TABLE "jobs" ADD COLUMN "runner_seq" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;