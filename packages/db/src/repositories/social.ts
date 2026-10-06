/**
 * 社交仓储：通知、私信、个人空间、积分、签到、成就（表结构见 `../schema/social.ts`）。
 *
 * 只做数据访问：SQL、事务边界、并发正确性、字段投影。**判定与规则不在这里**——
 * 「一天能不能签两次、没有关系时能发几条私信、关掉的分区该不该下发」都在 `@xsu/core` 的
 * `src/social/`；本文件只把事实取回来、把结果落下去。
 *
 * ## 贯穿本文件的六条约定
 *
 * 1. **幂等一律交给约束，不写「先查再插」。** 通知是
 *    `ON CONFLICT DO NOTHING`（部分唯一索引 `(recipient_id, dedup_key)`）、
 *    积分是 `ON CONFLICT DO NOTHING`（`(user_id, dedup_key)`）、签到是
 *    `ON CONFLICT DO NOTHING`（主键 `(user_id, checkin_date)`）、私信申请是
 *    `ON CONFLICT DO NOTHING`（主键 `(owner_id, peer_id)`）、成就是
 *    `ON CONFLICT DO NOTHING`（主键 `(user_id, achievement_id, level)`）。
 *    五处都返回「这次真的插进去了吗」，让领域层能区分「做了」与「本来就有」——
 *    这与社区仓储的 `addReaction` 是同一个取舍（`docs/spec/SPEC-social.md` 3.5-1）。
 * 2. **时间点由调用方传入**（`now`），不用 SQL 的 `now()`：领域层的判定与落库的
 *    `created_at` 必须是同一个时间点，否则「算的时候没超、写下去就超了」。
 * 3. **比较时间要走列的类型映射或显式转换。** 驱动是 `postgres.js`，它在 Bind 阶段对参数
 *    做 `Buffer.byteLength`，拿到裸 `Date` 直接抛 `ERR_INVALID_ARG_TYPE`。所以节流判定写成
 *    `lte(列, 日期)`（带上该列的类型转换），游标的行值比较显式写 `::timestamptz`
 *    ——`lt()` 给不了「两列一起比」的语义（与 `community.ts` 同源）。
 * 4. **改余额与写流水必须在同一个事务里**（`applyPointTransaction`，本文件唯一的
 *    `db.transaction` 之一）。只写一个就会出现「签到成功但没拿到分」或「流水显示加了但余额
 *    没变」（SPEC 4.3）。
 * 5. **按用户收窄的读写都带 `user_id` 条件**，即使领域层已经判定过归属。这是纵深防御：
 *    SQL 里少一个条件，下次有人绕过领域层直连仓储就会漏数据（与 `tools.ts` 一致）。
 * 6. **分页靠「多取一行」判断有没有下一页**，本文件不认识页大小规则
 *    （规则在 `@xsu/core` 的 `SOCIAL_PAGE_SIZE_MAX`）：下面的 `limit` 只是探测行上限，
 *    领域层传的是「页大小 + 1」。
 *
 * 页面读取（空间页要的作者摘要、成就要的帖子数/评论数/收赞数）不在这里：前者的口径在
 * 社区仓储按各自的表算，**本文件不跨模块聚合**（见 `space.ts` 文件头）。
 */
import { and, asc, count, desc, eq, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import type { Database } from '../client';
import {
  type AchievementUnlockListItem,
  type CheckinListItem,
  type DirectMessageListItem,
  type DmContactListItem,
  type DmContactStatus,
  type NotificationCategory,
  type NotificationListItem,
  type PointTransactionListItem,
  type SpaceSettingsRow,
  type UserStatsRow,
  achievementUnlockListColumns,
  checkinListColumns,
  dailyCheckins,
  directMessageListColumns,
  directMessages,
  dmContactColumns,
  dmContacts,
  notificationListColumns,
  notifications,
  pointTransactionListColumns,
  pointTransactions,
  spaceSettingsColumns,
  userAchievements,
  userPoints,
  userSpaces,
  userStats,
  userStatsColumns,
} from '../schema/social';

/**
 * 单次查询一次最多取多少行。**这不是页大小规则**（规则见文件头第 6 条），只是一条防线：
 * 调用方传了离谱的数字时也不至于把整张表拉进内存。必须大于领域层的页大小上限。
 */
export const SOCIAL_FETCH_HARD_CAP = 500;

/** 把调用方给的条数收进 `[1, SOCIAL_FETCH_HARD_CAP]`。 */
function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), SOCIAL_FETCH_HARD_CAP);
}

/**
 * 游标位置。排序键是 `(created_at, id)` 而不是只有时间：同一毫秒内产生的两条记录
 * 光靠时间分不出先后，翻页就会重复或漏掉（与社区 Feed 同一取舍）。
 */
export type SocialCursorPoint = { createdAt: Date; id: string };

/**
 * 行值比较：`(created_at, id) < (t, i)`，与 `notifications_recipient_idx` 同序。
 * 操作符走 `sql.raw`——它不可能被参数化，取值来自这个字面量联合，不是外部输入。
 */
function cursorCondition(params: {
  createdAt: AnyPgColumn;
  id: AnyPgColumn;
  cursor: SocialCursorPoint;
}): SQL {
  return sql`(${params.createdAt}, ${params.id}) < (${params.cursor.createdAt.toISOString()}::timestamptz, ${params.cursor.id})`;
}

/* ==========================================================================
   通知
   ========================================================================== */

/** 落一行通知所需的全部字段。由应用层把领域层结果翻译成这个形状。 */
export type NewNotification = {
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
  createdAt: Date;
};

/**
 * 落一行通知。**返回 `false` 表示撞上了 `(recipient_id, dedup_key)` 唯一索引**，
 * 也就是「同一个人因为同一个动作已经收到过一条通知」——这不是错误，领域层据此决定
 * 要不要动未读角标（与 `addReaction` 同一取舍）。
 *
 * `dedupKey` 为 null 时部分唯一索引不覆盖这行，系统广播可以有任意多条。
 */
export async function insertNotification(
  db: Database,
  notification: NewNotification,
): Promise<boolean> {
  const rows = await db
    .insert(notifications)
    .values(notification)
    .onConflictDoNothing()
    .returning({ id: notifications.id });

  return rows.length > 0;
}

/**
 * 消息箱的一页。`category` 为 null 表示不筛选（「全部」tab）。
 *
 * 排序与游标都走 `(created_at desc, id desc)`：与 `notifications_recipient_idx`
 * （`recipient_id, read, created_at`）同序，翻页不会被排序拖慢。
 */
export async function listNotificationsForUser(
  db: Database,
  params: {
    userId: string;
    category: NotificationCategory | null;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  },
): Promise<NotificationListItem[]> {
  const filters: SQL[] = [eq(notifications.recipientId, params.userId)];

  if (params.category) {
    filters.push(eq(notifications.category, params.category));
  }
  /*
   * 游标两个字段必须一起给：只给时间会让「同一毫秒」的边界行重复出现。
   * 调用方（领域层）把游标成对传出，这里不做「缺一个就忽略游标」的补救——
   * 那样会在错的位置静默翻页。
   */
  if (params.cursorCreatedAt && params.cursorId) {
    filters.push(
      cursorCondition({
        createdAt: notifications.createdAt,
        id: notifications.id,
        cursor: { createdAt: params.cursorCreatedAt, id: params.cursorId },
      }),
    );
  }

  return db
    .select(notificationListColumns)
    .from(notifications)
    .where(and(...filters))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(clampLimit(params.limit));
}

/**
 * 未读条数：消息箱角标用。只数不取行——角标不需要内容，拉一页回来再 `length` 是白花流量。
 */
export async function countUnreadNotifications(db: Database, userId: string): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(notifications)
    .where(and(eq(notifications.recipientId, userId), eq(notifications.read, false)));

  return rows[0]?.total ?? 0;
}

/**
 * 把若干条通知标为已读，返回**这次真正标了几条**。
 *
 * - `ids` 为 `null` = 全部标为已读（「全部已读」按钮）；否则只标这一批。
 * - `user_id` 条件恒在：传进来的 id 属于别人时一行都改不到（纵深防御，文件头第 5 条）。
 * - `where` 恒带 `read = false`：重复标记返回 0，调用方据此判断要不要刷新未读角标
 *   （与 `addReaction` 返回 boolean 同一个取舍）。
 *
 * `now` 收下但不落库：`notifications` 只有布尔 `read`、没有 `read_at`，没有列能存这个
 * 时间点。参数保留是为了让端口形状统一（`NotificationPort.markRead`），调用方不必分情况。
 */
export async function markNotificationsRead(
  db: Database,
  params: { userId: string; ids: string[] | null; now: Date },
): Promise<number> {
  const filters: SQL[] = [
    eq(notifications.recipientId, params.userId),
    eq(notifications.read, false),
  ];

  if (params.ids) {
    /*
     * 空数组提前返回：`inArray(col, [])` 生成的是恒假条件，语义上「标 0 条」没错，
     * 但没必要为它跑一趟数据库。调用方要「全部已读」时传的是 `null`，不是空数组。
     */
    if (params.ids.length === 0) {
      return 0;
    }
    filters.push(inArray(notifications.id, params.ids));
  }

  const rows = await db
    .update(notifications)
    .set({ read: true })
    .where(and(...filters))
    .returning({ id: notifications.id });

  return rows.length;
}

/* ==========================================================================
   积分
   ========================================================================== */

/**
 * 发放（或扣减）积分。**全站唯一的积分入口**：改余额与写流水在同一个事务里。
 *
 * ## 为什么是这个顺序
 *
 * 幂等闸门必须在最前面——先插流水（`balance` 先占位 0），`(user_id, dedup_key)` 部分
 * 唯一索引就是闸门：冲突时 `ON CONFLICT DO NOTHING` 不返回行，说明这一笔已经记过，
 * **整个事务直接放弃，余额一个字节都不动**。占位值在提交前对外不可见（READ COMMITTED），
 * 没人会读到这个 0。闸门过了才 upsert 余额、再把真实快照回写到流水上。
 *
 * 反序（先改余额再插流水）也能跑，但并发撞键时要把已经加上的余额补回去——补偿逻辑脆弱，
 * 任何一步失败都会留下「加了但没记」或「记了但没加」的账（SPEC 4.3 明确要求同事务）。
 *
 * ## 撞键时为什么在事务外读余额
 *
 * `tx` 的事务类型不带 `$client`，不能传给 `Database` 形状的助手（`getPointBalance`）；
 * 提交之后读则可以直接复用。两条路径等价：撞键意味着这次请求没改过余额，
 * 提交后读到的就是当前真值——**必须读库而不是猜**，并发的另一笔可能刚改过它。
 */
export async function applyPointTransaction(
  db: Database,
  input: {
    id: string;
    userId: string;
    delta: number;
    reason: string;
    detail: string | null;
    dedupKey: string | null;
    createdBy: string | null;
    now: Date;
  },
): Promise<{ applied: boolean; balance: number }> {
  const balance = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(pointTransactions)
      .values({
        id: input.id,
        userId: input.userId,
        delta: input.delta,
        // 占位，下面拿到真实余额后立刻回写（提交前对外不可见）。
        balance: 0,
        reason: input.reason,
        detail: input.detail,
        dedupKey: input.dedupKey,
        createdBy: input.createdBy,
        createdAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ id: pointTransactions.id });

    if (inserted.length === 0) {
      return null;
    }

    /*
     * `+` 在 SQL 里做，不在 JS 里做：先读再加再写回会丢并发（两个请求读到同一个旧值）。
     * `RETURNING` 拿到的是这一条语句算出来的新余额，正好是要返回给用户的那个数。
     * 首次插入时余额从 0 起算，所以初值就是 `delta`（负 delta 表示管理员直接扣成负数，允许）。
     */
    const updated = await tx
      .insert(userPoints)
      .values({ userId: input.userId, balance: input.delta, updatedAt: input.now })
      .onConflictDoUpdate({
        target: userPoints.userId,
        set: {
          balance: sql`${userPoints.balance} + ${input.delta}`,
          updatedAt: input.now,
        },
      })
      .returning({ balance: userPoints.balance });

    const next = updated[0]!.balance;

    await tx
      .update(pointTransactions)
      .set({ balance: next })
      .where(eq(pointTransactions.id, input.id));

    return next;
  });

  if (balance === null) {
    return { applied: false, balance: await getPointBalance(db, input.userId) };
  }

  return { applied: true, balance };
}

/** 当前余额。**没有行就是 0**：没拿过积分的用户不该在库里留一行（与 `getPointsBalance` 一致）。 */
export async function getPointBalance(db: Database, userId: string): Promise<number> {
  const rows = await db
    .select({ balance: userPoints.balance })
    .from(userPoints)
    .where(eq(userPoints.userId, userId))
    .limit(1);

  return rows[0]?.balance ?? 0;
}

/**
 * 流水一页，**时间倒序**（最近一笔在最上）。
 *
 * 不做游标分页：流水是「我最近获得了什么」的自查视图，没有翻到第三页的真实需求
 * （领域层 `listPointTransactions` 同样只取最近 N 条）。排序键带 `id` 兜同一毫秒。
 */
export async function listPointTransactions(
  db: Database,
  params: { userId: string; limit: number },
): Promise<PointTransactionListItem[]> {
  return db
    .select(pointTransactionListColumns)
    .from(pointTransactions)
    .where(eq(pointTransactions.userId, params.userId))
    .orderBy(desc(pointTransactions.createdAt), desc(pointTransactions.id))
    .limit(clampLimit(params.limit));
}

/* ==========================================================================
   签到
   ========================================================================== */

/**
 * 写一行签到。**返回 `false` = 今天已经签过**（撞主键 `(user_id, checkin_date)`）。
 *
 * 领域层的顺序是「算站点时区的今天 → 读上次签到 → 算连续天数 → 写这一行」；这一行是
 * **并发防线**：同一瞬间点两次，第二个请求在这里拿到 `false`，领域层据此返回
 * `alreadyCheckedIn`（409，不算错误）。积分只在插入成功之后才发——先发分再碰运气，
 * 撞键时就得把分收回来。
 */
export async function insertCheckin(
  db: Database,
  input: {
    userId: string;
    checkinDate: string;
    points: number;
    basePoints: number;
    bonusPoints: number;
    streak: number;
    now: Date;
  },
): Promise<boolean> {
  const rows = await db
    .insert(dailyCheckins)
    .values({
      userId: input.userId,
      checkinDate: input.checkinDate,
      points: input.points,
      basePoints: input.basePoints,
      bonusPoints: input.bonusPoints,
      streak: input.streak,
      createdAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ userId: dailyCheckins.userId });

  return rows.length > 0;
}

/**
 * 最近一次签到，按**站点时区日历日**倒序（`checkin_date` 存的就是站点时区的日期字符串，
 * 换算在领域层的 `calendarDateOf`，这里不做时区判断）。连续天数从这一行的日期开始算。
 */
export async function findLatestCheckin(
  db: Database,
  userId: string,
): Promise<CheckinListItem | null> {
  const rows = await db
    .select(checkinListColumns)
    .from(dailyCheckins)
    .where(eq(dailyCheckins.userId, userId))
    .orderBy(desc(dailyCheckins.checkinDate))
    .limit(1);

  return rows[0] ?? null;
}

/** 最近若干次签到，日期倒序（「最近签到」列表）。 */
export async function listRecentCheckins(
  db: Database,
  params: { userId: string; limit: number },
): Promise<CheckinListItem[]> {
  return db
    .select(checkinListColumns)
    .from(dailyCheckins)
    .where(eq(dailyCheckins.userId, params.userId))
    .orderBy(desc(dailyCheckins.checkinDate))
    .limit(clampLimit(params.limit));
}

/* ==========================================================================
   私信
   ========================================================================== */

/**
 * 落一条私信。**故意返回 `void`**：私信不是幂等的——同一个人连发两条一模一样的话就是
 * 两句话，不能像点赞那样靠唯一索引去重（`insertComment` 同理）。
 *
 * 能不能发由领域层判：无关系时只许一条申请、被拒不能再发、不能发给自己、收件人必须是真人。
 */
export async function insertDirectMessage(
  db: Database,
  input: { id: string; fromUserId: string; toUserId: string; body: string; now: Date },
): Promise<void> {
  await db.insert(directMessages).values({
    id: input.id,
    fromUserId: input.fromUserId,
    toUserId: input.toUserId,
    body: input.body,
    createdAt: input.now,
  });
}

/**
 * 一段会话**最近的一页**，时间倒序（新的在前）。
 *
 * 一次查询取双向（`我 → 对方` **或** `对方 → 我`），两个方向各走一条索引
 * （`direct_messages_from_to_idx` / `direct_messages_to_from_idx`）。取最近一页而不是从最早
 * 翻：聊天窗口关心的是「刚说了什么」。页面把这一页反转成从上到下的阅读顺序。
 *
 * 排序键带 `id` 兜同一毫秒（与消息箱同源）。
 */
export async function listConversationMessages(
  db: Database,
  params: { viewerId: string; peerId: string; limit: number },
): Promise<DirectMessageListItem[]> {
  return db
    .select(directMessageListColumns)
    .from(directMessages)
    .where(
      or(
        and(
          eq(directMessages.fromUserId, params.viewerId),
          eq(directMessages.toUserId, params.peerId),
        ),
        and(
          eq(directMessages.fromUserId, params.peerId),
          eq(directMessages.toUserId, params.viewerId),
        ),
      ),
    )
    .orderBy(desc(directMessages.createdAt), desc(directMessages.id))
    .limit(clampLimit(params.limit));
}

/**
 * 把对方发给我的未读标成已读，返回**这次标了几条**。
 *
 * 方向不能反：`to = 我 AND from = 对方 AND read_at IS NULL`。把「我发出去的」也标上会让对方
 * 的未读数凭空消失。`now` 落进 `read_at`——这里**有**列可存已读时间（与通知不同）。
 * 恒带 `read_at IS NULL`：重复读同一段会话返回 0，也不会把已读时间改来改去。
 */
export async function markConversationRead(
  db: Database,
  params: { viewerId: string; peerId: string; now: Date },
): Promise<number> {
  const rows = await db
    .update(directMessages)
    .set({ readAt: params.now })
    .where(
      and(
        eq(directMessages.toUserId, params.viewerId),
        eq(directMessages.fromUserId, params.peerId),
        isNull(directMessages.readAt),
      ),
    )
    .returning({ id: directMessages.id });

  return rows.length;
}

/** 我的私信未读总数（导航角标）。只数方向为「我收」的那一半。 */
export async function countUnreadMessages(db: Database, viewerId: string): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(directMessages)
    .where(and(eq(directMessages.toUserId, viewerId), isNull(directMessages.readAt)));

  return rows[0]?.total ?? 0;
}

/** 会话列表的一行：对端 + 最后一句 + 我对这段会话的未读数。 */
export type DmThreadListItem = {
  peerId: string;
  lastBody: string;
  lastAt: Date;
  /** 最后一句是我发的吗（页面上显示成「我：…」）。 */
  lastFromViewer: boolean;
  unread: number;
};

/**
 * 会话列表：**每个对端一行**（最后一句 + 我对它的未读数），按最后一句时间倒序。
 *
 * 页面第一屏要回答的是「有没有人在等我回话」，所以未读数与最后一句必须来自同一次读取：
 * 分成两次查询会出现「列表说未读 3、点进去 0」这种对不上的画面。
 *
 * 单条 SQL 而不是「先列对端、再逐个查最后一条」：后者是 N+1；而且对端集合本身只能从消息表
 * 推出来——`dm_contacts` 只记申请关系，被管理员豁免的对端（从未建关系行）也在列表里。
 * `row_number()` 取每个对端的最后一句、`count(*) filter` 数未读，一次扫描完成。
 *
 * 本函数不认识「页大小」「能不能发」这类规则（见文件头第 6 条）；`limit` 只是探测上限。
 * `peer_id` 上的排序方向固定，翻页才稳定。
 */
export async function listDmThreads(
  db: Database,
  params: { viewerId: string; limit: number },
): Promise<DmThreadListItem[]> {
  const viewerId = params.viewerId;

  const rows = await db.execute<DmThreadListItem>(sql`
    with thread_lines as (
      select
        case
          when ${directMessages.fromUserId} = ${viewerId} then ${directMessages.toUserId}
          else ${directMessages.fromUserId}
        end as peer_id,
        ${directMessages.body} as body,
        ${directMessages.createdAt} as created_at,
        ${directMessages.id} as id,
        (${directMessages.fromUserId} = ${viewerId}) as from_viewer,
        (${directMessages.toUserId} = ${viewerId} and ${directMessages.readAt} is null) as unread
      from ${directMessages}
      where ${directMessages.fromUserId} = ${viewerId} or ${directMessages.toUserId} = ${viewerId}
    ),
    ranked as (
      select
        peer_id,
        body,
        created_at,
        from_viewer,
        count(*) filter (where unread) over (partition by peer_id) as unread_count,
        row_number() over (partition by peer_id order by created_at desc, id desc) as rn
      from thread_lines
    )
    select
      peer_id as "peerId",
      body as "lastBody",
      created_at as "lastAt",
      from_viewer as "lastFromViewer",
      unread_count::int as "unread"
    from ranked
    where rn = 1
    order by created_at desc, peer_id desc
    limit ${clampLimit(params.limit)}
  `);

  return [...rows];
}

/**
 * 我收到的待处理申请，**时间正序**（先来的先处理，处理顺序与用户看到的一致），
 * 走 `dm_contacts_owner_status_idx`。
 *
 * 不做分页：申请是低频事件，本批不打算给无限列表（上限讨论见 SPEC-social 3.5-4）。
 */
export async function listPendingDmRequests(
  db: Database,
  viewerId: string,
): Promise<DmContactListItem[]> {
  return db
    .select(dmContactColumns)
    .from(dmContacts)
    .where(and(eq(dmContacts.ownerId, viewerId), eq(dmContacts.status, 'request')))
    .orderBy(asc(dmContacts.createdAt));
}

/**
 * 查一对人的关系。**方向有语义**：`ownerId` 是收到申请的人、`peerId` 是发起的人，反着传是
 * 另一行记录（甚至查不到）——「谁在等谁处理」不能搞反。查无返回 null。
 */
export async function findDmContact(
  db: Database,
  params: { ownerId: string; peerId: string },
): Promise<DmContactListItem | null> {
  const rows = await db
    .select(dmContactColumns)
    .from(dmContacts)
    .where(and(eq(dmContacts.ownerId, params.ownerId), eq(dmContacts.peerId, params.peerId)))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * 建关系行，状态恒为 `request`。**返回 `false` = 这一对已经有关系了**（撞主键）。
 *
 * 主键 `(owner_id, peer_id)` 是并发下防重复申请的唯一手段：两个请求同时判出「没有关系」
 * 各自去建行，只有一行能落下去，另一个拿到 `false`，领域层必须据此拒绝（返回「等对方同意」），
 * 否则会多出一条申请消息。
 */
export async function insertDmContact(
  db: Database,
  input: { ownerId: string; peerId: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .insert(dmContacts)
    .values({
      ownerId: input.ownerId,
      peerId: input.peerId,
      status: 'request',
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ ownerId: dmContacts.ownerId });

  return rows.length > 0;
}

/**
 * 同意 / 拒绝申请。**`where` 带 `status = 'request'`**：两个标签页各点一次时只有先到的能改，
 * 后到的静默无效果——没有这个条件，后到的会把先到的决定覆盖掉（先拒后同意）。
 *
 * 返回 `void`：调用方已判定过「这是我的申请」，改 0 行只可能是并发下别人先处理了，
 * 对用户而言结果相同（关系已经不 pending）。
 */
export async function updateDmContactStatus(
  db: Database,
  params: { ownerId: string; peerId: string; status: DmContactStatus; now: Date },
): Promise<void> {
  await db
    .update(dmContacts)
    .set({ status: params.status, updatedAt: params.now })
    .where(
      and(
        eq(dmContacts.ownerId, params.ownerId),
        eq(dmContacts.peerId, params.peerId),
        eq(dmContacts.status, 'request'),
      ),
    );
}

/* ==========================================================================
   个人空间
   ========================================================================== */

/**
 * 读展示设置。**没有行返回 null**（这个人从没设置过），默认值由领域层兜
 * （`getSpaceSettings` 返回 `DEFAULT_SPACE_SETTINGS`）——默认值是规则，不是这里的事。
 */
export async function findSpaceSettings(
  db: Database,
  userId: string,
): Promise<SpaceSettingsRow | null> {
  const rows = await db
    .select(spaceSettingsColumns)
    .from(userSpaces)
    .where(eq(userSpaces.userId, userId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * 保存展示设置（整行覆盖）。设置是用户的选择，推不出来，所以必须落库；空间页要展示的
 * 帖子 / 积分 / 成就是按需实时算的，不在这里冗余（见 `space.ts` 文件头）。
 */
export async function upsertSpaceSettings(
  db: Database,
  params: { userId: string; settings: SpaceSettingsRow; now: Date },
): Promise<void> {
  const values = {
    showStats: params.settings.showStats,
    showPosts: params.settings.showPosts,
    showAchievements: params.settings.showAchievements,
    motto: params.settings.motto,
  };

  await db
    .insert(userSpaces)
    .values({ userId: params.userId, ...values, updatedAt: params.now })
    .onConflictDoUpdate({
      target: userSpaces.userId,
      set: { ...values, updatedAt: params.now },
    });
}

/**
 * 节流窗口的**镜像常量**。
 *
 * 为什么不 import：`@xsu/db` 不能依赖 `@xsu/core`——core 的 `social/types.ts` 反过来引了本包
 * 的 schema 类型，db → core 就是环，分层规则（`packages/config/eslint/layering.mjs`）会直接拦下。
 *
 * **漂移症状**：改了 `@xsu/core` 的 `VISIT_THROTTLE_MS` 而忘了改这一行时，领域层判「该计」、
 * 这里的 SQL 判「不该计」，表现为「访问数不动，也不报错」——最难查的那种。两处一起改。
 */
const VISIT_THROTTLE_MS = 60 * 60 * 1000;

/**
 * 记一次空间访问，**只在上次计入超过节流窗口时才 +1**，返回这次是否计入。
 *
 * 用一条「带条件的 upsert」而不是「读一次判一下、再写」：
 *
 * - 头一次访问没有行，走插入分支（`visit_count = 1`）；已有行则在 `setWhere` 里比时间，
 *   够久才 `+1` 并推进时间戳。
 * - 两步写法并发下会双计：两个请求读到同一个旧时间戳，各自 +1。把判定放进
 *   `ON CONFLICT DO UPDATE ... WHERE` 之后，判定与写在同一条语句里，由行锁串行化。
 * - **领域层为什么也判一次**（`shouldCountVisit`）：它要在不写库的前提下就告诉调用方
 *   「这次不算」，省掉一次写。两道判定的边界完全相同——领域层是
 *   `now - lastVisitAt >= 窗口`，这里是 `lastVisitAt <= now - 窗口`，同一个谓词的两种写法，
 *   所以不会出现「领域层说该计、这里说不计」的分歧。
 * - 时间比较走列的映射（`lte(列, Date)`），不写裸字符串（文件头第 3 条）。
 *
 * 不计入时 `DO UPDATE ... WHERE` 为假、`returning` 不返回行，于是 `rows.length > 0` 正好是
 * 「这次计入了吗」。
 */
export async function recordSpaceVisit(
  db: Database,
  params: { userId: string; now: Date },
): Promise<boolean> {
  const cutoff = new Date(params.now.getTime() - VISIT_THROTTLE_MS);

  const rows = await db
    .insert(userStats)
    .values({ userId: params.userId, visitCount: 1, lastVisitAt: params.now })
    .onConflictDoUpdate({
      target: userStats.userId,
      set: {
        visitCount: sql`${userStats.visitCount} + 1`,
        lastVisitAt: params.now,
      },
      setWhere: or(isNull(userStats.lastVisitAt), lte(userStats.lastVisitAt, cutoff)),
    })
    .returning(userStatsColumns);

  return rows.length > 0;
}

/**
 * 访问统计。**没有行返回 null**（从没被计入过），按 0 处理由领域层决定
 * （`getSpaceStats` 把 null 折成 `visitCount: 0`）。
 */
export async function findSpaceStats(db: Database, userId: string): Promise<UserStatsRow | null> {
  const rows = await db
    .select(userStatsColumns)
    .from(userStats)
    .where(eq(userStats.userId, userId))
    .limit(1);

  return rows[0] ?? null;
}

/* ==========================================================================
   成就
   ========================================================================== */

/**
 * 批量记解锁时间。**撞主键 = 已经解锁过**，`ON CONFLICT DO NOTHING` 直接跳过：
 * `(user_id, achievement_id, level)` 只会有一行，等级回落也不删历史行。
 *
 * 空数组直接返回：`values([])` 会拼出语法非法的 SQL。调用方（领域层算出「这次刚解锁了
 * 哪些」）在没有新解锁时就是传空数组，属于正常路径，不是错误。
 */
export async function insertAchievementUnlocks(
  db: Database,
  rows: Array<{ userId: string; achievementId: string; level: number; now: Date }>,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  await db
    .insert(userAchievements)
    .values(
      rows.map((row) => ({
        userId: row.userId,
        achievementId: row.achievementId,
        level: row.level,
        unlockedAt: row.now,
      })),
    )
    .onConflictDoNothing();
}

/**
 * 我的解锁记录，按解锁时间**正序**（先解锁的在前 = 成就墙上的排列顺序）。
 *
 * **没解锁就没有行**：进度是实时算的（`achievements.ts`），这里只存「真的达成过」的事实。
 */
export async function listAchievementUnlocks(
  db: Database,
  userId: string,
): Promise<AchievementUnlockListItem[]> {
  return db
    .select(achievementUnlockListColumns)
    .from(userAchievements)
    .where(eq(userAchievements.userId, userId))
    .orderBy(asc(userAchievements.unlockedAt));
}
