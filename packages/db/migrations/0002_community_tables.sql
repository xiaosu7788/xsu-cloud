CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_target_type_check" CHECK ("audit_logs"."target_type" in ('post', 'comment'))
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" text PRIMARY KEY NOT NULL,
	"author_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"post_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text DEFAULT 'like' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reactions_pk" PRIMARY KEY("post_id","user_id"),
	CONSTRAINT "reactions_kind_check" CHECK ("reactions"."kind" in ('like'))
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"reporter_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_by" text,
	"handled_at" timestamp with time zone,
	CONSTRAINT "reports_target_type_check" CHECK ("reports"."target_type" in ('post', 'comment')),
	CONSTRAINT "reports_status_check" CHECK ("reports"."status" in ('open', 'takedown', 'dismissed')),
	CONSTRAINT "reports_handled_check" CHECK (("reports"."status" = 'open') = ("reports"."handled_at" is null))
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_handled_by_user_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_post_idx" ON "comments" USING btree ("post_id","created_at","id") WHERE "comments"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "comments_author_idx" ON "comments" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "posts_feed_idx" ON "posts" USING btree ("created_at","id") WHERE "posts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "posts_author_idx" ON "posts" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "posts_tags_idx" ON "posts" USING gin ("tags") WHERE "posts"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "reports_open_unique_idx" ON "reports" USING btree ("reporter_id","target_type","target_id") WHERE "reports"."status" = 'open';--> statement-breakpoint
CREATE INDEX "reports_status_created_idx" ON "reports" USING btree ("status","created_at");
--> statement-breakpoint
-- 以下三句是**手写的**：drizzle-kit 不表达触发器，而这正是「只追加」这条约束的落点（红线 8）。
-- 用 OR REPLACE / IF EXISTS 是为了这条迁移被手工重放时也成立。残留风险：同一套凭据可以
-- DISABLE TRIGGER 或直接改表结构，见 docs/spec/SPEC-community.md 的已知债务。
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger
	LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_logs 只追加：不允许修改或删除审计行';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_logs_append_only_trigger ON "audit_logs";--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only_trigger
	BEFORE UPDATE OR DELETE ON "audit_logs"
	FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();--> statement-breakpoint
-- TRUNCATE 不触发行级触发器，要单独挡（statement 级）。漏掉它就等于留了一条清空审计的路。
DROP TRIGGER IF EXISTS audit_logs_no_truncate_trigger ON "audit_logs";--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate_trigger
	BEFORE TRUNCATE ON "audit_logs"
	FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();