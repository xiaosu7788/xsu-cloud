/**
 * 邀请码准入规则。
 *
 * `docs/PRD.md` 3.6 的验收 2 只有一句话：「邀请码为一次性，重复使用被拒并有明确提示。」
 * 这句话拆成两半，分别落在不同层：
 *
 * - **判定**（一次性、是否过期、是否为脏数据）在这里，纯函数，可单独测试；
 * - **消费**（并发下的「谁先抢到」）在 `@xsu/db` 的仓储里，用一条带条件的 `UPDATE ... RETURNING`
 *   完成 compare-and-set。判定通过不等于占到码——只做「先查后写」会在并发下放出两个用户。
 *
 * ## 调用顺序
 *
 * 「先消费再建用户」做不到：`invites.used_by` 指向 `user.id` 的外键，用户行还不存在时写不进去；
 * 要绕开就得改 `DEFERRABLE` 外键并依赖 Better Auth 的内部事务边界，属于 M1 不该建立的耦合
 * （取舍与理由写在 `@xsu/db` 的 `repositories/invites.ts` 文件头）。
 *
 * 所以实际顺序是：**建用户 → 原子消费 → 消费失败就把用户删掉**。`user` 上的外键是
 * `ON DELETE CASCADE`，删用户会连带清掉 `session` 与 `account`，「失败不留账号」因此成立。
 * 这里的判定函数负责先挡掉注定失败的请求，真正决定成败的仍是仓储那次原子消费。
 *
 * 大小写敏感：`invites.code` 是原样存储的随机串，不做大小写归一，只裁掉首尾空白
 * （用户从聊天窗口复制的码常带空格或换行）。
 */
import type { InviteSnapshot } from '@xsu/db/schema';

/**
 * 字段投影的事实来源是数据层（`@xsu/db` 的 `invites` 表旁），这里只是转出去，
 * 不重复声明一份结构相同的类型——两份定义迟早会漂移，而且编译器不会提醒。
 */
export type { InviteSnapshot };

/**
 * 拒绝原因表。
 *
 * 文案必须能直接给用户看（PRD 3.6 验收 2 要求「明确提示」），所以不用「操作失败」这类废话：
 * 用户要能区分「码错了」「码用过了」「码过期了」三种情况，才知道下一步该干什么。
 */
export const INVITE_REJECTION = {
  required: {
    code: 'INVITE_REQUIRED',
    message: '注册需要邀请码。本站不开放自由注册，请向邀请人索取。',
  },
  notFound: {
    code: 'INVITE_NOT_FOUND',
    message: '邀请码不存在，请核对后重试。',
  },
  used: {
    code: 'INVITE_USED',
    message: '该邀请码已被使用。邀请码是一次性的，请向邀请人索取新的邀请码。',
  },
  expired: {
    code: 'INVITE_EXPIRED',
    message: '邀请码已过期，请向邀请人索取新的邀请码。',
  },
  corrupted: {
    code: 'INVITE_CORRUPTED',
    message: '邀请码数据异常，无法使用。请联系管理员核查。',
  },
} as const;

export type InviteRejection = (typeof INVITE_REJECTION)[keyof typeof INVITE_REJECTION];

export type InviteCheck = { ok: true } | { ok: false; rejection: InviteRejection };

const inviteCheckOk: InviteCheck = { ok: true };

function reject(rejection: InviteRejection): InviteCheck {
  return { ok: false, rejection };
}

/**
 * 裁掉用户输入里的首尾空白。空串按「没填」处理，由调用方决定是 `required` 还是 `notFound`。
 */
export function normalizeInviteCode(raw: string | null | undefined): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * `usedBy` / `usedAt` 必须同时有值或同时为空，只给一个是脏数据（见 `@xsu/db` 的 `invites` 表注释）。
 * 脏数据一律按不可用处理——fail closed，不要猜「大概还没用」就把码放出去。
 */
export function isInviteCorrupted(invite: InviteSnapshot): boolean {
  return (invite.usedBy === null) !== (invite.usedAt === null);
}

export function isInviteUsed(invite: InviteSnapshot): boolean {
  return invite.usedBy !== null && invite.usedAt !== null;
}

/**
 * 判断一个邀请码当前是否可用于注册。
 *
 * `now` 必须由调用方传入而不是在函数里取当前时间，否则过期边界无法测试。
 * 传入 `null` 或 `undefined` 表示这个码查不到，返回 `notFound`。
 */
export function checkInviteUsable(
  invite: InviteSnapshot | null | undefined,
  now: Date,
): InviteCheck {
  if (!invite) {
    return reject(INVITE_REJECTION.notFound);
  }
  if (isInviteCorrupted(invite)) {
    return reject(INVITE_REJECTION.corrupted);
  }
  if (isInviteUsed(invite)) {
    return reject(INVITE_REJECTION.used);
  }
  // 过期判定用 `<=`：到期时刻本身已不可用，边界不含等号会多放出一个「刚好赶上」的注册。
  if (invite.expiresAt !== null && invite.expiresAt.getTime() <= now.getTime()) {
    return reject(INVITE_REJECTION.expired);
  }
  return inviteCheckOk;
}
