/**
 * 社区五张表：帖子、评论、点赞、举报、审计日志。
 *
 * 规则（输入约束、配额、归属、软删除可见性、举报的三态流转）全在 `@xsu/core` 的
 * `src/community/`，本文件只负责持久化。表结构的事实来源是 `docs/spec/SPEC-community.md`
 * 第 3 节与 `docs/DATA-MODEL.md`；本文件与之不一致即为缺陷。
 *
 * 四处需要解释的取舍：
 *
 * 1. **软删除（`deleted_at`）而不是删行。** 帖子与评论要留行：举报与审计日志指向它们，
 *    行没了审计就成了悬空引用。可见性由查询里的 `deleted_at is null` 决定，所以列表、详情、
 *    搜索、评论收集这四处**都必须带这个条件**——漏一处就是「删了还能搜到」。
 * 2. **标签是 `posts.tags text[]`，没有 `tags` 表。** 关系表多出来的能力是改名、合并、每标签
 *    计数，三者都落在后台管理（M5）。理由与代价见 SPEC 第 2 节。
 * 3. **`reactions` 的主键就是并发防线。** `(post_id, user_id)` 主键让重复点赞变成一次唯一约束
 *    冲突，仓储用 `ON CONFLICT DO NOTHING` 把它翻译成幂等结果，不靠「先查再插」。
 * 4. **`reports` / `audit_logs` 的目标 id 没有外键。** 目标是多态的（帖子或评论），且审计要活得
 *    比被引用行久。代价是被引用行硬删时会留下悬空 id，登记在 SPEC 的已知债务里。
 *
 * **`check` 只用来兜底枚举取值**（与 `tools.ts` 同一取舍）：长度上限、标签数量这类规则留在
 * 领域层，写进数据库就是第二个事实来源。
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { user } from './auth';

/** 举报与审计日志都指向的两类内容。 */
export const REPORT_TARGET_TYPES = ['post', 'comment'] as const;

export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

/**
 * 审计日志的目标类型：内容两类 + M5 新增的用户与站点配置。与 `REPORT_TARGET_TYPES`
 * 分开定义——举报目标将来加新值不必然连着审计扩展，两份枚举各自演进。
 */
export const AUDIT_TARGET_TYPES = ['post', 'comment', 'user', 'site_config'] as const;

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/**
 * 举报的三态：待处理 → 确认下架 / 驳回。
 *
 * **没有「已撤回」也没有「已删除」**：举报不删行，终态就是它的历史。用户撤回举报与申诉
 * 都不在 M3 范围（见 SPEC 第 1 节）。
 */
export const REPORT_STATUSES = ['open', 'takedown', 'dismissed'] as const;

export type ReportStatus = (typeof REPORT_STATUSES)[number];

/**
 * 点赞的种类。M3 只有一种，`kind` 列是给第二种表情留的位置。
 *
 * **加第二种时唯一约束必须一起改**：现在是 `(post_id, user_id)` 主键，同一个人对同一个帖子
 * 只能有一种反应。这些都在 SPEC 的已知债务里。
 */
export const REACTION_KINDS = ['like'] as const;

export type ReactionKind = (typeof REACTION_KINDS)[number];

export const posts = pgTable(
  'posts',
  {
    id: text('id').primaryKey(),
    /** 归属（红线 6）。跨用户编辑 / 删除必须在领域层拒绝。 */
    authorId: text('author_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** 标签数组。trim、转小写、去重、数量与长度上限都在领域层（SPEC 第 4.3 节）。 */
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** 由领域层传入的时间点（配额窗口与展示用同一个，同 `tool_runs`）。 */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** 编辑时由仓储显式写。**不用 `$onUpdate`**：时间点只允许有一个来源。 */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** 软删除标记。非空即对所有人不可见；详情查询要能读到它，用于区分「不存在」与「已删除」。 */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    /**
     * 公开列表、按标签浏览、搜索共用的排序索引。**部分索引是有意的**：这三个查询都带
     * `deleted_at is null`，把已删除的行排除在索引之外，翻页就不会被它们拖慢。
     * 谓词必须与查询里的写法一致，否则规划器用不上它。
     */
    index('posts_feed_idx')
      .on(table.createdAt, table.id)
      .where(sql`${table.deletedAt} is null`),
    /**
     * 一个索引服务两件事：发文配额计数（`WHERE author_id = ? AND created_at >= ?`）与
     * 「我的帖子」列表。**故意不做部分索引**——配额计的是「这段时间发了几篇」，
     * 被作者自己删掉的帖子一样占用了配额，排除掉就会算少。
     */
    index('posts_author_idx').on(table.authorId, table.createdAt),
    /** 按标签浏览：`tags @> array[?]` 走 GIN，与上面的部分索引配合收窄到未删除的行。 */
    index('posts_tags_idx')
      .using('gin', table.tags)
      .where(sql`${table.deletedAt} is null`),
  ],
);

export const comments = pgTable(
  'comments',
  {
    id: text('id').primaryKey(),
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /** 归属（红线 6）。 */
    authorId: text('author_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** 软删除标记，理由同 `posts.deletedAt`。 */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    /** 详情页评论列表 + 评论游标分页。带上 `id` 是因为排序里它是第二排序键。 */
    index('comments_post_idx')
      .on(table.postId, table.createdAt, table.id)
      .where(sql`${table.deletedAt} is null`),
    /**
     * 评论配额计数（`WHERE author_id = ? AND created_at >= ?`）。**不做部分索引**，
     * 理由与 `posts_author_idx` 相同：删掉的评论也占用了那次配额。
     */
    index('comments_author_idx').on(table.authorId, table.createdAt),
  ],
);

/**
 * 点赞。**取消点赞是删行，不是置标志位**（同 `tool_favorites`）：点赞没有历史语义，
 * 留一行 `liked: false` 只会让计数与查询都多一个条件。
 *
 * 没有 `id` 列：`(post_id, user_id)` 就是主键，重复点赞由它挡下。也因为主键是这两列，
 * 「这一页里我点过哪些」（`WHERE user_id = ? AND post_id IN (...)`）不需要额外索引。
 */
export const reactions = pgTable(
  'reactions',
  {
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /** 归属（红线 6）。 */
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: REACTION_KINDS }).notNull().default('like'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'reactions_pk', columns: [table.postId, table.userId] }),
    /** 取值约束的数据库侧落点；加第二种表情时这里与主键一起改。 */
    check('reactions_kind_check', sql`${table.kind} in ('like')`),
  ],
);

/**
 * 举报。**举报本身不改变任何内容状态**（PRD 3.2 验收 4）：本表只记录「谁举报了哪条内容」，
 * 内容是否下架由管理员在 `/admin/reports` 上决定，并留下审计行。
 */
export const reports = pgTable(
  'reports',
  {
    id: text('id').primaryKey(),
    /** 归属（红线 6）：举报人只能看到自己的举报。 */
    reporterId: text('reporter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    targetType: text('target_type', { enum: REPORT_TARGET_TYPES }).notNull(),
    /** 被举报内容的 id。**无外键**：目标是多态的，见文件头第 4 条。 */
    targetId: text('target_id').notNull(),
    reason: text('reason').notNull(),
    status: text('status', { enum: REPORT_STATUSES }).notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** 处理人。**用 `set null` 而不是级联删**：处理人账号消失不该抹掉「有人处理过」。 */
    handledBy: text('handled_by').references(() => user.id, { onDelete: 'set null' }),
    handledAt: timestamp('handled_at', { withTimezone: true }),
  },
  (table) => [
    /**
     * 同一举报人对同一目标**最多一条未处理举报**（部分唯一索引）。重复举报在领域层被翻译成
     * 幂等结果（返回既有那条），这条索引是并发下的兜底——不靠「先查再插」。
     */
    uniqueIndex('reports_open_unique_idx')
      .on(table.reporterId, table.targetType, table.targetId)
      .where(sql`${table.status} = 'open'`),
    /** 后台待处理列表：`WHERE status = 'open' ORDER BY created_at`。 */
    index('reports_status_created_idx').on(table.status, table.createdAt),
    check('reports_target_type_check', sql`${table.targetType} in ('post', 'comment')`),
    check('reports_status_check', sql`${table.status} in ('open', 'takedown', 'dismissed')`),
    /**
     * 「待处理」与「还没有处理时间」必须同时成立。领域层本来就是成对写的，这条是兜底：
     * 真出现「已确认下架但没有处理时间」的行，审计就断了一截。
     */
    check('reports_handled_check', sql`(${table.status} = 'open') = (${table.handledAt} is null)`),
  ],
);

/**
 * 审计日志（红线 8）。**只追加**：迁移 `0002_community_tables.sql` 末尾手写了两个触发器
 * （行级 `BEFORE UPDATE OR DELETE` + 语句级 `BEFORE TRUNCATE`）直接 `RAISE EXCEPTION`。它们
 * 不在 drizzle 的 schema 里（drizzle-kit 不表达触发器）。残余风险：同一套凭据能 `DISABLE TRIGGER`。
 *
 * `detail` 是给人看的一句话（含举报 id 等上下文）。要按字段筛选或统计时再加结构化列，
 * 现在没有这个需求，先不引入 `jsonb`。
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    /** 谁做的。**审计行随账号删除而消失是有意的取舍**：没有 actor 的审计行无法追责。 */
    actorId: text('actor_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 动作标识，形如 `report.takedown`。取值会持续增加，所以**不加 `check`**。 */
    action: text('action').notNull(),
    /** 审计目标比举报多两类：用户与站点配置（M5）。 */
    targetType: text('target_type', { enum: AUDIT_TARGET_TYPES }).notNull(),
    targetId: text('target_id').notNull(),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** 审计列表按时间倒序，没有筛选条件时就走它。 */
    index('audit_logs_created_idx').on(table.createdAt),
    index('audit_logs_actor_idx').on(table.actorId, table.createdAt),
    /** 「这条内容被谁下架过」。 */
    index('audit_logs_target_idx').on(table.targetType, table.targetId, table.createdAt),
    check(
      'audit_logs_target_type_check',
      sql`${table.targetType} in ('post', 'comment', 'user', 'site_config')`,
    ),
  ],
);

/*
 * 以下是列表与详情的投影。与 `tools.ts` 同一套做法：投影类型与投影对象放在表旁边，
 * 表现层直接引用；表结构改了而页面还按旧字段读会被编译器拦下。加字段时两处一起改。
 */

/** 列表卡片需要的字段。**不含正文**——列表不渲染正文，少取一列省一次 IO。 */
export type PostListItem = {
  id: string;
  authorId: string;
  title: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
};

export const postListColumns = {
  id: posts.id,
  authorId: posts.authorId,
  title: posts.title,
  tags: posts.tags,
  createdAt: posts.createdAt,
  updatedAt: posts.updatedAt,
};

/**
 * 详情多出正文与软删除标记。
 *
 * **`deletedAt` 是有用的**：详情读取**不过滤** `deleted_at`，才能区分「这个 id 不存在」（404）
 * 与「存在但已被删除 / 下架」（统一的拒绝视图）。
 */
export type PostDetail = PostListItem & {
  body: string;
  deletedAt: Date | null;
};

export const postDetailColumns = {
  ...postListColumns,
  body: posts.body,
  deletedAt: posts.deletedAt,
};

export type CommentListItem = {
  id: string;
  postId: string;
  authorId: string;
  body: string;
  createdAt: Date;
};

export const commentListColumns = {
  id: comments.id,
  postId: comments.postId,
  authorId: comments.authorId,
  body: comments.body,
  createdAt: comments.createdAt,
};

/**
 * 评论详情的投影：比列表项多一个软删除标记，理由与 `PostDetail.deletedAt` 相同——
 * 单条读取**不过滤** `deleted_at`，才能区分「这个 id 不存在」与「存在但已被删除 / 下架」。
 */
export type CommentDetail = CommentListItem & {
  deletedAt: Date | null;
};

export const commentDetailColumns = {
  ...commentListColumns,
  deletedAt: comments.deletedAt,
};
export type ReportListItem = {
  id: string;
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  status: ReportStatus;
  createdAt: Date;
  handledBy: string | null;
  handledAt: Date | null;
};

export const reportListColumns = {
  id: reports.id,
  reporterId: reports.reporterId,
  targetType: reports.targetType,
  targetId: reports.targetId,
  reason: reports.reason,
  status: reports.status,
  createdAt: reports.createdAt,
  handledBy: reports.handledBy,
  handledAt: reports.handledAt,
};

export type AuditLogListItem = {
  id: string;
  actorId: string;
  action: string;
  targetType: AuditTargetType;
  targetId: string;
  detail: string | null;
  createdAt: Date;
};

export const auditLogListColumns = {
  id: auditLogs.id,
  actorId: auditLogs.actorId,
  action: auditLogs.action,
  targetType: auditLogs.targetType,
  targetId: auditLogs.targetId,
  detail: auditLogs.detail,
  createdAt: auditLogs.createdAt,
};
