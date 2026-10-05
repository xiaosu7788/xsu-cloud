CREATE TABLE "daily_checkins" (
	"user_id" text NOT NULL,
	"checkin_date" date NOT NULL,
	"points" integer NOT NULL,
	"base_points" integer NOT NULL,
	"bonus_points" integer DEFAULT 0 NOT NULL,
	"streak" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_checkins_pk" PRIMARY KEY("user_id","checkin_date")
);
--> statement-breakpoint
CREATE TABLE "direct_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dm_contacts" (
	"owner_id" text NOT NULL,
	"peer_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_contacts_pk" PRIMARY KEY("owner_id","peer_id"),
	CONSTRAINT "dm_contacts_status_check" CHECK ("dm_contacts"."status" in ('request', 'accepted', 'declined'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient_id" text NOT NULL,
	"category" text NOT NULL,
	"type" text NOT NULL,
	"actor_id" text,
	"post_id" text,
	"comment_id" text,
	"link" text,
	"title" text,
	"body" text,
	"dedup_key" text,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_category_check" CHECK ("notifications"."category" in ('system', 'site', 'social'))
);
--> statement-breakpoint
CREATE TABLE "point_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"delta" integer NOT NULL,
	"balance" integer NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"dedup_key" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_achievements" (
	"user_id" text NOT NULL,
	"achievement_id" text NOT NULL,
	"level" integer NOT NULL,
	"unlocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_achievements_pk" PRIMARY KEY("user_id","achievement_id","level")
);
--> statement-breakpoint
CREATE TABLE "user_points" (
	"user_id" text PRIMARY KEY NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_spaces" (
	"user_id" text PRIMARY KEY NOT NULL,
	"show_stats" boolean DEFAULT true NOT NULL,
	"show_posts" boolean DEFAULT true NOT NULL,
	"show_achievements" boolean DEFAULT true NOT NULL,
	"motto" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_stats" (
	"user_id" text PRIMARY KEY NOT NULL,
	"visit_count" integer DEFAULT 0 NOT NULL,
	"last_visit_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "site_config" DROP CONSTRAINT "site_config_post_quota_check";--> statement-breakpoint
ALTER TABLE "site_config" DROP CONSTRAINT "site_config_comment_quota_check";--> statement-breakpoint
ALTER TABLE "site_config" DROP CONSTRAINT "site_config_tool_quota_check";--> statement-breakpoint
ALTER TABLE "daily_checkins" ADD CONSTRAINT "daily_checkins_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_from_user_id_user_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_to_user_id_user_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_contacts" ADD CONSTRAINT "dm_contacts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_contacts" ADD CONSTRAINT "dm_contacts_peer_id_user_id_fk" FOREIGN KEY ("peer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_user_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_points" ADD CONSTRAINT "user_points_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_spaces" ADD CONSTRAINT "user_spaces_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_stats" ADD CONSTRAINT "user_stats_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_checkins_user_idx" ON "daily_checkins" USING btree ("user_id","checkin_date");--> statement-breakpoint
CREATE INDEX "direct_messages_from_to_idx" ON "direct_messages" USING btree ("from_user_id","to_user_id","created_at");--> statement-breakpoint
CREATE INDEX "direct_messages_to_from_idx" ON "direct_messages" USING btree ("to_user_id","from_user_id","created_at");--> statement-breakpoint
CREATE INDEX "direct_messages_unread_idx" ON "direct_messages" USING btree ("to_user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "dm_contacts_owner_status_idx" ON "dm_contacts" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "dm_contacts_peer_idx" ON "dm_contacts" USING btree ("peer_id","status");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_id","read","created_at");--> statement-breakpoint
CREATE INDEX "notifications_recipient_category_idx" ON "notifications" USING btree ("recipient_id","category","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedup_unique_idx" ON "notifications" USING btree ("recipient_id","dedup_key") WHERE "notifications"."dedup_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "point_transactions_dedup_unique_idx" ON "point_transactions" USING btree ("user_id","dedup_key") WHERE "point_transactions"."dedup_key" is not null;--> statement-breakpoint
CREATE INDEX "point_transactions_user_idx" ON "point_transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "user_achievements_user_idx" ON "user_achievements" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "site_config" ADD CONSTRAINT "site_config_post_quota_check" CHECK ("site_config"."post_quota_per_hour" is null or ("site_config"."post_quota_per_hour" >= 0 and "site_config"."post_quota_per_hour" <= 1000000));--> statement-breakpoint
ALTER TABLE "site_config" ADD CONSTRAINT "site_config_comment_quota_check" CHECK ("site_config"."comment_quota_per_hour" is null or ("site_config"."comment_quota_per_hour" >= 0 and "site_config"."comment_quota_per_hour" <= 1000000));--> statement-breakpoint
ALTER TABLE "site_config" ADD CONSTRAINT "site_config_tool_quota_check" CHECK ("site_config"."tool_quota_per_hour" is null or ("site_config"."tool_quota_per_hour" >= 0 and "site_config"."tool_quota_per_hour" <= 1000000));