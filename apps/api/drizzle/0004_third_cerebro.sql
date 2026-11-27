CREATE TABLE "memory_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"intent_id" uuid,
	"key" text NOT NULL,
	"statement" text NOT NULL,
	"probe" jsonb NOT NULL,
	"expected" text NOT NULL,
	"status" text DEFAULT 'unverified' NOT NULL,
	"code_ref" jsonb,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"commit" text,
	"blob_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_claims" ADD CONSTRAINT "memory_claims_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_claims" ADD CONSTRAINT "memory_claims_intent_id_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_claims_project_key_uq" ON "memory_claims" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "memory_claims_project_status_idx" ON "memory_claims" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "memory_claims_intent_idx" ON "memory_claims" USING btree ("intent_id");