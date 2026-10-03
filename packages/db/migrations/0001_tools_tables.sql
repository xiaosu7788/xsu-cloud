CREATE TABLE "tool_favorites" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"tool_slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"tool_slug" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"input_bytes" integer NOT NULL,
	"output_bytes" integer,
	"duration_ms" integer NOT NULL,
	"input_summary" text,
	"output_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_runs_status_check" CHECK ("tool_runs"."status" in ('succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "tool_favorites" ADD CONSTRAINT "tool_favorites_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_runs" ADD CONSTRAINT "tool_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_favorites_user_tool_idx" ON "tool_favorites" USING btree ("user_id","tool_slug");--> statement-breakpoint
CREATE INDEX "tool_runs_user_created_idx" ON "tool_runs" USING btree ("user_id","created_at");