/**
 * 社区的公共契约：约束常量、失败码表、要落库的记录形状、以及领域层需要的外部能力（端口）。
 *
 * **本文件只有声明，没有判定。** 归一化、校验、游标编解码、分页切片、归属判定都在 `./rules.ts`；
 * 「先做什么后做什么」在各个操作文件里。这样拆的理由是依赖方向：四个操作文件
 * （`posts` / `comments` / `reactions` / `reports`）都要用这里的端口与失败码，而端口又要引用它们的
 * 记录形状——契约单独放一份，依赖就是单向的（与 `tools/types.ts` 同一理由）。
 *
 * 三条贯穿全模块的约定：
 *
 * 1. **判定在领域层，数据访问在端口后面。** 端口由调用方注入，唯一装配点是
 *    `packages/platform/src/community.ts`。本模块因此不 import 任何仓储，只 import 数据层的
 *    schema 类型（形状的事实来源仍然是 `packages/db/src/schema/community.ts`）。
 * 2. **时间点一律从 `ports.now()` 取**，不在领域层 `new Date()`：配额窗口的「现在」与落库的
 *    `created_at` 必须是同一个时间点，否则会出现「算的时候没超、写下去就超了」。
 * 3. **配额拒绝既不落行也不计数**（与工具箱同一条理由）：否则「被拒 → 计数 +1 → 更容易被拒」
 *    会自我放大，用户越试越久才能再发。
 */
import type {
  AuditLogListItem,
  CommentDetail,
  CommentListItem,
  PostDetail,
  PostListItem,
  ReportListItem,
  ReportStatus,
  ReportTargetType,
} from '@xsu/db/schema';

/** 帖子标题的长度上限（**码点**，不是 UTF-16 码元，也不是字节）。 */
export const POST_TITLE_MAX_CHARS = 120;

/** 帖子正文的长度上限（码点）。 */
export const POST_BODY_MAX_CHARS = 20000;

/** 评论正文的长度上限（码点）。 */
export const COMMENT_BODY_MAX_CHARS = 2000;

/** 单篇帖子的标签数量上限。按**归一化去重之后**的个数算。 */
export const POST_TAG_MAX_COUNT = 5;

/** 单个标签的长度上限（码点）。 */
export const POST_TAG_MAX_CHARS = 24;

/** 举报理由的长度上限（码点）。 */
export const REPORT_REASON_MAX_CHARS = 500;

/** 页大小的缺省值。列表、评论、按标签浏览、搜索共用。 */
export const COMMUNITY_PAGE_SIZE_DEFAULT = 20;

/**
 * 页大小的上限。请求越界时被收进这个值，**不报错**：翻页是幂等的读操作，
 * 为了一个过大或写错的 `limit` 让整页 400 没有收益（与工具箱分页同一取舍）。
 */
export const COMMUNITY_PAGE_SIZE_MAX = 50;

/**
 * 后台列表（待处理举报、审计日志）一次取多少行。
 *
 * 这两个列表在 M3 都不分页：它们是给人处理的短队列，筛选与分页留给 M5。
 */
export const ADMIN_LIST_LIMIT_DEFAULT = 50;

/** 配额窗口长度。改这里等于改「单位时间」的定义。 */
export const COMMUNITY_QUOTA_WINDOW_MS = 60 * 60 * 1000;

/**
 * 发帖配额缺省值，配置项是 `POST_QUOTA_PER_HOUR`（`packages/platform/src/env.ts`）。
 *
 * **这是缺省，不是容量评估的结论**：`docs/PRD.md` 3.2 明确说配额数值待实际使用中定。
 * 取 10 是因为它够一个人正常发帖，同时让「超限」这条验收在测试里容易构造。
 */
export const POST_QUOTA_PER_HOUR_DEFAULT = 10;

/** 评论配额缺省值，配置项是 `COMMENT_QUOTA_PER_HOUR`。理由同上。 */
export const COMMENT_QUOTA_PER_HOUR_DEFAULT = 30;

/**
 * 审计日志的 `action` 取值。
 *
 * 与 `posts.tags` 一样，这是**代码里的字面量**而不是数据库枚举：`audit_logs.action` 故意不加
 * `check`，因为这张表要记的动作只会越来越多，每次加一个动作就写一条迁移是过度约束。
 */
export const AUDIT_ACTION = {
  /** 管理员确认下架：举报成立，内容被软删除。 */
  reportTakedown: 'report.takedown',
  /** 管理员驳回举报：内容保持可见。 */
  reportDismiss: 'report.dismiss',
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

/**
 * 失败码表（全站唯一来源）。
 *
 * 形状与 `ACCESS_DENIED`、`TOOL_FAILURE` 一致：`status` 与 `code` 给应用层组装 HTTP 响应与
 * 错误码，`message` 是给用户看的中文文案。新增失败原因加在这里，**不要在调用点就地造**。
 *
 * `notAdmin` 与 `ACCESS_DENIED.forbidden` 的状态码相同但**不是同一件事**：后者由路由守卫用来回答
 * 「这个账号能不能进 `(admin)` 分区」，前者回答「这次内容操作要不要管理员」。两者的文案与出现位置
 * 都不同，合成一个会让「进不去分区」和「点了下架但没权限」拿到同一句话。
 */
export const CONTENT_FAILURE = {
  /** 帖子不存在，或已被作者删除 / 被管理员下架。**两种情况对外不区分**。 */
  postNotFound: {
    status: 404,
    code: 'POST_NOT_FOUND',
    message: '这篇帖子不存在或已被删除。',
  },
  /** 评论不存在，或已被删除 / 下架。 */
  commentNotFound: {
    status: 404,
    code: 'COMMENT_NOT_FOUND',
    message: '这条评论不存在或已被删除。',
  },
  /** 帖子存在，但不是当前账号的。 */
  postForbidden: {
    status: 403,
    code: 'POST_FORBIDDEN',
    message: '这不是你的帖子。',
  },
  /** 评论存在，但不是当前账号的。 */
  commentForbidden: {
    status: 403,
    code: 'COMMENT_FORBIDDEN',
    message: '这不是你的评论。',
  },
  /** 必填字段为空、目标类型非法、游标解不出来。 */
  inputInvalid: {
    status: 400,
    code: 'CONTENT_INPUT_INVALID',
    message: '内容不完整或格式不正确。',
  },
  /** 某个字段超出长度上限（帖子标题 / 正文、评论正文、单个标签、举报理由）。 */
  inputTooLarge: {
    status: 400,
    code: 'CONTENT_INPUT_TOO_LARGE',
    message: '内容过长，请精简后重试。',
  },
  /** 标签个数超过 `POST_TAG_MAX_COUNT`。单独一码是为了让表单能指出「是标签太多」。 */
  tagLimitExceeded: {
    status: 400,
    code: 'CONTENT_TAG_LIMIT_EXCEEDED',
    message: '标签最多 5 个，请删掉多余的再发。',
  },
  /** 单位时间内的发文 / 评论次数达到上限。 */
  quotaExceeded: {
    status: 429,
    code: 'CONTENT_QUOTA_EXCEEDED',
    message: '发布太频繁了，请稍后再试。',
  },
  /** 举报不存在。 */
  reportNotFound: {
    status: 404,
    code: 'REPORT_NOT_FOUND',
    message: '这条举报不存在。',
  },
  /** 举报已经处于终态，不能再次处理（含两个管理员同时点同一个按钮）。 */
  reportAlreadyHandled: {
    status: 409,
    code: 'REPORT_ALREADY_HANDLED',
    message: '这条举报已经处理过了。',
  },
  /**
   * 并发写入撞车，且自动收敛失败。
   *
   * 现在只有举报这一条路会出现：唯一约束说「已经有一条未处理的举报」，但按
   * `(举报人, 目标类型, 目标 id, status = 'open')` 回读却查不到。唯一的解释是那条举报在两次查询
   * 之间被处理掉了——此时重试一次就能插进去。**重试之后仍然撞车**才走到这里，用户重试即可。
   */
  writeConflict: {
    status: 409,
    code: 'CONTENT_WRITE_CONFLICT',
    message: '操作有并发冲突，请重试。',
  },
  /** 不是管理员。 */
  notAdmin: {
    status: 403,
    code: 'NOT_ADMIN',
    message: '只有管理员可以处理举报。',
  },
} as const;

export type CommunityFailureCode = keyof typeof CONTENT_FAILURE;

/** 失败码表里的一项。 */
export type CommunityFailureEntry = (typeof CONTENT_FAILURE)[CommunityFailureCode];

/**
 * 带上下文的失败：`field` 指出是哪个字段（表单可以据此高亮），`cause` 只用于记日志。
 * `code` 与 `status` 都能从项里取，所以应用层不需要再判断一次。
 */
export type CommunityFailure = CommunityFailureEntry & { field?: string; cause?: unknown };

/**
 * 点赞计数的外部计数器（实现是 Redis，见 `packages/platform/src/cache.ts`）。
 *
 * 领域层只知道「要加一 / 减一 / 丢掉」，不知道背后是什么。**实现必须自己做 best-effort**：
 * 缓存写失败不能把一次已经落库的点赞变成失败响应——那会让用户以为没点上而反复点。计数是缓存，
 * 数据库里的行才是事实来源，缓存 60 秒后本来就会重建，所以失败只是「这 60 秒里数字不准」。
 */
export type ReactionCountPort = {
  increment: (postId: string) => Promise<void>;
  decrement: (postId: string) => Promise<void>;
  drop: (postId: string) => Promise<void>;
};

/**
 * 「怎么做」的抽象：本模块需要的全部外部能力。时间与 id 也在这里，理由见文件头第 2 条
 * （`tools/run-tool.ts` 的 `ToolRunPorts` 是同一个写法）。
 *
 * 方法名与数据层仓储一一对应，参数形状刻意保持相同：装配点是
 * `packages/platform/src/community.ts`，那里应该只是「把仓储函数原样接上」，不该有翻译逻辑。
 */
export type CommunityPorts = {
  now: () => Date;
  newId: () => string;

  /** 单位时间内的发帖上限。**为 0 表示关闭发帖**（不是「不限」）。 */
  postQuotaPerHour: number;
  /** 单位时间内的评论上限。为 0 表示关闭评论。 */
  commentQuotaPerHour: number;
  countPostsSince: (params: { authorId: string; since: Date }) => Promise<number>;
  countCommentsSince: (params: { authorId: string; since: Date }) => Promise<number>;

  insertPost: (post: PostRecord) => Promise<void>;
  /** **不过滤 `deleted_at`**：领域层要靠 `deletedAt` 区分 404 与统一拒绝视图。 */
  getPostById: (params: { id: string }) => Promise<PostDetail | null>;
  updatePost: (params: {
    id: string;
    title: string;
    body: string;
    tags: string[];
    now: Date;
  }) => Promise<void>;
  softDeletePost: (params: { id: string; now: Date }) => Promise<void>;
  listPosts: (params: {
    limit: number;
    cursor: CommunityCursor | null;
    tag?: string | null;
    query?: string | null;
  }) => Promise<PostListItem[]>;
  listPostsByAuthor: (params: { authorId: string; limit: number }) => Promise<PostListItem[]>;

  insertComment: (comment: CommentRecord) => Promise<void>;
  getCommentById: (params: { id: string }) => Promise<CommentDetail | null>;
  softDeleteComment: (params: { id: string; now: Date }) => Promise<void>;
  listComments: (params: {
    postId: string;
    limit: number;
    cursor: CommunityCursor | null;
  }) => Promise<CommentListItem[]>;

  /** 返回「这次真的插进去了吗」，理由见 `packages/db/src/repositories/community.ts`。 */
  addReaction: (params: { postId: string; userId: string; now: Date }) => Promise<boolean>;
  /** 返回「这次真的删掉了一行吗」。 */
  removeReaction: (params: { postId: string; userId: string }) => Promise<boolean>;
  reactions: ReactionCountPort;

  findOpenReport: (params: {
    reporterId: string;
    targetType: ReportTargetType;
    targetId: string;
  }) => Promise<ReportListItem | null>;
  /** 单条读取**不过滤**：审核入口要靠 `status` 区分「举报不存在」与「已经处理过」。 */
  getReportById: (params: { id: string }) => Promise<ReportListItem | null>;
  /** 撞上唯一约束时返回 `null`。 */
  insertReport: (report: ReportRecord) => Promise<ReportListItem | null>;
  /**
   * 举报置终态 + （确认下架时）软删目标 + 写审计行，**三步同事务**；举报不再是 `open` 时
   * 返回 `null` 且什么都不做。
   */
  resolveReport: (params: {
    reportId: string;
    status: ReportTerminalStatus;
    handledBy: string;
    handledAt: Date;
    audit: AuditLogRecord;
  }) => Promise<ReportListItem | null>;
  listPendingReports: (params: { limit: number }) => Promise<ReportListItem[]>;
  listAuditLogs: (params: { limit: number }) => Promise<AuditLogListItem[]>;
};

/** 举报除 `open` 之外的两种状态。审核入口只能把举报推进到这两个之一。 */
export type ReportTerminalStatus = Exclude<ReportStatus, 'open'>;

/** 游标位置。排序键是 `(created_at, id)` 两列，理由见 `./rules.ts` 的 `encodeCursor`。 */
export type CommunityCursor = { createdAt: Date; id: string };

/** 落一篇帖子所需的字段。数据层的 `NewPost` 与它逐字段对齐。 */
export type PostRecord = {
  id: string;
  authorId: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
};

/** 落一条评论所需的字段。 */
export type CommentRecord = {
  id: string;
  postId: string;
  authorId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
};

/** 落一条举报所需的字段。`status` 不在这里——新建的举报一定是 `open`（列默认值）。 */
export type ReportRecord = {
  id: string;
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  createdAt: Date;
};

/**
 * 落一条审计日志所需的字段。
 *
 * `targetType` / `targetId` 指向**被处置的内容**而不是举报行：审计要回答的问题是「哪条内容因为
 * 哪次举报被下架了」，举报 id 写在 `detail` 里。
 */
export type AuditLogRecord = {
  id: string;
  actorId: string;
  action: AuditAction;
  targetType: ReportTargetType;
  targetId: string;
  detail: string | null;
  createdAt: Date;
};

/** 一页数据 + 下一页的游标。`nextCursor` 为 `null` 表示这是最后一页。 */
export type CommunityPage<T> = { items: T[]; nextCursor: string | null };

/** 只有一页数据的读操作（批量取计数、后台列表这类不分页的读取也用它）。 */
export type PageOutcome<T> =
  ({ ok: true } & CommunityPage<T>) | { ok: false; failure: CommunityFailure };

export type PostOutcome = { ok: true; postId: string } | { ok: false; failure: CommunityFailure };

export type CommentOutcome =
  { ok: true; commentId: string } | { ok: false; failure: CommunityFailure };

/** `liked` 是**操作完成后的状态**，不是「这次有没有改动」。重复点赞返回 `liked: true`。 */
export type ReactionOutcome =
  { ok: true; postId: string; liked: boolean } | { ok: false; failure: CommunityFailure };

/** `alreadyReported` 为真表示这次提交命中了既有的未处理举报，没有新写一行。 */
export type ReportOutcome =
  | { ok: true; reportId: string; alreadyReported: boolean }
  | { ok: false; failure: CommunityFailure };

/** 审核结果带上被处置的目标，让应用层能精确地 `revalidatePath`。 */
export type ModerationOutcome =
  | { ok: true; reportId: string; targetType: ReportTargetType; targetId: string }
  | { ok: false; failure: CommunityFailure };

/** 单条读取的结果：`item` 为 `null` 表示不存在。 */
export type PostReadOutcome =
  { ok: true; post: PostDetail } | { ok: false; failure: CommunityFailure };
