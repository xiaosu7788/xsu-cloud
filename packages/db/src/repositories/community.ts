/**
 * 社区仓储：帖子、评论、点赞、举报、审计日志（表结构见 `../schema/community.ts`）。
 *
 * 只做数据访问：SQL、事务边界、并发正确性、字段投影。**判定与规则不在这里**——
 * 「输入合不合法、超没超配额、这个人能不能删这条内容、举报该怎么流转」都在 `@xsu/core` 的
 * `src/community/`；本文件只把事实取回来、把结果落下去。
 *
 * 五条贯穿本文件的约定（前两条与 `tools.ts` 同源）：
 *
 * 1. **时间点由调用方传入**，不用 SQL 的 `now()`：领域层的配额判定与落库的 `created_at`
 *    必须是同一个时间点，否则「算的时候没超、写下去就超了」。
 * 2. **比较时间要走列的类型映射或显式转换。** 驱动是 `postgres.js`，它在 Bind 阶段对参数做
 *    `Buffer.byteLength`，拿到裸 `Date` 直接抛 `ERR_INVALID_ARG_TYPE`。游标的行值比较用不了
 *    `lt()`（它只吃单个列，给不了「两列一起比」的语义），所以那里显式 `::timestamptz`。
 * 3. **软删除的可见性靠查询条件，不靠删行。** 列表、按标签浏览、搜索、评论收集这四处都必须
 *    带 `deleted_at is null`，少一处就是「删了还能搜到」（`docs/spec/SPEC-community.md` 3.2-3）。
 * 4. **并发正确性交给约束，不靠「先查再写」。** 点赞是 `ON CONFLICT DO NOTHING`（主键
 *    `(post_id, user_id)`），举报是 `ON CONFLICT DO NOTHING`（部分唯一索引），审核是带
 *    `status = 'open'` 条件的 `UPDATE ... RETURNING`。三处都让数据库来判定谁赢。
 * 5. **审核的状态流转与审计行同事务**（红线 8）：不允许出现「内容已下架、审计没落」。
 *    它也是本文件里唯一的 `db.transaction`。
 *
 * 页大小**不在这里定**（规则是 `@xsu/core` 的 `COMMUNITY_PAGE_SIZE_MAX`）：下面那个
 * `limit` 是「探测行」上限，领域层靠 `limit + 1` 判断有没有下一页，撞上防线会被截断成静默漏行。
 */
import { and, asc, count, desc, eq, gte, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import type { Database } from '../client';
import { user } from '../schema/auth';
import {
  type AuditLogListItem,
  type CommentDetail,
  type CommentListItem,
  type PostDetail,
  type PostListItem,
  type ReportListItem,
  type ReportStatus,
  type ReportTargetType,
  auditLogListColumns,
  auditLogs,
  commentDetailColumns,
  commentListColumns,
  comments,
  postDetailColumns,
  postListColumns,
  posts,
  reactions,
  reportListColumns,
  reports,
} from '../schema/community';

/**
 * 单条查询一次最多取多少行。**这不是页大小规则**（规则见文件头），只是一条防线：
 * 调用方传了离谱的数字时也不至于把整张表拉进内存。必须大于领域层的页大小上限。
 */
export const COMMUNITY_FETCH_HARD_CAP = 500;

/**
 * 游标位置。排序键是 `(created_at, id)` 而不是只有时间：同一毫秒内发的两条帖子
 * 光靠时间分不出先后，翻页就会重复或漏掉（`docs/spec/SPEC-community.md` 第 6 节）。
 */
export type FeedCursorPoint = { createdAt: Date; id: string };

/** 落一行帖子所需的全部字段。由应用层把领域层结果翻译成这个形状。 */
export type NewPost = {
  id: string;
  authorId: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
};

/** 落一行评论所需的全部字段。 */
export type NewComment = {
  id: string;
  postId: string;
  authorId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
};

/** 落一行举报所需的全部字段。`status` 不在这里——新建的举报一定是 `open`（列默认值）。 */
export type NewReport = {
  id: string;
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  createdAt: Date;
};

/** 落一行审计日志所需的全部字段。`action` 与 `detail` 由领域层决定。 */
export type NewAuditLog = {
  id: string;
  actorId: string;
  action: string;
  targetType: ReportTargetType;
  targetId: string;
  detail: string | null;
  createdAt: Date;
};

/**
 * 行值比较：`(created_at, id) < (t, i)`，与 `posts_feed_idx` / `comments_post_idx` 同序。
 *
 * `direction` 由列表的排序方向决定（帖子倒序、评论正序）。操作符走 `sql.raw`——它不可能被
 * 参数化，取值来自这个字面量联合，不是外部输入。
 */
function cursorCondition(params: {
  createdAt: AnyPgColumn;
  id: AnyPgColumn;
  cursor: FeedCursorPoint;
  direction: 'desc' | 'asc';
}): SQL {
  const { createdAt, id, cursor, direction } = params;
  const operator = direction === 'desc' ? '<' : '>';
  return sql`(${createdAt}, ${id}) ${sql.raw(operator)} (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id})`;
}

/**
 * 搜索谓词：标题或正文包含关键词（`ILIKE` 顺序扫描，没有全文索引，见 SPEC 已知债务）。
 *
 * 模式里的 `\`、`%`、`_` 必须转义：要不用户输入一个 `%` 就变成通配符，返回全部内容。
 * 那既是意外行为，也会让「软删除的内容搜不到」这条验收没法证伪。
 * 转义字符是 `ILIKE` 的默认反斜杠，不需要额外写 `ESCAPE`。
 */
function searchCondition(query: string): SQL {
  const pattern = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  return sql`(${posts.title} ilike ${pattern} or ${posts.body} ilike ${pattern})`;
}

/** 把调用方给的条数收进 `[1, COMMUNITY_FETCH_HARD_CAP]`。 */
function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), COMMUNITY_FETCH_HARD_CAP);
}

/*
 * 帖子
 */

/**
 * 该用户在 `since`（含）之后发了多少篇。配额判定用的就是它。
 *
 * **已删除的帖子也计入**（`posts_author_idx` 故意不做部分索引）：删掉的帖子一样占用了那次
 * 配额，排除掉会让「删了再发」变成绕过配额的路子。
 */
export async function countPostsSince(
  db: Database,
  params: { authorId: string; since: Date },
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(posts)
    .where(and(eq(posts.authorId, params.authorId), gte(posts.createdAt, params.since)));

  return rows[0]?.value ?? 0;
}

/** 落一行帖子。 */
export async function insertPost(db: Database, post: NewPost): Promise<void> {
  await db.insert(posts).values(post);
}

/**
 * 公开列表 / 按标签浏览 / 搜索共用的一次取页。
 *
 * 三个筛选条件都能缺省：`tag` 走 GIN（`posts_tags_idx`），`query` 走顺序扫描，
 * `cursor` 走 `posts_feed_idx`；三者都带 `deleted_at is null`，与部分索引的谓词一致。
 */
export async function listPosts(
  db: Database,
  params: {
    limit: number;
    cursor: FeedCursorPoint | null;
    tag?: string | null;
    query?: string | null;
  },
): Promise<PostListItem[]> {
  const filters: SQL[] = [isNull(posts.deletedAt)];

  if (params.cursor) {
    filters.push(
      cursorCondition({
        createdAt: posts.createdAt,
        id: posts.id,
        cursor: params.cursor,
        direction: 'desc',
      }),
    );
  }
  if (params.tag) {
    filters.push(sql`${posts.tags} @> array[${params.tag}]::text[]`);
  }
  if (params.query) {
    filters.push(searchCondition(params.query));
  }

  return db
    .select(postListColumns)
    .from(posts)
    .where(and(...filters))
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(clampLimit(params.limit));
}

/**
 * 某个作者的帖子，按时间倒序取一页（`/console/community`「我的帖子」）。
 *
 * **不含已删除的**：列表页要的就是「现在还在的内容」，删除后从列表消失正是要验证的行为。
 * 注意这与配额计数口径不同（那里算上已删除的），差别是有意的，见 `countPostsSince`。
 */
export async function listPostsByAuthor(
  db: Database,
  params: { authorId: string; limit: number },
): Promise<PostListItem[]> {
  return db
    .select(postListColumns)
    .from(posts)
    .where(and(eq(posts.authorId, params.authorId), isNull(posts.deletedAt)))
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(clampLimit(params.limit));
}

/**
 * 构建期要预渲染的标签清单（`generateStaticParams` 的数据源）。
 *
 * 与 `listPosts` 的按标签查询同一处软删除条件：已删除帖子独有的标签不进清单——
 * 不然每次 ISR 重建都会为它们渲染出「这个标签下还没有帖子」的空页面。
 * 标签取值来自帖子的数组列，展开去重后按字典序稳定排序。
 */
export async function listFeedTags(db: Database): Promise<string[]> {
  const rows = await db
    .select({ tag: sql<string>`unnest(${posts.tags})` })
    .from(posts)
    .where(isNull(posts.deletedAt));

  return [...new Set(rows.map((row) => row.tag))].sort((a, b) => a.localeCompare(b));
}

/**
 * 单条帖子。**不过滤 `deleted_at`**：领域层要靠 `deletedAt` 区分「不存在」与
 * 「存在但已被删除 / 下架」，这两种情况的对外表现不同（404 vs 统一拒绝视图）。
 */
export async function getPostById(
  db: Database,
  params: { id: string },
): Promise<PostDetail | null> {
  const rows = await db
    .select(postDetailColumns)
    .from(posts)
    .where(eq(posts.id, params.id))
    .limit(1);

  return rows[0] ?? null;
}

/** 编辑：只改内容与 `updated_at`，不含已删除的行。 */
export async function updatePost(
  db: Database,
  params: { id: string; title: string; body: string; tags: string[]; now: Date },
): Promise<void> {
  await db
    .update(posts)
    .set({
      title: params.title,
      body: params.body,
      tags: params.tags,
      updatedAt: params.now,
    })
    .where(and(eq(posts.id, params.id), isNull(posts.deletedAt)));
}

/**
 * 软删除：只写 `deleted_at`，不删行（举报与审计日志指向它，删行会让审计变成悬空引用）。
 *
 * 带上 `deleted_at is null` 是为了**幂等**：重复删除不会把第一次的删除时间覆盖掉，
 * 而那个时间戳是「内容什么时候消失的」的唯一记录。`updated_at` 不动——软删除不是编辑。
 */
export async function softDeletePost(
  db: Database,
  params: { id: string; now: Date },
): Promise<void> {
  await db
    .update(posts)
    .set({ deletedAt: params.now })
    .where(and(eq(posts.id, params.id), isNull(posts.deletedAt)));
}

/*
 * 评论
 */

/** 该用户在 `since`（含）之后发了多少条评论。已删除的同样计入，理由见 `countPostsSince`。 */
export async function countCommentsSince(
  db: Database,
  params: { authorId: string; since: Date },
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(comments)
    .where(and(eq(comments.authorId, params.authorId), gte(comments.createdAt, params.since)));

  return rows[0]?.value ?? 0;
}

/** 落一行评论。 */
export async function insertComment(db: Database, comment: NewComment): Promise<void> {
  await db.insert(comments).values(comment);
}

/**
 * 一个帖子下的一页评论。**正序**（最早的在前）——与详情页从上往下读的方向一致，
 * 也因此和 `comments_post_idx` 的升序完全同序，不需要额外排序。
 */
export async function listComments(
  db: Database,
  params: { postId: string; limit: number; cursor: FeedCursorPoint | null },
): Promise<CommentListItem[]> {
  const filters: SQL[] = [eq(comments.postId, params.postId), isNull(comments.deletedAt)];

  if (params.cursor) {
    filters.push(
      cursorCondition({
        createdAt: comments.createdAt,
        id: comments.id,
        cursor: params.cursor,
        direction: 'asc',
      }),
    );
  }

  return db
    .select(commentListColumns)
    .from(comments)
    .where(and(...filters))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(clampLimit(params.limit));
}

/** 单条评论。**不过滤 `deleted_at`**，理由与 `getPostById` 相同。 */
export async function getCommentById(
  db: Database,
  params: { id: string },
): Promise<CommentDetail | null> {
  const rows = await db
    .select(commentDetailColumns)
    .from(comments)
    .where(eq(comments.id, params.id))
    .limit(1);

  return rows[0] ?? null;
}

/** 软删除评论，语义与 `softDeletePost` 相同（含幂等条件）。 */
export async function softDeleteComment(
  db: Database,
  params: { id: string; now: Date },
): Promise<void> {
  await db
    .update(comments)
    .set({ deletedAt: params.now })
    .where(and(eq(comments.id, params.id), isNull(comments.deletedAt)));
}

/*
 * 点赞
 */

/**
 * 点赞一个帖子。**重复点赞不是错误**：主键 `(post_id, user_id)` 挡下冲突后什么都不做。
 *
 * 用 `ON CONFLICT DO NOTHING` 而不是「先查再插」：双击点赞会并发两次请求，后者会让第二次
 * 拿到一个「已存在」的报错并弹给用户，而这本来是无意义的（`docs/PRD.md` 3.2 验收 2）。
 *
 * 返回 `true` 表示这次**真的插进去了**，`false` 表示本来就已经点过。领域层靠它决定要不要把
 * 计数缓存加一：不带 `returning` 的话重复点赞会把计数加两次，而缓存要等 60 秒后重建才修得
 * 回来，那 60 秒里用户看到的是错的。`ON CONFLICT DO NOTHING ... RETURNING` 在冲突时不返回
 * 行，正好表达这件事。
 */
export async function addReaction(
  db: Database,
  params: { postId: string; userId: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .insert(reactions)
    .values({ postId: params.postId, userId: params.userId, createdAt: params.now })
    .onConflictDoNothing()
    .returning({ postId: reactions.postId });

  return rows.length > 0;
}

/**
 * 取消点赞：删行。取消一个没点过赞的帖子不是错误，删除 0 行就是想要的结果。
 *
 * 返回 `true` 表示这次**真的删掉了一行**，理由与 `addReaction` 对称：取消一个没点过赞的
 * 帖子不该把计数减一。
 */
export async function removeReaction(
  db: Database,
  params: { postId: string; userId: string },
): Promise<boolean> {
  const rows = await db
    .delete(reactions)
    .where(and(eq(reactions.postId, params.postId), eq(reactions.userId, params.userId)))
    .returning({ postId: reactions.postId });

  return rows.length > 0;
}

/**
 * 这一页里当前用户点过赞的帖子 id。空入参直接返回空数组：`inArray` 配空数组会生成
 * 恒假条件，不如在调用点就把「没有帖子」这件事处理掉。
 */
export async function listLikedPostIds(
  db: Database,
  params: { userId: string; postIds: string[] },
): Promise<string[]> {
  if (params.postIds.length === 0) {
    return [];
  }

  const rows = await db
    .select({ postId: reactions.postId })
    .from(reactions)
    .where(and(eq(reactions.userId, params.userId), inArray(reactions.postId, params.postIds)));

  return rows.map((row) => row.postId);
}

/** 单个帖子的点赞数（缓存缺失时的重建来源）。 */
export async function countReactionsByPost(
  db: Database,
  params: { postId: string },
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(reactions)
    .where(eq(reactions.postId, params.postId));

  return rows[0]?.value ?? 0;
}

/**
 * 一批帖子的点赞数，供列表页一次补齐缓存。**只返回有点赞的帖子**：缺的键按 0 处理，
 * 调用方不需要为「没有点赞的帖子」多走一次查询。
 */
export async function countReactionsByPosts(
  db: Database,
  params: { postIds: string[] },
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (params.postIds.length === 0) {
    return counts;
  }

  const rows = await db
    .select({ postId: reactions.postId, value: count() })
    .from(reactions)
    .where(inArray(reactions.postId, params.postIds))
    .groupBy(reactions.postId);

  for (const row of rows) {
    counts.set(row.postId, row.value);
  }

  return counts;
}

/*
 * 举报
 */

/**
 * 该举报人对该目标**尚未处理**的那条举报。`createReport` 用它做幂等：重复举报返回既有那条，
 * 而不是再写一行。部分唯一索引是并发下的兜底，两者合起来才完整。
 */
export async function findOpenReport(
  db: Database,
  params: { reporterId: string; targetType: ReportTargetType; targetId: string },
): Promise<ReportListItem | null> {
  const rows = await db
    .select(reportListColumns)
    .from(reports)
    .where(
      and(
        eq(reports.reporterId, params.reporterId),
        eq(reports.targetType, params.targetType),
        eq(reports.targetId, params.targetId),
        eq(reports.status, 'open'),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * 落一行举报。**返回 `null` 表示撞上了唯一约束**（同一举报人对同一目标已有一条未处理举报），
 * 调用方据此回读既有那条。不用传 `status`：新建的举报一定是 `open`（列默认值）。
 */
export async function insertReport(
  db: Database,
  report: NewReport,
): Promise<ReportListItem | null> {
  const rows = await db
    .insert(reports)
    .values(report)
    .onConflictDoNothing()
    .returning(reportListColumns);

  return rows[0] ?? null;
}

/** 单条举报。审核路径要靠它判断当前状态（是否还能处理）。 */
export async function getReportById(
  db: Database,
  params: { id: string },
): Promise<ReportListItem | null> {
  const rows = await db
    .select(reportListColumns)
    .from(reports)
    .where(eq(reports.id, params.id))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * 待处理举报列表，最早的在前（`/admin/reports` 是个队列，先来先处理）。
 *
 * 走 `reports_status_created_idx`。**不分页**：M3 的待处理列表是给人看的短队列，
 * 上限由调用方给，后台的筛选与分页留给 M5（SPEC 已知债务）。
 */
export async function listPendingReports(
  db: Database,
  params: { limit: number },
): Promise<ReportListItem[]> {
  return db
    .select(reportListColumns)
    .from(reports)
    .where(eq(reports.status, 'open'))
    .orderBy(asc(reports.createdAt))
    .limit(clampLimit(params.limit));
}

/**
 * 处理一条举报，**并在同一个事务里完成三件事**（红线 8）：
 *
 * 1. 条件更新举报：`where status = 'open'`。**这是并发防线**——两个管理员同时点「确认下架」，
 *    只有一个能拿到行，另一个得到 `null`，不会出现两条内容操作或两行审计。
 * 2. 确认下架时软删目标（帖子或评论），条件同样带 `deleted_at is null`。
 * 3. 写审计行。
 *
 * 举报不再处于 `open` 时**直接返回 `null`，什么都不做**：事务空提交，没有内容被删、
 * 没有审计行。领域层把它翻译成 `reportAlreadyHandled`。
 *
 * 顺序与 SPEC 第 4 节写的略有差别（先条件更新举报，再删内容）：不先在事务内确认举报仍是
 * `open`，就可能删掉一条已经被别人处理过的举报所指的内容。三步同事务，外部可观测结果一致。
 */
export async function resolveReport(
  db: Database,
  params: {
    reportId: string;
    status: Exclude<ReportStatus, 'open'>;
    handledBy: string;
    handledAt: Date;
    audit: NewAuditLog;
  },
): Promise<ReportListItem | null> {
  return db.transaction(async (tx) => {
    const resolved = await tx
      .update(reports)
      .set({ status: params.status, handledBy: params.handledBy, handledAt: params.handledAt })
      .where(and(eq(reports.id, params.reportId), eq(reports.status, 'open')))
      .returning(reportListColumns);

    const report = resolved[0];
    if (!report) {
      return null;
    }

    if (params.status === 'takedown') {
      if (report.targetType === 'post') {
        await tx
          .update(posts)
          .set({ deletedAt: params.handledAt })
          .where(and(eq(posts.id, report.targetId), isNull(posts.deletedAt)));
      } else {
        await tx
          .update(comments)
          .set({ deletedAt: params.handledAt })
          .where(and(eq(comments.id, report.targetId), isNull(comments.deletedAt)));
      }
    }

    await tx.insert(auditLogs).values(params.audit);

    return report;
  });
}

/*
 * 审计日志
 */

/**
 * 审计日志一页。**只读**：这张表只有 INSERT 与 SELECT——迁移 `0002_community_tables.sql`
 * 末尾的手写触发器会拒绝 `UPDATE` / `DELETE` / `TRUNCATE`。
 *
 * 时间倒序，走 `audit_logs_created_idx`。谁能看由调用方（领域层）判定，这里不做判断。
 */
export async function listAuditLogs(
  db: Database,
  params: { limit: number },
): Promise<AuditLogListItem[]> {
  return db
    .select(auditLogListColumns)
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(clampLimit(params.limit));
}

/*
 * 作者摘要
 */

/**
 * 内容列表要显示的作者信息。
 *
 * **不含 `email`**：社区列表是公开页面（`docs/spec/SPEC-community.md` 第 7 节，`(site)` 分区），
 * 邮箱不是给访客看的东西。需要邮箱的场合（后台用户管理，M5）自己取，不复用这个投影。
 */
export type AuthorSummary = {
  id: string;
  name: string;
  image: string | null;
};

/**
 * 一批用户 id → 作者摘要。列表页拿到帖子后一次补齐作者名与头像。
 *
 * 缺的 id 不会出现在返回值里（调用方自己决定怎么显示「作者已注销」）：`posts.author_id` 是
 * 级联删除，作者被删时内容跟着没了，所以正常路径上不该缺——真缺了就是数据异常，静默补一个
 * 假名字反而会把它盖住。
 *
 * 与 `listLikedPostIds` 同一条：空入参直接返回空表，`inArray` 配空数组会生成恒假条件。
 */
export async function listAuthorSummaries(
  db: Database,
  params: { userIds: string[] },
): Promise<Map<string, AuthorSummary>> {
  const authors = new Map<string, AuthorSummary>();
  if (params.userIds.length === 0) {
    return authors;
  }

  const rows = await db
    .select({ id: user.id, name: user.name, image: user.image })
    .from(user)
    .where(inArray(user.id, params.userIds));

  for (const row of rows) {
    authors.set(row.id, row);
  }

  return authors;
}
