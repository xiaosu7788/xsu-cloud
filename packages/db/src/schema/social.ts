/**
 * 纯站内社交九表：通知、私信、私信关系、个人空间、访问统计、积分余额、积分流水、
 * 签到、成就。
 *
 * 规则（分类、幂等、连续天数、申请三态、展示裁剪）全在 `@xsu/core` 的
 * `src/social/`，本文件只负责持久化。表结构的事实来源是
 * `docs/spec/SPEC-social.md` 第 3 节与 `docs/DATA-MODEL.md`；本文件与之不一致即为缺陷。
 *
 * ## 四处需要解释的取舍
 *
 * 1. **幂等一律由约束保证，不用「先查再插」。** 通知用 `(recipient_id, dedup_key)`
 *    部分唯一索引、签到用 `(user_id, checkin_date)` 主键、积分用
 *    `(user_id, dedup_key)` 部分唯一索引、私信申请用 `(owner_id, peer_id)` 主键。
 *    并发下重复请求会撞约束，仓储把冲突翻译成幂等结果。参考实现在 D1 上用
 *    `INSERT OR IGNORE` 做同一件事。
 * 2. **私信不复用 `notifications`。** 通知是单向的（收件人 + 触发者），没有「对话」概念；
 *    拿它做私聊会把系统消息与对话混在一起，也无法表达「这条读没读、对端是谁」。
 * 3. **成就是纯计算的，`user_achievements` 只记解锁时间。** 进度每次按当前数据实时算，
 *    不落库。等级回落时历史行保留（页面展示「历史最高等级」），当前等级以实时计算为准。
 * 4. **积分余额单独一张窄表。** 积分变动频繁，塞进 `user` 那张宽表会牵连其它字段的
 *    更新时间，而且「加积分」会出现多个入口；窄表单入口（`applyPoints`）更干净。
 *
 * **`check` 只用来兜底枚举取值**（与 `community.ts` 同一取舍）：长度上限、额度这类
 * 规则留在领域层，写进数据库就是第二个事实来源。`notifications.type` 与
 * `point_transactions.reason` **不加 check**——取值会持续增加，加了每次新增都要改迁移。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { user } from './auth';
import { comments, posts } from './community';

/* ==========================================================================
   通知
   ========================================================================== */

/**
 * 三档粗分类，用于消息箱的 tab 切换。
 *
 * **与 `type` 分开**：`category` 决定「在哪一栏看」，`type` 决定「用什么图标与文案」。
 * 参考实现把 `category` 默认成 `'social'` 再靠迁移回填老行；本站新建表，要求显式传值。
 */
export const NOTIFICATION_CATEGORIES = ['system', 'site', 'social'] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * 通知。`dedup_key` 是幂等的唯一手段：「同一个人对同一帖子点赞只留一条」靠
 * `(recipient_id, dedup_key)` 部分唯一索引实现，不靠先查后插。
 */
export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    /** 收件人。账号删除时通知一并消失（收件人没了，通知没有意义）。 */
    recipientId: text('recipient_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    category: text('category', { enum: NOTIFICATION_CATEGORIES }).notNull(),
    /** 细粒度动作标识，形如 `post_comment` / `dm_message`。取值持续增加，不加 check。 */
    type: text('type').notNull(),
    /**
     * 触发者。**用 `set null` 而不是级联删**：触发者注销后收件人仍应看到「有人评论过你」，
     * 只是不再显示具体是谁。与 `reports.handled_by` 同一取舍。
     */
    actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
    /** 社交类通知指向的帖子。硬删时通知失去意义（本站帖子是软删除，正常路径不触发）。 */
    postId: text('post_id').references(() => posts.id, { onDelete: 'cascade' }),
    commentId: text('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
    /** 站内跳转路径。存路径而不是存动作，页面不必再拼一次 URL。 */
    link: text('link'),
    title: text('title'),
    body: text('body'),
    /** 幂等键（形如 `post_like:<postId>:<actorId>`）。null = 不去重。 */
    dedupKey: text('dedup_key'),
    read: boolean('read').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** 未读角标与消息箱默认列表共用的排序索引。 */
    index('notifications_recipient_idx').on(table.recipientId, table.read, table.createdAt),
    /** 按分类筛选。 */
    index('notifications_recipient_category_idx').on(
      table.recipientId,
      table.category,
      table.createdAt,
    ),
    /**
     * 幂等去重。**部分索引把 `dedup_key is null` 的行排除在外**——不去重的通知
     * （系统广播）可以有任意多条。谓词必须与查询写法一致，否则规划器用不上。
     */
    uniqueIndex('notifications_dedup_unique_idx')
      .on(table.recipientId, table.dedupKey)
      .where(sql`${table.dedupKey} is not null`),
    check('notifications_category_check', sql`${table.category} in ('system', 'site', 'social')`),
  ],
);

/* ==========================================================================
   私信
   ========================================================================== */

/**
 * 私信申请的三态。
 *
 * - `request`：`peer` 已发过申请，`owner` 还没处理（此时 `peer` 不能再发）
 * - `accepted`：`owner` 同意了 → 双方自由互发
 * - `declined`：`owner` 拒绝了 → `peer` 不能再发
 */
export const DM_CONTACT_STATUSES = ['request', 'accepted', 'declined'] as const;

export type DmContactStatus = (typeof DM_CONTACT_STATUSES)[number];

/**
 * 一对一私信。
 *
 * **已读只用一个 `read_at`**：一对一场景下一条消息只需要一个「收件人读了吗」，
 * 未读数 = `to_user_id = 我 AND read_at is null`，不需要额外的位点表。
 * 自己发的不需要标记（不会给自己发，见领域层）。
 */
export const directMessages = pgTable(
  'direct_messages',
  {
    id: text('id').primaryKey(),
    fromUserId: text('from_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    toUserId: text('to_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** 收件人读这条消息的时间；null = 未读。 */
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (table) => [
    /** 会话翻页：两个方向各一条索引（谁发给谁的排序不同）。 */
    index('direct_messages_from_to_idx').on(table.fromUserId, table.toUserId, table.createdAt),
    index('direct_messages_to_from_idx').on(table.toUserId, table.fromUserId, table.createdAt),
    /** 未读数与会话列表：`to_user_id = ? AND read_at is null`。 */
    index('direct_messages_unread_idx').on(table.toUserId, table.readAt, table.createdAt),
  ],
);

/**
 * 私信关系（防骚扰的「先申请」门槛）。
 *
 * 方向是**有意的**：`ownerId` = 收到申请的人，`peerId` = 发起申请的人。
 * 无关系时发第一条消息会原子地建一行 `status='request'`，此后 `peer` 必须等 `owner` 处理。
 *
 * 三种免申请情形在领域层判断、**不落这张表**：收件人是管理员、收件人就是自己（直接拒绝）、
 * 已有 `accepted` 关系。
 */
export const dmContacts = pgTable(
  'dm_contacts',
  {
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    peerId: text('peer_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: text('status', { enum: DM_CONTACT_STATUSES }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** 主键即「一对人只有一条关系」，也是并发下防重复申请的唯一手段。 */
    primaryKey({ name: 'dm_contacts_pk', columns: [table.ownerId, table.peerId] }),
    /** 「我收到的待处理申请」。 */
    index('dm_contacts_owner_status_idx').on(table.ownerId, table.status),
    /** 反查「我与某人是否已有关系」。 */
    index('dm_contacts_peer_idx').on(table.peerId, table.status),
    check('dm_contacts_status_check', sql`${table.status} in ('request', 'accepted', 'declined')`),
  ],
);

/* ==========================================================================
   个人空间
   ========================================================================== */

/**
 * 个人空间的**展示设置**。
 *
 * 空间页是「数据驱动」的：帖子、积分、成就全部实时从各业务表算出来，不冗余落库。
 * 这张表只存三个分区开关与一句话签名——它们是用户的选择，推不出来。
 */
export const userSpaces = pgTable('user_spaces', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  showStats: boolean('show_stats').notNull().default(true),
  showPosts: boolean('show_posts').notNull().default(true),
  showAchievements: boolean('show_achievements').notNull().default(true),
  /** 一句话签名。null / 空串 = 不显示。 */
  motto: text('motto'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 站点访问统计（成就进度要用）。
 *
 * 必须落库：`visitCount` 是累计量，没有别的表能推出来。节流靠 `lastVisitAt`
 * ——同一用户 1 小时内只计一次，否则每次请求都 +1。
 */
export const userStats = pgTable('user_stats', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  visitCount: integer('visit_count').notNull().default(0),
  lastVisitAt: timestamp('last_visit_at', { withTimezone: true }),
});

/* ==========================================================================
   积分
   ========================================================================== */

/**
 * 积分流水的来源。
 *
 * **故意没有 `redeem`**：参考实现的积分能兑换中转站余额，本站只记账本、没有兑换出口
 * （见 SPEC 1.2）。等真的有了出口再加值——加值不需要改迁移（该列无 check）。
 */
export const POINT_REASONS = ['checkin', 'admin'] as const;

export type PointReason = (typeof POINT_REASONS)[number];

/**
 * 积分余额。**单独一张窄表**，理由见文件头第 4 条。
 * 「加积分」只有一个入口（领域层的 `applyPoints`），它同时写这张表与流水。
 */
export const userPoints = pgTable('user_points', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  balance: integer('balance').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 积分流水。每一笔增减都留痕，用户要能自查「我的积分去哪了」。
 *
 * `balance` 是**变动后**的余额快照，用于对账展示；并发下可能与真实余额差一笔，
 * **事实来源始终是 `user_points.balance`**（参考实现明确写下的取舍）。
 */
export const pointTransactions = pgTable(
  'point_transactions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 正数 = 增加，负数 = 减少。 */
    delta: integer('delta').notNull(),
    /** 变动后的余额快照。 */
    balance: integer('balance').notNull(),
    reason: text('reason').notNull(),
    /** 展示文案（用户在流水里看到的这一行）。 */
    detail: text('detail'),
    /** 幂等键，形如 `checkin:<date>`。null = 不去重。 */
    dedupKey: text('dedup_key'),
    /** 管理员发放时记谁操作的；用户自发的行为为 null。 */
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('point_transactions_dedup_unique_idx')
      .on(table.userId, table.dedupKey)
      .where(sql`${table.dedupKey} is not null`),
    /** 按用户查流水（「最近记录」）。 */
    index('point_transactions_user_idx').on(table.userId, table.createdAt),
  ],
);

/* ==========================================================================
   每日签到
   ========================================================================== */

/**
 * 每日签到。**主键 `(user_id, checkin_date)` 就是并发防线**：重复签到变成一次唯一约束
 * 冲突，仓储用 `ON CONFLICT DO NOTHING` 翻译成「今天已签到」，不依赖先查后写。
 *
 * `checkinDate` 是**站点时区（UTC+8）的日历日**，不是 UTC 日期——参考实现踩过这个坑：
 * 用 UTC 日期时，中国用户晚上 8 点之后签到会被算成「第二天」。时区口径集中在领域层
 * 一个函数里，不散落。
 *
 * `streak` 冗余存一列：连续天数每次都要展示，实时算需要扫全部历史。
 * `basePoints` / `bonusPoints` 分开存，便于将来加里程碑梯度时对账，不必回填历史行。
 */
export const dailyCheckins = pgTable(
  'daily_checkins',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 站点时区的日历日。 */
    checkinDate: date('checkin_date').notNull(),
    /** 本次实际发放的积分合计。 */
    points: integer('points').notNull(),
    basePoints: integer('base_points').notNull(),
    /** 里程碑奖励部分。本批不做梯度，恒为 0，列保留。 */
    bonusPoints: integer('bonus_points').notNull().default(0),
    /** 这次签到后的连续天数，便于直接展示与排查。 */
    streak: integer('streak').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'daily_checkins_pk', columns: [table.userId, table.checkinDate] }),
    /** 算「连续多少天」要按日期倒序取最近一条。 */
    index('daily_checkins_user_idx').on(table.userId, table.checkinDate),
  ],
);

/* ==========================================================================
   成就
   ========================================================================== */

/**
 * 成就解锁记录。
 *
 * 成就是**纯计算**的（进度每次按当前数据实时算，不落库），这张表只记「首次达成某成就
 * 某等级的时间」。**等级回落不删历史行**：资源被删导致等级下降时，页面展示「历史最高
 * 等级」与首次解锁时间，当前等级以实时计算为准。
 *
 * `achievementId` **无外键**：成就定义在代码里（编译期常量，同 `tools` 注册表），
 * 不是数据库行。删掉一个定义后旧解锁行成为孤儿——登记在 SPEC 已知债务里。
 */
export const userAchievements = pgTable(
  'user_achievements',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    achievementId: text('achievement_id').notNull(),
    /** 达成时的等级。 */
    level: integer('level').notNull(),
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'user_achievements_pk',
      columns: [table.userId, table.achievementId, table.level],
    }),
    index('user_achievements_user_idx').on(table.userId),
  ],
);

/* ==========================================================================
   投影：表现层直接引用，表结构改了而页面按旧字段读会被编译器拦下
   ========================================================================== */

export type NotificationListItem = {
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

export const notificationListColumns = {
  id: notifications.id,
  category: notifications.category,
  type: notifications.type,
  actorId: notifications.actorId,
  link: notifications.link,
  title: notifications.title,
  body: notifications.body,
  read: notifications.read,
  createdAt: notifications.createdAt,
};

export type DirectMessageListItem = {
  id: string;
  fromUserId: string;
  toUserId: string;
  body: string;
  createdAt: Date;
  readAt: Date | null;
};

export const directMessageListColumns = {
  id: directMessages.id,
  fromUserId: directMessages.fromUserId,
  toUserId: directMessages.toUserId,
  body: directMessages.body,
  createdAt: directMessages.createdAt,
  readAt: directMessages.readAt,
};

/** 一对人的私信关系。方向见上面的 `dmContacts` 注释（`owner` 收到申请、`peer` 发起）。 */
export type DmContactListItem = {
  ownerId: string;
  peerId: string;
  status: DmContactStatus;
  updatedAt: Date;
};

export const dmContactColumns = {
  ownerId: dmContacts.ownerId,
  peerId: dmContacts.peerId,
  status: dmContacts.status,
  updatedAt: dmContacts.updatedAt,
};

/** 空间展示设置。**没有行 = 从没设置过**，兜默认值在领域层（`getSpaceSettings`）。 */
export type SpaceSettingsRow = {
  showStats: boolean;
  showPosts: boolean;
  showAchievements: boolean;
  motto: string | null;
};

export const spaceSettingsColumns = {
  showStats: userSpaces.showStats,
  showPosts: userSpaces.showPosts,
  showAchievements: userSpaces.showAchievements,
  motto: userSpaces.motto,
};

/** 访问统计。`lastVisitAt` 为 null = 从没计入过（头一次访问必计）。 */
export type UserStatsRow = {
  visitCount: number;
  lastVisitAt: Date | null;
};

export const userStatsColumns = {
  visitCount: userStats.visitCount,
  lastVisitAt: userStats.lastVisitAt,
};

export type PointTransactionListItem = {
  id: string;
  delta: number;
  balance: number;
  reason: string;
  detail: string | null;
  createdAt: Date;
};

export const pointTransactionListColumns = {
  id: pointTransactions.id,
  delta: pointTransactions.delta,
  balance: pointTransactions.balance,
  reason: pointTransactions.reason,
  detail: pointTransactions.detail,
  createdAt: pointTransactions.createdAt,
};

export type CheckinListItem = {
  checkinDate: string;
  points: number;
  streak: number;
  createdAt: Date;
};

export const checkinListColumns = {
  checkinDate: dailyCheckins.checkinDate,
  points: dailyCheckins.points,
  streak: dailyCheckins.streak,
  createdAt: dailyCheckins.createdAt,
};

export type AchievementUnlockListItem = {
  achievementId: string;
  level: number;
  unlockedAt: Date;
};

export const achievementUnlockListColumns = {
  achievementId: userAchievements.achievementId,
  level: userAchievements.level,
  unlockedAt: userAchievements.unlockedAt,
};
