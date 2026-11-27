CREATE TABLE "releases" (
	"version" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"protocol_version" integer NOT NULL,
	"manifest" text NOT NULL,
	"signature" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"yanked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_update_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runner_id" uuid NOT NULL,
	"from_version" text NOT NULL,
	"to_version" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "pinned_version" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "auto_update" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_update_events" ADD CONSTRAINT "runner_update_events_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "releases_channel_protocol_idx" ON "releases" USING btree ("channel","protocol_version","yanked");--> statement-breakpoint
CREATE INDEX "runner_update_events_runner_created_idx" ON "runner_update_events" USING btree ("runner_id","created_at");