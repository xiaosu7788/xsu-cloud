/**
 * 后台管理（M5）的公共契约：约束常量、审计动作、失败码表、读模型、端口。
 *
 * 与 `community/types.ts` 同一套分工：本文件只有声明，判定在 `./rules.ts`，
 * 执行顺序在各操作文件里。端口由调用方注入，唯一装配点是 `packages/platform/src/admin.ts`。
 *
 * 两条贯穿约定：
 *
 * 1. **管理员判定是每个入口的第一步**（含只读入口）——「看」与「改」都只属于管理员，
 *    判定复用 `../access` 的 `isAdmin`，失败码用本模块的 `ADMIN_FAILURE.notAdmin`。
 * 2. **审计行与业务写同事务**（红线 8）。领域层把审计记录作为参数传给端口，
 *    仓储负责「条件 UPDATE + INSERT audit_logs (+ 其他级联写)」在同一次事务里完成——
 *    样板是社区仓储的 `resolveReport`。领域层没有任何绕过端口写审计的路径。
 */
import type {
  AuditLogListItem,
  AuditTargetType,
  CommentListItem,
  PostListItem,
  SiteConfigDetail,
} from '@xsu/db/schema';

import type { Role } from '../access';

/** 封禁理由的长度上限（码点）。留空表示「无理由」，允许。 */
export const BAN_REASON_MAX_CHARS = 200;

/** 后台列表的页大小缺省值与上限（偏移分页，带总数）。 */
export const ADMIN_PAGE_SIZE_DEFAULT = 20;
export const ADMIN_PAGE_SIZE_MAX = 100;

/** 配额覆盖的取值上限。事实来源是数据层（列 CHECK 与这里同数），这里转出给领域层校验。 */
export { SITE_CONFIG_QUOTA_MAX } from '@xsu/db/schema';

/**
 * M5 新增的审计动作。取值风格与 `community/types.ts` 的 `AUDIT_ACTION` 一致：
 * `audit_logs.action` 故意不加数据库 `check`，动作只会越来越多。
 */
export const ADMIN_AUDIT_ACTION = {
  userRoleUpdate: 'user.role.update',
  userBan: 'user.ban',
  userUnban: 'user.unban',
  postTakedown: 'admin.post.takedown',
  postRestore: 'admin.post.restore',
  commentTakedown: 'admin.comment.takedown',
  commentRestore: 'admin.comment.restore',
  siteConfigUpdate: 'site.config.update',
} as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTION)[keyof typeof ADMIN_AUDIT_ACTION];

/**
 * 失败码表（`SPEC-admin.md` 3.1）。形状与 `CONTENT_FAILURE` / `ACCESS_DENIED` 一致，
 * 不造第二套。`field` 让表单能指出是哪个字段。
 */
export const ADMIN_FAILURE = {
  /** 不是管理员。所有入口的第一步。 */
  notAdmin: {
    status: 403,
    code: 'ADMIN_NOT_ADMIN',
    message: '只有管理员可以执行后台操作。',
  },
  /** 目标用户不存在。 */
  userNotFound: {
    status: 404,
    code: 'ADMIN_USER_NOT_FOUND',
    message: '这个用户不存在。',
  },
  /** 禁止修改自己的角色（防自锁第一规则）。 */
  selfRoleChange: {
    status: 403,
    code: 'ADMIN_SELF_ROLE_CHANGE',
    message: '不能修改自己的角色。',
  },
  /** 禁止封禁自己（防自锁第二规则）。 */
  selfBan: {
    status: 403,
    code: 'ADMIN_SELF_BAN',
    message: '不能封禁自己的账号。',
  },
  /** 最后一名管理员的降权 / 封禁被拒绝（防自锁第三规则，条件 UPDATE 兜底）。 */
  lastAdmin: {
    status: 409,
    code: 'ADMIN_LAST_ADMIN',
    message: '站点至少要保留一名管理员。',
  },
  /** 目标帖子不存在。 */
  postNotFound: {
    status: 404,
    code: 'ADMIN_POST_NOT_FOUND',
    message: '这篇帖子不存在。',
  },
  /** 目标评论不存在。 */
  commentNotFound: {
    status: 404,
    code: 'ADMIN_COMMENT_NOT_FOUND',
    message: '这条评论不存在。',
  },
  /** 父帖已删除，评论不能单独恢复（恢复会让评论出现在一个不可见的帖子里）。 */
  parentPostDeleted: {
    status: 409,
    code: 'ADMIN_PARENT_POST_DELETED',
    message: '父帖已删除，无法恢复这条评论。',
  },
  /** 角色 / 封禁理由 / 配额值不合法。`field` 指出是哪个字段。 */
  inputInvalid: {
    status: 400,
    code: 'ADMIN_INPUT_INVALID',
    message: '提交的内容不完整或格式不正确。',
  },
} as const;

export type AdminFailureCode = keyof typeof ADMIN_FAILURE;

export type AdminFailure = (typeof ADMIN_FAILURE)[AdminFailureCode] & {
  field?: string;
  cause?: unknown;
};

/** 后台读模型的用户行（搜索列表与单条读取同形）。 */
export type AdminUserView = {
  id: string;
  name: string;
  email: string;
  role: string;
  bannedAt: Date | null;
  banReason: string | null;
  createdAt: Date;
};

/** 后台内容列表行：在公开投影之上多一个软删除标记（页面据此渲染「已下架 / 已删除」）。 */
export type AdminPostRow = PostListItem & { deletedAt: Date | null };
export type AdminCommentRow = CommentListItem & { deletedAt: Date | null };

/** 后台概览（`/admin`）的计数聚合。全部是行数，不做任何耗时统计。 */
export type AdminOverview = {
  userCount: number;
  postCount: number;
  commentCount: number;
  openReportCount: number;
  toolRunCount: number;
};

/** 偏移分页的一页（后台列表都是短列表，偏移 + 总数比游标更直观）。 */
export type AdminPage<T> = { items: T[]; total: number };

/** 后台任务管理的只读统计（`tool_runs` 按 `status` 与工具维度聚合计数）。 */
export type AdminToolRunStats = {
  total: number;
  succeeded: number;
  failed: number;
  byTool: { toolSlug: string; runs: number; failed: number }[];
};

/** 落一条 M5 审计行所需的字段。`targetType` 扩到四类（`AUDIT_TARGET_TYPES`）。 */
export type AdminAuditLogRecord = {
  id: string;
  actorId: string;
  action: AdminAuditAction;
  targetType: AuditTargetType;
  targetId: string;
  detail: string | null;
  createdAt: Date;
};

/**
 * 「怎么做」的抽象：本模块需要的全部外部能力。
 *
 * 参数形状刻意与数据层仓储一一对应，装配点
 * `packages/platform/src/admin.ts` 应该只是「把仓储函数原样接上」。事务形端口
 * （带 `audit` 参数的）负责把「业务写 + 审计写」锁进同一次事务，对应社区仓储
 * `resolveReport` 的样板；`actorId` 一律传操作者。
 */
export type AdminPorts = {
  now: () => Date;
  newId: () => string;

  /* ---- 用户管理 ---- */
  /** 单条读取（按 id）。**不过滤封禁状态**：后台要能看见被封禁的人。 */
  getAdminUserById: (params: { id: string }) => Promise<AdminUserView | null>;
  /** 条件改角色：`lastAdmin` 防线在 SQL 里，0 行 = 没改成。审计行同事务。 */
  updateUserRole: (params: {
    userId: string;
    role: Role;
    audit: AdminAuditLogRecord;
  }) => Promise<boolean>;
  /** 条件封禁 + 删该用户全部会话 + 审计，同事务；0 行 = 没改成。 */
  banUser: (params: {
    userId: string;
    reason: string | null;
    audit: AdminAuditLogRecord;
  }) => Promise<boolean>;
  /** 条件解封 + 审计，同事务；0 行 = 没改成。 */
  unbanUser: (params: { userId: string; audit: AdminAuditLogRecord }) => Promise<boolean>;

  /* ---- 内容管理 ---- */
  /** 条件下架帖子（`WHERE deleted_at IS NULL`）+ 审计，同事务；0 行 = 已下架或不存在。 */
  adminTakedownPost: (params: {
    postId: string;
    now: Date;
    audit: AdminAuditLogRecord;
  }) => Promise<boolean>;
  /** 条件恢复帖子（`WHERE deleted_at IS NOT NULL`）+ 审计，同事务；0 行 = 未下架或不存在。 */
  adminRestorePost: (params: {
    postId: string;
    now: Date;
    audit: AdminAuditLogRecord;
  }) => Promise<boolean>;
  /** 条件下架评论 + 审计，同事务；0 行 = 已下架或不存在。 */
  adminTakedownComment: (params: {
    commentId: string;
    now: Date;
    audit: AdminAuditLogRecord;
  }) => Promise<boolean>;
  /** 条件恢复评论（要求父帖未删除）+ 审计，同事务；0 行 = 未下架 / 不存在 / 父帖已删。 */
  adminRestoreComment: (params: {
    commentId: string;
    now: Date;
    audit: AdminAuditLogRecord;
  }) => Promise<boolean>;

  /* ---- 站点配置 ---- */
  /** 读单例行（无行返回 `null`，页面显示「尚未设置过」）。 */
  getSiteConfig: () => Promise<SiteConfigDetail | null>;
  /** upsert + 审计同事务。 */
  updateSiteConfig: (params: {
    postQuotaPerHour: number | null;
    commentQuotaPerHour: number | null;
    toolQuotaPerHour: number | null;
    updatedBy: string;
    now: Date;
    audit: AdminAuditLogRecord;
  }) => Promise<void>;

  /* ---- 读侧（列表与概览） ---- */
  /** 用户列表：`query` 非空时按邮箱/名字模糊匹配。**包含被封禁用户**。 */
  /** 单条读帖子（不过滤软删除），内容管理预检用。 */
  getAdminPostById: (params: { id: string }) => Promise<AdminPostRow | null>;
  /** 单条读评论（不过滤软删除），内容管理预检用。 */
  getAdminCommentById: (params: { id: string }) => Promise<AdminCommentRow | null>;
  listUsersForAdmin: (params: {
    query: string;
    limit: number;
    offset: number;
  }) => Promise<AdminPage<AdminUserView>>;
  /** 帖子列表（含软删除行，按创建时间倒序）。 */
  listPostsForAdmin: (params: {
    limit: number;
    offset: number;
  }) => Promise<AdminPage<AdminPostRow>>;
  /** 评论列表（含软删除行，按创建时间倒序）。 */
  listCommentsForAdmin: (params: {
    limit: number;
    offset: number;
  }) => Promise<AdminPage<AdminCommentRow>>;
  /** 概览计数（五次 COUNT，不做耗时统计）。 */
  getAdminOverview: () => Promise<AdminOverview>;
  /** 审计日志列表（含 M5 之前的社区审计行，按时间倒序）。 */
  listAuditLogsForAdmin: (params: {
    limit: number;
    offset: number;
  }) => Promise<AdminPage<AuditLogListItem>>;

  /* ---- 任务管理（只读） ---- */
  listToolRunStats: () => Promise<AdminToolRunStats>;
  listToolRunsForAdmin: (params: { limit: number }) => Promise<AdminToolRunRow[]>;
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

/** 通用结果形状：失败一律来自 `ADMIN_FAILURE`，不造第二套。 */
export type AdminOutcome<T> = { ok: true; value: T } | { ok: false; failure: AdminFailure };
