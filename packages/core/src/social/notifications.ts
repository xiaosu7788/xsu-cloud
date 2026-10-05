/**
 * 通知的读取与已读。
 *
 * **写入通知不在这里**：通知是别人动作的副产物（有人评论了你的帖子），由产生该动作的
 * 模块调用 `notify()`（本文件底部）写入。本文件对外提供的是「查列表 / 数未读 / 标记已读」。
 *
 * ## 未读数为什么单独一个方法
 *
 * 未读数用在顶栏角标上，**每次页面渲染都要读**，而列表只在打开消息箱时读。两者共用一个
 * 查询会让角标把整页数据都拖出来。`countUnread` 走的是 `(recipient_id, read)` 前缀索引。
 */
import { SOCIAL_PAGE_SIZE_DEFAULT } from './types';
import { notificationDedupKey, resolveSocialPageSize } from './rules';
import {
  SOCIAL_FAILURE,
  type NotificationCategory,
  type NotificationRecord,
  type SocialPageOutcome,
  type SocialPorts,
} from './types';

/**
 * 消息箱列表。按分类筛选，游标分页。
 *
 * 游标用 `(createdAt, id)` 复合（与 `posts` 的游标同一取舍）：单靠时间在「同一毫秒两条」
 * 时会漏。这里的分页游标直接复用记录的两个字段，不像社区那样编码成字符串——消息箱没有
 * 暴露给外部链接的需求，不必防篡改。
 */
export async function listNotifications(
  ports: SocialPorts,
  request: {
    userId: string;
    category: NotificationCategory | null;
    limit?: unknown;
    cursorCreatedAt?: Date | null;
    cursorId?: string | null;
  },
): Promise<SocialPageOutcome<NotificationRecord>> {
  const limit = resolveSocialPageSize(request.limit);

  // 多取一行：多出来的那一行只用来回答「有没有下一页」，本身不进结果。
  const rows = await ports.notifications.listForUser({
    userId: request.userId,
    category: request.category,
    limit: limit + 1,
    cursorCreatedAt: request.cursorCreatedAt ?? null,
    cursorId: request.cursorId ?? null,
  });

  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    ok: true,
    items,
    nextCursor: hasNext && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
  };
}

/** 未读条数。只算 `read = false`。 */
export async function countUnreadNotifications(
  ports: SocialPorts,
  request: { userId: string },
): Promise<number> {
  return ports.notifications.countUnread(request.userId);
}

/**
 * 标记已读。
 *
 * `ids` 为 null 表示**全部标记**（打开消息箱时用）。给具体 id 时只标记属于本人的那些——
 * 仓储的 WHERE 里带 `recipient_id`，这是纵深防御：即使调用方传了别人的通知 id，
 * 也改不动别人的行。
 */
export async function markNotificationsRead(
  ports: SocialPorts,
  request: { userId: string; ids: string[] | null },
): Promise<{ ok: true; marked: number }> {
  const marked = await ports.notifications.markRead({
    userId: request.userId,
    ids: request.ids,
    now: ports.now(),
  });
  return { ok: true, marked };
}

/**
 * 写入一条通知（供其它模块调用）。
 *
 * 三条规则：
 *
 * 1. **不给自己发**：`actorId === recipientId` 时直接返回 `false`——自己评论自己的帖子
 *    不该产生「有人评论了你」。
 * 2. **`dedupKey` 默认由 `type + targetId + actorId` 推导**，调用方也可以显式传
 *    （系统广播传 `null` 表示不去重）。
 * 3. 返回**这次是否真的插入了行**（幂等冲突时为 false），让调用方决定是否要刷新角标缓存。
 */
export async function notify(
  ports: SocialPorts,
  input: {
    recipientId: string;
    category: NotificationCategory;
    type: string;
    actorId: string | null;
    targetId: string;
    postId?: string | null;
    commentId?: string | null;
    link?: string | null;
    title?: string | null;
    body?: string | null;
    /** `undefined` = 自动推导；`null` = 显式不去重。 */
    dedupKey?: string | null;
  },
): Promise<boolean> {
  if (input.actorId !== null && input.actorId === input.recipientId) {
    return false;
  }

  const dedupKey =
    input.dedupKey === undefined
      ? input.actorId === null
        ? null
        : notificationDedupKey({
            type: input.type,
            targetId: input.targetId,
            actorId: input.actorId,
          })
      : input.dedupKey;

  return ports.notifications.create({
    id: ports.newId(),
    recipientId: input.recipientId,
    category: input.category,
    type: input.type,
    actorId: input.actorId,
    postId: input.postId ?? null,
    commentId: input.commentId ?? null,
    link: input.link ?? null,
    title: input.title ?? null,
    body: input.body ?? null,
    dedupKey,
    now: ports.now(),
  });
}

/** 把「找不到收件人」这类错误统一成失败结果，给上层复用。 */
export const NOTIFICATION_FAILURE = SOCIAL_FAILURE;

/** 供页面直接引用的默认页大小（避免页面自己写魔数）。 */
export { SOCIAL_PAGE_SIZE_DEFAULT };
