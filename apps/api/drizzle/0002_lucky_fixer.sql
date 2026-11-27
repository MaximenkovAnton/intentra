DROP INDEX "project_runners_project_idx";--> statement-breakpoint
CREATE INDEX "artifacts_job_idx" ON "artifacts" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "decisions_intent_idx" ON "decisions" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "decisions_supersedes_idx" ON "decisions" USING btree ("supersedes_id");--> statement-breakpoint
CREATE INDEX "escalations_answered_by_idx" ON "escalations" USING btree ("answered_by");--> statement-breakpoint
CREATE INDEX "escalations_decision_idx" ON "escalations" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "intents_created_by_idx" ON "intents" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "jobs_stage_idx" ON "jobs" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "jobs_runner_idx" ON "jobs" USING btree ("runner_id");--> statement-breakpoint
CREATE INDEX "projects_created_by_idx" ON "projects" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "runner_registration_tokens_project_idx" ON "runner_registration_tokens" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "runner_registration_tokens_created_by_idx" ON "runner_registration_tokens" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");