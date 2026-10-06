/**
 * 社交的平台适配：把领域层的端口接到数据库仓储上，并提供页面要的读取。
 *
 * 与 `./community` 同一条分层理由（`docs/ARCHITECTURE.md` 2.1 把 `packages/platform` 列为
 * 「可被应用层使用」，数据层不在其列）：应用层只 import 本模块，不 import `@xsu/db`；
 * 「怎么装配依赖」只有这一处。本文件不做任何判定——签到幂等、私信申请三态、空间分区裁剪、
 * 积分账本、成就进度全在 `@xsu/core` 的 `src/social/`，这里只是「把端口转成仓储调用，
 * 把仓储结果原样交出」。
 *
 * ## 与 `./community` 的两点差异
 *
 * 1. **`userId` 不绑定进端口。** 社区的端口把用户绑在构造期（`likedPostIds` 只回答「我赞过
 *    什么」），社交的领域函数则是**每个都以 `{ userId }` 为入参**（`checkin` / `sendMessage` /
 *    `listNotifications` …），调用方从会话里取出来传进去。绑定在这里就得在 gateway 上再转发
 *    一层同名函数，多出一处可能传错 id 的地方，而收益是零：领域层本来就要这个参数。
 *    所以 `deps.userId` 只服务下面四个**页面读取**；没传时它们返回空结果——这不是伪成功，
 *    是「匿名访客没有会话」的真话（与 `likedPostIds` 同一取舍）。
 * 2. **多出一组页面读取**（`authorSummaries` / `isAdminUser` / `dmThreads` / `unreadSummary`）。
 *    领域层不认识「列表上要显示对方叫什么」「顶栏角标要一个数」这类展示需求，它们只属于本文件。
 *
 * ## 为什么叫 `SocialGateway`
 *
 * `SocialPorts` 那个名字已经被 `@xsu/core` 的端口契约占用（本文件 import 它，但不转发）。
 * 这里的装配物多出四个页面读取，所以另起一个名字：语义是「领域端口 + 页面读取」的合体。
 */
import { randomUUID } from 'node:crypto';

import type { SocialPorts } from '@xsu/core';
import {
  applyPointTransaction,
  countUnreadMessages,
  countUnreadNotifications,
  findDmContact,
  findLatestCheckin,
  findSpaceSettings,
  findSpaceStats,
  getDb,
  getPointBalance,
  insertAchievementUnlocks,
  insertCheckin,
  insertDirectMessage,
  insertDmContact,
  insertNotification,
  isUserAdmin,
  listAchievementUnlocks,
  listAuthorSummaries,
  listConversationMessages,
  listDmThreads,
  listNotificationsForUser,
  listPendingDmRequests,
  listPointTransactions,
  listRecentCheckins,
  markConversationRead,
  markNotificationsRead,
  recordSpaceVisit,
  updateDmContactStatus,
  upsertSpaceSettings,
  type AuthorSummary,
  type Database,
  type DmThreadListItem,
} from '@xsu/db';

/**
 * 默认取 `@xsu/db` 的共享连接；测试可传入独立的库。
 *
 * `now` / `newId` 与 `./community` 的 `now()` 同源：它们能注入，是为了领域层的判定与落库
 * 共用同一个时间点、以及让「id 是什么」在测试里可预期。
 */
export type SocialGatewayDeps = {
  /** 当前登录用户。只有 `dmThreads` 与 `unreadSummary` 用它；未登录时不传。 */
  userId?: string;
  db?: Database;
  /** 默认 `() => new Date()`。 */
  now?: () => Date;
  /** 默认 `randomUUID()`。 */
  newId?: () => string;
};

/**
 * 会话列表默认取多少条。
 *
 * 不复用 `@xsu/core` 的 `DM_PAGE_SIZE_DEFAULT`（50，那是**一段会话**的消息页大小）：
 * 两个数字的语义不同，将来调一个不该带着另一个动。上限由仓储的 `SOCIAL_FETCH_HARD_CAP` 兜。
 */
const DM_THREAD_LIMIT_DEFAULT = 20;

/** 领域端口 + 页面读取。方法一一转发，本文件里没有任何一条 if 是业务规则。 */
export type SocialGateway = SocialPorts & {
  /** 一批用户 id → 姓名与头像。缺的 id 不在返回值里，调用方自行兜底展示。 */
  authorSummaries: (userIds: string[]) => Promise<Map<string, AuthorSummary>>;
  /**
   * 这个人是不是管理员。私信页要用它算「管理员豁免」——那是领域层规则
   * （`decideMessagePermission`），这里只提供规则需要的那个事实。
   */
  isAdminUser: (userId: string) => Promise<boolean>;
  /** 我的会话列表（每个对端一行：最后一句 + 未读数）。未登录恒为空数组。 */
  dmThreads: (limit?: number) => Promise<DmThreadListItem[]>;
  /**
   * 顶栏角标用的两个未读数与合计。未登录恒为全 0。
   *
   * 合计在这里算而不是在页面里加：两个数字与它们的和必须来自同一次读取，否则角标会出现
   * 「9 + 1 = 9」这类瞬时不一致。
   */
  unreadSummary: () => Promise<{ notifications: number; messages: number; total: number }>;
};

/**
 * 建一个社交网关。每次请求新建即可——它自己不持有数据库连接（`getDb()` 拿的是进程内共享的
 * 连接池）。同步函数（与 `createCommunityPorts` 不同：社交这一批没有需要现读 `site_config`
 * 的配额），调用方不必 `await`。
 */
export function createSocialPorts(deps: SocialGatewayDeps = {}): SocialGateway {
  const db = deps.db ?? getDb();
  const viewerId = deps.userId;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());

  return {
    now,
    newId,

    notifications: {
      /*
       * 端口用 `now`、仓储用 `createdAt`：这是本文件唯一一处「翻译」，不是笔误。
       * 端口面向领域层（时间点由它传），仓储面向表列（`created_at`）。
       */
      create(input) {
        return insertNotification(db, {
          id: input.id,
          recipientId: input.recipientId,
          category: input.category,
          type: input.type,
          actorId: input.actorId,
          postId: input.postId,
          commentId: input.commentId,
          link: input.link,
          title: input.title,
          body: input.body,
          dedupKey: input.dedupKey,
          createdAt: input.now,
        });
      },

      listForUser(params) {
        return listNotificationsForUser(db, params);
      },

      countUnread(userId) {
        return countUnreadNotifications(db, userId);
      },

      markRead(params) {
        return markNotificationsRead(db, params);
      },
    },

    points: {
      // 端口的 `transactionId` 与仓储的 `id` 是同一个值，名字按各自的视角取。
      apply(input) {
        return applyPointTransaction(db, {
          id: input.transactionId,
          userId: input.userId,
          delta: input.delta,
          reason: input.reason,
          detail: input.detail,
          dedupKey: input.dedupKey,
          createdBy: input.createdBy,
          now: input.now,
        });
      },

      getBalance(userId) {
        return getPointBalance(db, userId);
      },

      listTransactions(params) {
        return listPointTransactions(db, params);
      },
    },

    checkins: {
      insert(input) {
        return insertCheckin(db, input);
      },

      findLatest(userId) {
        return findLatestCheckin(db, userId);
      },

      listRecent(params) {
        return listRecentCheckins(db, params);
      },
    },

    messages: {
      insert(input) {
        return insertDirectMessage(db, input);
      },

      listConversation(params) {
        return listConversationMessages(db, params);
      },

      markConversationRead(params) {
        return markConversationRead(db, params);
      },

      countUnread(viewer) {
        return countUnreadMessages(db, viewer);
      },

      listPendingRequests(viewer) {
        return listPendingDmRequests(db, viewer);
      },

      findContact(params) {
        return findDmContact(db, params);
      },

      insertContact(input) {
        return insertDmContact(db, input);
      },

      updateContactStatus(params) {
        return updateDmContactStatus(db, params);
      },
    },

    space: {
      findSettings(userId) {
        return findSpaceSettings(db, userId);
      },

      upsertSettings(params) {
        return upsertSpaceSettings(db, params);
      },

      recordVisit(params) {
        return recordSpaceVisit(db, params);
      },

      findStats(userId) {
        return findSpaceStats(db, userId);
      },
    },

    achievements: {
      insertUnlocks(rows) {
        return insertAchievementUnlocks(db, rows);
      },

      listUnlocks(userId) {
        return listAchievementUnlocks(db, userId);
      },
    },

    authorSummaries(userIds) {
      return listAuthorSummaries(db, { userIds });
    },

    isAdminUser(userId) {
      return isUserAdmin(db, userId);
    },

    async dmThreads(limit) {
      if (viewerId === undefined) return [];
      return listDmThreads(db, { viewerId, limit: limit ?? DM_THREAD_LIMIT_DEFAULT });
    },

    async unreadSummary() {
      if (viewerId === undefined) return { notifications: 0, messages: 0, total: 0 };

      const [notifications, messages] = await Promise.all([
        countUnreadNotifications(db, viewerId),
        countUnreadMessages(db, viewerId),
      ]);

      return { notifications, messages, total: notifications + messages };
    },
  };
}
