CREATE TABLE "site_config" (
	"id" integer PRIMARY KEY NOT NULL,
	"post_quota_per_hour" integer,
	"comment_quota_per_hour" integer,
	"tool_quota_per_hour" integer,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_config_id_check" CHECK ("site_config"."id" = 1),
	CONSTRAINT "site_config_post_quota_check" CHECK ("site_config"."post_quota_per_hour" is null or ("site_config"."post_quota_per_hour" >= 0 and "site_config"."post_quota_per_hour" <= 1000000)),
	CONSTRAINT "site_config_comment_quota_check" CHECK ("site_config"."comment_quota_per_hour" is null or ("site_config"."comment_quota_per_hour" >= 0 and "site_config"."comment_quota_per_hour" <= 1000000)),
	CONSTRAINT "site_config_tool_quota_check" CHECK ("site_config"."tool_quota_per_hour" is null or ("site_config"."tool_quota_per_hour" >= 0 and "site_config"."tool_quota_per_hour" <= 1000000))
);
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_target_type_check";--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "banned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ban_reason" text;--> statement-breakpoint
ALTER TABLE "site_config" ADD CONSTRAINT "site_config_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_target_type_check" CHECK ("audit_logs"."target_type" in ('post', 'comment', 'user', 'site_config'));