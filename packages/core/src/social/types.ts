/**
 * 社交模块的契约：失败码、端口、结果类型、常量。
 *
 * ## 分工（与 `community/types.ts` 同一套，理由也相同）
 *
 * | 文件 | 职责 |
 * | --- | --- |
 * | `types.ts` | 失败码、端口契约、结果类型、上限常量。**只有声明**，没有逻辑 |
 * | `rules.ts` | 纯规则：校验、归一化、日期口径、连续天数、申请三态判定、展示裁剪（**无 I/O**） |
 * | `notifications.ts` / `points.ts` / `checkins.ts` / `messages.ts` / `space.ts` | 执行顺序：调用端口、拼装结果 |
 * | `achievements.ts` | 成就定义表 + 纯计算（进度、等级）；解锁时间的持久化由 ports 负责 |
 *
 * **为什么纯规则要单独一个文件**：`rules.ts` 里每个函数都是「进 → 出」，边界值（空 body、
 * 超长、跨日签到、重复申请、关掉的展示分区）能用最少夹具直接测到，不需要假仓储。
 *
 * ## 日期口径（本模块最容易写错的一处）
 *
 * 签到与「连续天数」按**站点时区的日历日**算，不是 UTC 日期。用 UTC 时，中国用户晚上
 * 8 点之后签到会被算成「第二天」，跨零点就乱。时区常量只在这里定义一次，
 * `calendarDateOf` 是唯一的换算入口——不要在各调用点自己拼日期。
 */
import type { NotificationCategory } from '@xsu/db/schema';

/**
 * 转发数据层的分类联合：领域层内部用它，外部（页面 / 仓储）也从这里取，
 * 不必各自去 `@xsu/db/schema` 引一次。
 */
export type { NotificationCategory };

/* ==========================================================================
   常量
   ========================================================================== */

/**
 * 站点时区相对 UTC 的偏移（分钟）。
 *
 * 用固定偏移而不是 IANA 时区名（`Asia/Shanghai`）：本站是单机自托管、目标用户在同一时区，
 * 固定偏移没有夏令时问题，也不依赖运行时是否带完整 tzdata（容器里常常只有 UTC）。
 * 什么时候该换成 IANA：真的出现跨时区用户时，届时需要按用户存偏好。
 */
export const SITE_UTC_OFFSET_MINUTES = 8 * 60;

/** 私信正文上限（码点）。 */
export const DM_BODY_MAX_CHARS = 1000;

/** 一句话签名上限（码点）。 */
export const MOTTO_MAX_CHARS = 60;

/** 每日签到的基础积分。里程碑梯度不在本批（见 SPEC 1.2）。 */
export const CHECKIN_BASE_POINTS = 5;

/** 访问计数节流窗口：同一用户在这段时间内只计一次。 */
export const VISIT_THROTTLE_MS = 60 * 60 * 1000;

/** 空间设置没落库时的默认值：三个分区全开、无签名。 */
export const DEFAULT_SPACE_SETTINGS: SpaceSettingsRecord = {
  showStats: true,
  showPosts: true,
  showAchievements: true,
  motto: null,
};

/** 消息箱一页的条数上限。 */
export const SOCIAL_PAGE_SIZE_DEFAULT = 20;
export const SOCIAL_PAGE_SIZE_MAX = 50;

/** 私信会话一页的条数上限。 */
export const DM_PAGE_SIZE_DEFAULT = 50;
export const DM_PAGE_SIZE_MAX = 200;

/* ==========================================================================
   失败码
   ========================================================================== */

/**
 * 社交模块的失败码。形状与 `CONTENT_FAILURE` 一致（`status` / `code` / `message`），
 * 表现层用同一套渲染逻辑。
 */
export const SOCIAL_FAILURE = {
  /** 必填字段为空、格式不对、id 非法。 */
  inputInvalid: {
    status: 400,
    code: 'SOCIAL_INPUT_INVALID',
    message: '内容不完整或格式不正确。',
  },
  /** 某个字段超长。 */
  inputTooLarge: {
    status: 400,
    code: 'SOCIAL_INPUT_TOO_LARGE',
    message: '内容过长，请精简后重试。',
  },
  /** 收件人不存在。 */
  recipientNotFound: {
    status: 404,
    code: 'SOCIAL_RECIPIENT_NOT_FOUND',
    message: '找不到这个账号。',
  },
  /** 不能给自己发私信。 */
  selfMessage: {
    status: 400,
    code: 'SOCIAL_SELF_MESSAGE',
    message: '不能给自己发私信。',
  },
  /**
   * 还没有被对方接受，只能发一条申请消息。
   *
   * 这条与 `dmDeclined` 分开：前者是「等着」，后者是「别发了」，对用户的下一步动作不同。
   */
  dmPendingRequest: {
    status: 403,
    code: 'SOCIAL_DM_PENDING',
    message: '你已经发过一条申请，等对方同意后才能继续发消息。',
  },
  /** 对方拒绝了私信申请。 */
  dmDeclined: {
    status: 403,
    code: 'SOCIAL_DM_DECLINED',
    message: '对方不接受私信。',
  },
  /** 读一个不存在或不属于自己的会话。 */
  conversationForbidden: {
    status: 403,
    code: 'SOCIAL_CONVERSATION_FORBIDDEN',
    message: '这不是你的会话。',
  },
  /** 今天已经签到过了。**不是错误**——幂等返回既有结果，但需要告诉用户「今天不用再点了」。 */
  alreadyCheckedIn: {
    status: 409,
    code: 'SOCIAL_ALREADY_CHECKED_IN',
    message: '今天已经签到过了。',
  },
  /** 积分余额不足（将来有消费出口时用；本批没有出口，先占位不留死角）。 */
  insufficientPoints: {
    status: 400,
    code: 'SOCIAL_INSUFFICIENT_POINTS',
    message: '积分不足。',
  },
  /** 空间页的主人不存在。 */
  spaceNotFound: {
    status: 404,
    code: 'SOCIAL_SPACE_NOT_FOUND',
    message: '找不到这个用户的空间。',
  },
} as const;

export type SocialFailureCode = keyof typeof SOCIAL_FAILURE;
export type SocialFailureEntry = (typeof SOCIAL_FAILURE)[SocialFailureCode];
export type SocialFailure = SocialFailureEntry & { field?: string; cause?: unknown };

/* ==========================================================================
   端口
   ========================================================================== */

/** 通知的写入请求。`dedupKey` 为 null 表示不去重（系统广播）。 */
export type CreateNotificationInput = {
  id: string;
  recipientId: string;
  category: NotificationCategory;
  type: string;
  actorId: string | null;
  postId: string | null;
  commentId: string | null;
  link: string | null;
  title: string | null;
  body: string | null;
  dedupKey: string | null;
  now: Date;
};

/**
 * 通知端口。
 *
 * `create` 返回 `boolean` 表示**这次是否真的插入了行**：幂等冲突时返回 `false`。
 * 让领域层知道「有没有新通知」是必要的——调用方据此决定要不要动未读计数缓存。
 * 这与 `addReaction` 返回 `boolean` 是同一个取舍。
 */
export type NotificationPort = {
  create: (input: CreateNotificationInput) => Promise<boolean>;
  listForUser: (params: {
    userId: string;
    category: NotificationCategory | null;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }) => Promise<NotificationRecord[]>;
  countUnread: (userId: string) => Promise<number>;
  markRead: (params: { userId: string; ids: string[] | null; now: Date }) => Promise<number>;
};

/** 通知记录（一次读取的原始行）。 */
export type NotificationRecord = {
  id: string;
  category: NotificationCategory;
  type: string;
  actorId: string | null;
  link: string | null;
  title: string | null;
  body: string | null;
  read: boolean;
  createdAt: Date;
};

/** 积分发放请求。`dedupKey` 是实现幂等的唯一手段。 */
export type ApplyPointsInput = {
  transactionId: string;
  userId: string;
  delta: number;
  reason: string;
  detail: string | null;
  dedupKey: string | null;
  createdBy: string | null;
  now: Date;
};

/**
 * 积分端口的写入结果。
 *
 * `applied: false` = 幂等键已存在，**这次什么都没做**（余额没动、流水没写）。
 * 这是并发下重复请求的正常结果，不是错误——与点赞的 `inserted: false` 同一取舍。
 */
export type ApplyPointsResult = { applied: boolean; balance: number };

/**
 * 积分端口。
 *
 * **`apply` 必须在事务里同时写余额与流水**：只写一个就会出现「签到成功但没拿到分」
 * 或「流水显示加了但余额没变」。仓储层用一个事务保证，领域层不感知实现。
 */
export type PointsPort = {
  apply: (input: ApplyPointsInput) => Promise<ApplyPointsResult>;
  getBalance: (userId: string) => Promise<number>;
  listTransactions: (params: {
    userId: string;
    limit: number;
  }) => Promise<PointTransactionRecord[]>;
};

export type PointTransactionRecord = {
  id: string;
  delta: number;
  balance: number;
  reason: string;
  detail: string | null;
  createdAt: Date;
};

/** 签到写入请求。主键 `(userId, checkinDate)` 是并发防线。 */
export type RecordCheckinInput = {
  userId: string;
  checkinDate: string;
  points: number;
  basePoints: number;
  bonusPoints: number;
  streak: number;
  now: Date;
};

/** 签到端口。`inserted: false` = 今天已经签过（撞主键）。 */
export type CheckinPort = {
  insert: (input: RecordCheckinInput) => Promise<boolean>;
  findLatest: (userId: string) => Promise<CheckinRecord | null>;
  listRecent: (params: { userId: string; limit: number }) => Promise<CheckinRecord[]>;
};

export type CheckinRecord = {
  checkinDate: string;
  points: number;
  streak: number;
  createdAt: Date;
};

/** 私信端口。 */
export type MessagePort = {
  insert: (input: {
    id: string;
    fromUserId: string;
    toUserId: string;
    body: string;
    now: Date;
  }) => Promise<void>;
  listConversation: (params: {
    viewerId: string;
    peerId: string;
    limit: number;
  }) => Promise<DirectMessageRecord[]>;
  /** 把该会话里发给我的未读标记为已读，返回标记条数。 */
  markConversationRead: (params: {
    viewerId: string;
    peerId: string;
    now: Date;
  }) => Promise<number>;
  countUnread: (viewerId: string) => Promise<number>;
  /** 列出我收到的待处理申请。 */
  listPendingRequests: (viewerId: string) => Promise<DmContactRecord[]>;
  /** 查一对人的关系（方向：owner 收到、peer 发起）。**方向调换时返回的语义不同**。 */
  findContact: (params: { ownerId: string; peerId: string }) => Promise<DmContactRecord | null>;
  /** 建关系行。`inserted: false` = 已存在（并发下第二个请求）。 */
  insertContact: (input: { ownerId: string; peerId: string; now: Date }) => Promise<boolean>;
  /** 更新关系状态（同意 / 拒绝）。 */
  updateContactStatus: (params: {
    ownerId: string;
    peerId: string;
    status: DmContactStatusValue;
    now: Date;
  }) => Promise<void>;
};

export type DirectMessageRecord = {
  id: string;
  fromUserId: string;
  toUserId: string;
  body: string;
  createdAt: Date;
  readAt: Date | null;
};

export type DmContactRecord = {
  ownerId: string;
  peerId: string;
  status: DmContactStatusValue;
  updatedAt: Date;
};

/** 从数据层联合类型转发，避免领域层各处重复写字符串联合。 */
export type DmContactStatusValue = 'request' | 'accepted' | 'declined';

/** 个人空间的展示设置。`null` = 从没设置过（用默认全开）。 */
export type SpaceSettingsRecord = {
  showStats: boolean;
  showPosts: boolean;
  showAchievements: boolean;
  motto: string | null;
};

/** 空间设置端口。 */
export type SpacePort = {
  findSettings: (userId: string) => Promise<SpaceSettingsRecord | null>;
  upsertSettings: (params: {
    userId: string;
    settings: SpaceSettingsRecord;
    now: Date;
  }) => Promise<void>;
  /** 访问计数：只在上次计入超过节流窗口时 +1。返回是否计入。 */
  recordVisit: (params: { userId: string; now: Date }) => Promise<boolean>;
  findStats: (userId: string) => Promise<{ visitCount: number; lastVisitAt: Date | null } | null>;
};

/** 成就解锁端口。写入是幂等的（撞主键 = 已经解锁过）。 */
export type AchievementPort = {
  insertUnlocks: (
    rows: Array<{ userId: string; achievementId: string; level: number; now: Date }>,
  ) => Promise<void>;
  listUnlocks: (
    userId: string,
  ) => Promise<Array<{ achievementId: string; level: number; unlockedAt: Date }>>;
};

/** 汇总端口：领域层只认这个形状，具体实现由 platform 装配。 */
export type SocialPorts = {
  notifications: NotificationPort;
  points: PointsPort;
  checkins: CheckinPort;
  messages: MessagePort;
  space: SpacePort;
  achievements: AchievementPort;
  /** 时间点由端口提供，让测试能固定时间（与 `CommunityPorts.now` 一致）。 */
  now: () => Date;
  /** 生成 id。放在端口里是为了测试可预期。 */
  newId: () => string;
};

/* ==========================================================================
   结果类型
   ========================================================================== */

export type SocialOutcome<T> = ({ ok: true } & T) | { ok: false; failure: SocialFailure };

/** 分页结果的通用形状。 */
export type SocialPage<T> = { items: T[]; nextCursor: string | null };

/** **带 `Social` 前缀**：`community/types.ts` 也有一个 `PageOutcome`，
 * 两者同名会在 `@xsu/core` 根入口碰撞（TS2308）。 */
export type SocialPageOutcome<T> =
  ({ ok: true } & SocialPage<T>) | { ok: false; failure: SocialFailure };
