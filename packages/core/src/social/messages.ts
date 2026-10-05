/**
 * 私信：发送、读会话、处理申请。
 *
 * ## 防骚扰（本文件的核心）
 *
 * 没有关系时**只允许发一条申请消息**，对方同意后才能自由互发。这条规则在
 * `rules.decideMessagePermission` 里判定（纯函数、单独可测），本文件负责把判定结果
 * 落成动作：
 *
 * - `createsRequest: true` → 发消息的**同时**建 `dm_contacts(status='request')` 行。
 *   并发下第二个请求会拿到 `insertContact === false`，此时**必须拒绝**——否则两个人
 *   同时点发送会各发一条，绕过「只准一条」。
 * - 已有 `request` / `declined` → 直接拒绝，不写任何行。
 *
 * ## 方向（最容易搞反的一处）
 *
 * `dm_contacts` 的 `ownerId` 是**收到申请的人**，`peerId` 是**发起的人**。
 * 判断「我能不能给 A 发消息」时，查的是 `owner=A, peer=A 的 peer=我`。
 * 处理申请时反过来：我作为 owner 去看 `peer` 是谁。
 */
import { resolveDmPageSize, validateMessageInput, decideMessagePermission } from './rules';
import { notify } from './notifications';
import {
  SOCIAL_FAILURE,
  type DirectMessageRecord,
  type DmContactRecord,
  type SocialPorts,
} from './types';

/** 发送结果。`createdRequest` 告诉页面要提示「已发送申请，等待对方同意」。 */
export type SendMessageResult = {
  messageId: string;
  createdRequest: boolean;
};

/**
 * 发一条私信。
 *
 * `recipientIsAdmin` 由调用方查好传进来（收件人的角色在 `user` 表上，不在社交端口里）——
 * 领域层不额外引入一个「查用户角色」的端口，那个查询已经有主人（`accounts.ts`）。
 */
export async function sendMessage(
  ports: SocialPorts,
  request: {
    senderId: string;
    recipientId: string;
    recipientIsAdmin: boolean;
    body: unknown;
  },
): Promise<
  { ok: true; value: SendMessageResult } | { ok: false; failure: import('./types').SocialFailure }
> {
  const validated = validateMessageInput({ body: request.body });
  if (!validated.ok) {
    return validated;
  }

  const contact = await ports.messages.findContact({
    ownerId: request.recipientId,
    peerId: request.senderId,
  });

  const permission = decideMessagePermission({
    senderId: request.senderId,
    recipientId: request.recipientId,
    recipientIsAdmin: request.recipientIsAdmin,
    contactStatus: contact?.status ?? null,
  });
  if (!permission.allowed) {
    return { ok: false, failure: permission.failure };
  }

  const now = ports.now();

  /*
   * 需要建申请时**先建**：建不上说明并发下别人已经建过（或已有历史关系），
   * 此时不能再发消息——否则「只准一条」就被绕过了。
   */
  if (permission.createsRequest) {
    const inserted = await ports.messages.insertContact({
      ownerId: request.recipientId,
      peerId: request.senderId,
      now,
    });
    if (!inserted) {
      return { ok: false, failure: SOCIAL_FAILURE.dmPendingRequest };
    }
  }

  const messageId = ports.newId();
  await ports.messages.insert({
    id: messageId,
    fromUserId: request.senderId,
    toUserId: request.recipientId,
    body: validated.value.body,
    now,
  });

  /*
   * 给对方发一条通知。**`dedupKey` 显式传 null**：私信是对话，每条都该被看到，
   * 用「同一个人发的只留一条」会把后续消息全吞掉。会话内的未读数由
   * `countUnreadMessages` 单独算，通知只是「有人找你了」的提示。
   */
  await notify(ports, {
    recipientId: request.recipientId,
    category: 'social',
    type: permission.createsRequest ? 'dm_request' : 'dm_message',
    actorId: request.senderId,
    targetId: request.recipientId,
    link: '/console/messages',
    title: permission.createsRequest ? '有人想给你发私信' : '新的私信',
    body: validated.value.body.slice(0, 60),
    dedupKey: null,
  });

  return { ok: true, value: { messageId, createdRequest: permission.createsRequest } };
}

/**
 * 读一段会话（与某人的往来消息）。
 *
 * 读之前先判关系：**没有 `accepted` 关系也没有历史消息时返回空列表**，不报错——
 * 但要能看到自己发出的那条申请（否则用户不知道自己发过）。所以判定放在
 * 「能不能发」上，读则一律放行（能读到什么由数据决定）。
 *
 * 读完把发给我的未读标记为已读。
 */
export async function readConversation(
  ports: SocialPorts,
  request: { viewerId: string; peerId: string; limit?: unknown },
): Promise<DirectMessageRecord[]> {
  const limit = resolveDmPageSize(request.limit);
  const rows = await ports.messages.listConversation({
    viewerId: request.viewerId,
    peerId: request.peerId,
    limit,
  });

  await ports.messages.markConversationRead({
    viewerId: request.viewerId,
    peerId: request.peerId,
    now: ports.now(),
  });

  return rows;
}

/** 我收到的未读私信总数（顶栏角标）。 */
export async function countUnreadMessages(
  ports: SocialPorts,
  request: { viewerId: string },
): Promise<number> {
  return ports.messages.countUnread(request.viewerId);
}

/** 我收到的待处理申请。 */
export async function listPendingRequests(
  ports: SocialPorts,
  request: { viewerId: string },
): Promise<DmContactRecord[]> {
  return ports.messages.listPendingRequests(request.viewerId);
}

/**
 * 处理一条申请（同意 / 拒绝）。
 *
 * 只有**收件人本人**能处理，且只有 `request` 状态可处理（判定在
 * `rules.decideContactReview`）。重复处理返回 `inputInvalid`——幂等地说「没有待处理的申请」。
 */
export async function reviewContactRequest(
  ports: SocialPorts,
  request: {
    viewerId: string;
    peerId: string;
    decision: 'accepted' | 'declined';
  },
): Promise<
  | { ok: true; status: 'accepted' | 'declined' }
  | { ok: false; failure: import('./types').SocialFailure }
> {
  // 我作为 owner（收到申请的人），对端是 peer（发起的人）。
  const contact = await ports.messages.findContact({
    ownerId: request.viewerId,
    peerId: request.peerId,
  });

  if (request.viewerId === request.peerId) {
    return { ok: false, failure: SOCIAL_FAILURE.conversationForbidden };
  }
  if (!contact || contact.status !== 'request') {
    return { ok: false, failure: { ...SOCIAL_FAILURE.inputInvalid, field: 'status' } };
  }

  await ports.messages.updateContactStatus({
    ownerId: request.viewerId,
    peerId: request.peerId,
    status: request.decision,
    now: ports.now(),
  });

  // 同意后告诉发起者一声，别让他一直等。
  if (request.decision === 'accepted') {
    await notify(ports, {
      recipientId: request.peerId,
      category: 'social',
      type: 'dm_accepted',
      actorId: request.viewerId,
      targetId: request.viewerId,
      link: '/console/messages',
      title: '私信申请已通过',
      body: '对方同意了你的私信申请，现在可以继续发消息。',
      /*
       * 同一个「同意」只该通知一次：用固定的 dedupKey，重复处理撞唯一索引。
       * （虽然状态机已经保证只能从 request 转一次，这是第二道防线。）
       */
      dedupKey: `dm_accepted:${request.viewerId}:${request.peerId}`,
    });
  }

  return { ok: true, status: request.decision };
}
