/**
 * 后台管理（M5）仓储：用户管理、内容管理、站点配置、概览计数与审计列表。
 *
 * 只做数据访问：SQL、事务边界、并发正确性、字段投影。**判定与规则不在这里**——
 * 「能不能改角色、封禁理由合不合法、谁有资格进后台」都在 `@xsu/core` 的 `src/admin/`；
 * 本文件把条件写与审计行锁进同一次事务（红线 8），样板同社区仓储的 `resolveReport`。
 *
 * 贯穿本文件的约定：
 *
 * 1. **防自锁的最后一道防线在 SQL 的 WHERE 里**，不靠「先查再写」：改角色用
 *    「还有别的管理员」的 EXISTS 子查询兜底，封禁只放行非 admin 目标。并发竞争下
 *    拿不到行一律 0 行 → `false`，由领域层翻译成 `lastAdmin` 或幂等 `changed:false`。
 * 2. **审计行只在条件写真的改了行时落库**：0 行 = 空事务提交，没有业务变化也没有审计。
 * 3. **时间点由调用方传入**（封禁 / 下架用 `audit.createdAt` 或 `now`，它们是同一个时间点），
 *    不用 SQL 的 `now()`——驱动是 postgres.js，裸 `Date` 进不了 Bind（见 `tools.ts` 头注）。
 * 4. **后台列表不过滤软删除**（`deleted_at` 原样带出）：后台要能看见并恢复已下架内容；
 *    公开侧的过滤在社区仓储，两边口径相反是故意的。
 * 5. LIKE 模式转义同社区搜索（`%` / `_` / `\`），用户输入不能变成通配符。
 */
import { and, count, desc, eq, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../client';
import { ADMIN_ROLE, session, user } from '../schema/auth';
import {
  type AuditLogListItem,
  type CommentListItem,
  type PostListItem,
  auditLogListColumns,
  auditLogs,
  commentListColumns,
  comments,
  postListColumns,
  posts,
  reports,
} from '../schema/community';
import { siteConfig, siteConfigDetailColumns } from '../schema/admin';
import { toolRuns } from '../schema/tools';

/** 单条查询一次最多取多少行。防线，不是页大小规则（页大小规则在 core 的 `ADMIN_PAGE_SIZE_MAX`）。 */
export const ADMIN_FETCH_HARD_CAP = 500;

/** `site_config` 单例行的主键。CHECK (`id = 1`) 与这里共用同一个数。 */
export const SITE_CONFIG_SINGLETON_ID = 1;

/** 把调用方给的条数收进 `[1, ADMIN_FETCH_HARD_CAP]`。 */
function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), ADMIN_FETCH_HARD_CAP);
}

/** 负数偏移按 0 处理。 */
function clampOffset(offset: number): number {
  return Math.max(Math.trunc(offset), 0);
}

/** 后台读模型的用户行（搜索列表与单条读取同形）。 */
export type AdminUserRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  bannedAt: Date | null;
  banReason: string | null;
  createdAt: Date;
};

/** 后台内容列表行：公开投影之上多一个软删除标记。 */
export type AdminPostRow = PostListItem & { deletedAt: Date | null };
export type AdminCommentRow = CommentListItem & { deletedAt: Date | null };

/** 后台概览的计数聚合。全部是行数，不做任何耗时统计。 */
export type AdminOverview = {
  userCount: number;
  postCount: number;
  commentCount: number;
  openReportCount: number;
  toolRunCount: number;
};

/** 任务管理页的运行行。复用数据层投影需要作者邮箱，所以这里单独定形状。 */
export type AdminToolRunRow = {
  id: string;
  toolSlug: string;
  status: string;
  userId: string;
  userEmail: string | null;
  errorCode: string | null;
  createdAt: Date;
  durationMs: number | null;
};

/** `tool_runs` 按 status 与工具维度的只读统计。 */
export type AdminToolRunStats = {
  total: number;
  succeeded: number;
  failed: number;
  byTool: { toolSlug: string; runs: number; failed: number }[];
};

/** 偏移分页的一页（带总数）。 */
export type AdminPage<T> = { items: T[]; total: number };

/**
 * 落一行后台审计所需的全部字段。与社区仓储 `NewAuditLog` 的差别只有 `targetType`：
 * M5 把目标类型扩到 `AUDIT_TARGET_TYPES` 四值（含 `user` / `site_config`）。
 */
export type NewAdminAuditLog = {
  id: string;
  actorId: string;
  action: string;
  targetType: AuditLogListItem['targetType'];
  targetId: string;
  detail: string | null;
  createdAt: Date;
};

/**
 * 用户搜索谓词：邮箱或名字包含关键词。模式转义同社区搜索——
 * 用户输入的 `%` 不能变成通配符。空关键词返回 `undefined`（不加筛选）。
 */
function userSearchCondition(query: string): SQL | undefined {
  const trimmed = query.trim();
  if (trimmed === '') {
    return undefined;
  }
  const pattern = `%${trimmed.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  return sql`(${user.email} ilike ${pattern} or ${user.name} ilike ${pattern})`;
}

const adminUserColumns = {
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  bannedAt: user.bannedAt,
  banReason: user.banReason,
  createdAt: user.createdAt,
};

/** 用户单条读取（按 id）。**不过滤封禁状态**：后台要能看见被封禁的人。 */
export async function getAdminUserById(
  db: Database,
  params: { id: string },
): Promise<AdminUserRow | null> {
  const rows = await db.select(adminUserColumns).from(user).where(eq(user.id, params.id)).limit(1);

  return rows[0] ?? null;
}

/** 用户列表 + 总数。`query` 非空时按邮箱 / 名字模糊匹配；**包含被封禁用户**。 */
export async function listAdminUsers(
  db: Database,
  params: { query: string; limit: number; offset: number },
): Promise<AdminPage<AdminUserRow>> {
  const where = userSearchCondition(params.query);
  const limit = clampLimit(params.limit);
  const offset = clampOffset(params.offset);

  const [items, totals] = await Promise.all([
    db
      .select(adminUserColumns)
      .from(user)
      .where(where)
      .orderBy(desc(user.createdAt), desc(user.id))
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(user).where(where),
  ]);

  return { items, total: totals[0]?.value ?? 0 };
}

/**
 * 条件改角色 + 审计，同事务。
 *
 * WHERE 三重条件：目标存在、**还没处于目标角色**（并发下已被改成同值 → 0 行）、
 * 降权方向带「还有别的管理员」EXISTS（提升为 admin 不需要保护）。
 * 0 行返回 `false` 且不写审计——领域层把它翻译成 `lastAdmin`。
 */
export async function updateUserRole(
  db: Database,
  params: { userId: string; role: string; audit: NewAdminAuditLog },
): Promise<boolean> {
  const promotingToAdmin = params.role === ADMIN_ROLE;

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(user)
      .set({ role: params.role, updatedAt: params.audit.createdAt })
      .where(
        and(
          eq(user.id, params.userId),
          ne(user.role, params.role),
          // SPEC-admin 3.2 的条件原样：新角色是 admin 时无条件放行，否则要求还有别的管理员。
          promotingToAdmin
            ? undefined
            : sql`exists (select 1 from ${user} other where other.role = 'admin' and other.id <> ${user.id})`,
        ),
      )
      .returning({ id: user.id });

    if (updated.length === 0) {
      return false;
    }
    await tx.insert(auditLogs).values(params.audit);
    return true;
  });
}

/**
 * 条件封禁 + 删该用户全部会话 + 审计，同事务。
 *
 * WHERE 只放行「未封禁且**不是 admin**」的目标：封其他管理员整体走不通（领域层要求
 * 先降权再封禁，两步都留审计），对管理员封禁拿到 0 行 → `lastAdmin`。
 * 删会话在条件写成功之后：0 行时连会话都不该被动。
 */
export async function banUser(
  db: Database,
  params: { userId: string; reason: string | null; audit: NewAdminAuditLog },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(user)
      .set({
        bannedAt: params.audit.createdAt,
        banReason: params.reason,
        updatedAt: params.audit.createdAt,
      })
      .where(and(eq(user.id, params.userId), isNull(user.bannedAt), ne(user.role, ADMIN_ROLE)))
      .returning({ id: user.id });

    if (updated.length === 0) {
      return false;
    }
    await tx.delete(session).where(eq(session.userId, params.userId));
    await tx.insert(auditLogs).values(params.audit);
    return true;
  });
}

/** 条件解封 + 审计，同事务。0 行 = 并发下已被解封（或不存在），领域层按幂等成功处理。 */
export async function unbanUser(
  db: Database,
  params: { userId: string; audit: NewAdminAuditLog },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(user)
      .set({ bannedAt: null, banReason: null, updatedAt: params.audit.createdAt })
      .where(and(eq(user.id, params.userId), isNotNull(user.bannedAt)))
      .returning({ id: user.id });

    if (updated.length === 0) {
      return false;
    }
    await tx.insert(auditLogs).values(params.audit);
    return true;
  });
}

const adminPostColumns = {
  ...postListColumns,
  deletedAt: posts.deletedAt,
};

const adminCommentColumns = {
  ...commentListColumns,
  deletedAt: comments.deletedAt,
};

/** 单条读帖子（不过滤软删除），内容管理预检用。 */
export async function getAdminPostById(
  db: Database,
  params: { id: string },
): Promise<AdminPostRow | null> {
  const rows = await db
    .select(adminPostColumns)
    .from(posts)
    .where(eq(posts.id, params.id))
    .limit(1);

  return rows[0] ?? null;
}

/** 单条读评论（不过滤软删除），内容管理预检用。 */
export async function getAdminCommentById(
  db: Database,
  params: { id: string },
): Promise<AdminCommentRow | null> {
  const rows = await db
    .select(adminCommentColumns)
    .from(comments)
    .where(eq(comments.id, params.id))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * 条件下架帖子（`WHERE deleted_at IS NULL`）+ 审计，同事务。
 * 0 行 = 已下架或不存在；幂等短路在领域层，这里只兜并发。
 */
export async function adminTakedownPost(
  db: Database,
  params: { postId: string; now: Date; audit: NewAdminAuditLog },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(posts)
      .set({ deletedAt: params.now })
      .where(and(eq(posts.id, params.postId), isNull(posts.deletedAt)))
      .returning({ id: posts.id });

    if (updated.length === 0) {
      return false;
    }
    await tx.insert(auditLogs).values(params.audit);
    return true;
  });
}

/** 条件恢复帖子（`WHERE deleted_at IS NOT NULL`）+ 审计，同事务。 */
export async function adminRestorePost(
  db: Database,
  params: { postId: string; now: Date; audit: NewAdminAuditLog },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(posts)
      .set({ deletedAt: null })
      .where(and(eq(posts.id, params.postId), isNotNull(posts.deletedAt)))
      .returning({ id: posts.id });

    if (updated.length === 0) {
      return false;
    }
    await tx.insert(auditLogs).values(params.audit);
    return true;
  });
}

/** 条件下架评论 + 审计，同事务。 */
export async function adminTakedownComment(
  db: Database,
  params: { commentId: string; now: Date; audit: NewAdminAuditLog },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(comments)
      .set({ deletedAt: params.now })
      .where(and(eq(comments.id, params.commentId), isNull(comments.deletedAt)))
      .returning({ id: comments.id });

    if (updated.length === 0) {
      return false;
    }
    await tx.insert(auditLogs).values(params.audit);
    return true;
  });
}

/**
 * 条件恢复评论（要求父帖未删除）+ 审计，同事务。
 *
 * 父帖检查在 WHERE 里再兜一道（领域层 `restoreComment` 已预检过一次）：恢复动作
 * 与「父帖同时被删」并发时，这条条件让评论不会出现在公开侧不可见的帖子下面。
 */
export async function adminRestoreComment(
  db: Database,
  params: { commentId: string; now: Date; audit: NewAdminAuditLog },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(comments)
      .set({ deletedAt: null })
      .where(
        and(
          eq(comments.id, params.commentId),
          isNotNull(comments.deletedAt),
          sql`exists (
            select 1 from ${posts} parent
            where parent.id = ${comments.postId} and parent.deleted_at is null
          )`,
        ),
      )
      .returning({ id: comments.id });

    if (updated.length === 0) {
      return false;
    }
    await tx.insert(auditLogs).values(params.audit);
    return true;
  });
}
/*
 * 站点配置
 */

/** 读单例行（无行返回 `null`，页面显示「尚未设置过」）。 */
export async function getSiteConfig(db: Database) {
  const rows = await db
    .select(siteConfigDetailColumns)
    .from(siteConfig)
    .where(eq(siteConfig.id, SITE_CONFIG_SINGLETON_ID))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * upsert 单例行 + 审计，同事务（SPEC-admin 3.2）。
 *
 * `ON CONFLICT (id) DO UPDATE`：首写是 INSERT、之后是 UPDATE，一张表一行，
 * CHECK 约束在两侧同样生效（绕过领域层直接写库也会被 CHECK 挡下）。
 */
export async function updateSiteConfig(
  db: Database,
  params: {
    postQuotaPerHour: number | null;
    commentQuotaPerHour: number | null;
    toolQuotaPerHour: number | null;
    updatedBy: string;
    now: Date;
    audit: NewAdminAuditLog;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(siteConfig)
      .values({
        id: SITE_CONFIG_SINGLETON_ID,
        postQuotaPerHour: params.postQuotaPerHour,
        commentQuotaPerHour: params.commentQuotaPerHour,
        toolQuotaPerHour: params.toolQuotaPerHour,
        updatedBy: params.updatedBy,
        updatedAt: params.now,
      })
      .onConflictDoUpdate({
        target: siteConfig.id,
        set: {
          postQuotaPerHour: params.postQuotaPerHour,
          commentQuotaPerHour: params.commentQuotaPerHour,
          toolQuotaPerHour: params.toolQuotaPerHour,
          updatedBy: params.updatedBy,
          updatedAt: params.now,
        },
      });

    await tx.insert(auditLogs).values(params.audit);
  });
}

/*
 * 读侧（列表与概览）
 */

/** 帖子列表（含软删除行，创建时间倒序）+ 总数。 */
export async function listAdminPosts(
  db: Database,
  params: { limit: number; offset: number },
): Promise<AdminPage<AdminPostRow>> {
  const limit = clampLimit(params.limit);
  const offset = clampOffset(params.offset);

  const [items, totals] = await Promise.all([
    db
      .select(adminPostColumns)
      .from(posts)
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(posts),
  ]);

  return { items, total: totals[0]?.value ?? 0 };
}

/** 评论列表（含软删除行，创建时间倒序）+ 总数。 */
export async function listAdminComments(
  db: Database,
  params: { limit: number; offset: number },
): Promise<AdminPage<AdminCommentRow>> {
  const limit = clampLimit(params.limit);
  const offset = clampOffset(params.offset);

  const [items, totals] = await Promise.all([
    db
      .select(adminCommentColumns)
      .from(comments)
      .orderBy(desc(comments.createdAt), desc(comments.id))
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(comments),
  ]);

  return { items, total: totals[0]?.value ?? 0 };
}

/** 审计日志列表（时间倒序，含 M5 之前的社区审计行）。只读：这张表只有 INSERT 与 SELECT。 */
export async function listAdminAuditLogs(
  db: Database,
  params: { limit: number; offset: number },
): Promise<AdminPage<AuditLogListItem>> {
  const limit = clampLimit(params.limit);
  const offset = clampOffset(params.offset);

  const [items, totals] = await Promise.all([
    db
      .select(auditLogListColumns)
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(auditLogs),
  ]);

  return { items, total: totals[0]?.value ?? 0 };
}

/**
 * 概览计数：五次 COUNT（用户 / 帖子 / 评论 / 待处理举报 / 任务运行）。
 *
 * 全部是行数，不做耗时统计；一次 `Promise.all` 打出去，页面上五张卡片一个数一行 SQL。
 * 帖子与评论**不计软删除行**——概览回答「站上现在有多少内容」，已下架的不是内容存量。
 */
export async function getAdminOverview(db: Database): Promise<AdminOverview> {
  const [userTotals, postTotals, commentTotals, reportTotals, toolRunTotals] = await Promise.all([
    db.select({ value: count() }).from(user),
    db.select({ value: count() }).from(posts).where(isNull(posts.deletedAt)),
    db.select({ value: count() }).from(comments).where(isNull(comments.deletedAt)),
    db.select({ value: count() }).from(reports).where(eq(reports.status, 'open')),
    db.select({ value: count() }).from(toolRuns),
  ]);

  return {
    userCount: userTotals[0]?.value ?? 0,
    postCount: postTotals[0]?.value ?? 0,
    commentCount: commentTotals[0]?.value ?? 0,
    openReportCount: reportTotals[0]?.value ?? 0,
    toolRunCount: toolRunTotals[0]?.value ?? 0,
  };
}

/*
 * 任务管理（只读）
 */

/** 最近运行列表：join `user` 带出邮箱（后台要能回答「这是谁跑的」）。时间倒序。 */
export async function listAdminToolRuns(
  db: Database,
  params: { limit: number },
): Promise<AdminToolRunRow[]> {
  return db
    .select({
      id: toolRuns.id,
      toolSlug: toolRuns.toolSlug,
      status: toolRuns.status,
      userId: toolRuns.userId,
      userEmail: user.email,
      errorCode: toolRuns.errorCode,
      createdAt: toolRuns.createdAt,
      durationMs: toolRuns.durationMs,
    })
    .from(toolRuns)
    .leftJoin(user, eq(user.id, toolRuns.userId))
    .orderBy(desc(toolRuns.createdAt), desc(toolRuns.id))
    .limit(clampLimit(params.limit));
}

/**
 * 运行只读统计：总数、成功数、失败数、按工具的分组计数。
 *
 * 四条聚合一次 `Promise.all` 打出去；`byTool` 按运行数倒序、工具名次序兜底，
 * 页面渲染顺序才稳定。成本看板是 M4/M6 的事，这里不做耗时与成本的统计。
 */
export async function getAdminToolRunStats(db: Database): Promise<AdminToolRunStats> {
  const [totals, succeeded, failed, byTool] = await Promise.all([
    db.select({ value: count() }).from(toolRuns),
    db.select({ value: count() }).from(toolRuns).where(eq(toolRuns.status, 'succeeded')),
    db.select({ value: count() }).from(toolRuns).where(eq(toolRuns.status, 'failed')),
    db
      .select({
        toolSlug: toolRuns.toolSlug,
        runs: count(),
        failed: sql<number>`count(*) filter (where ${toolRuns.status} = 'failed')`.mapWith(Number),
      })
      .from(toolRuns)
      .groupBy(toolRuns.toolSlug)
      .orderBy(desc(count()), toolRuns.toolSlug),
  ]);

  return {
    total: totals[0]?.value ?? 0,
    succeeded: succeeded[0]?.value ?? 0,
    failed: failed[0]?.value ?? 0,
    byTool: byTool.map((row) => ({ toolSlug: row.toolSlug, runs: row.runs, failed: row.failed })),
  };
}
