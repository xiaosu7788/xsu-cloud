/**
 * 邀请码仓储。
 *
 * 只做数据访问，不含规则：判定在 `@xsu/core` 的 `checkInviteUsable`。
 * 这里唯一必须自己守住的性质是**原子性**——「一次性」不能靠「先查后写」实现。
 *
 * ## 为什么消费发生在建用户之后
 *
 * `invites.used_by` 是指向 `user.id` 的外键，用户行还不存在时无法写入使用者。
 * 想做到「先消费再建用户」，要么把外键改成 `DEFERRABLE` 并让两条语句共用一个事务，
 * 要么绕开 Better Auth 自己建用户——前者要求依赖 Better Auth 的内部事务边界，
 * 后者要重写口令散列与会话签发。两者都是 M1 不该建立的耦合。
 *
 * 所以顺序是：**先建用户 → 再原子消费 → 消费失败就把它删掉**。
 * `user` 上的外键是 `ON DELETE CASCADE`，删用户会连带清掉 `session` 与 `account`，
 * 「失败不留账号」这条性质因此成立。代价记录在 `docs/DATA-MODEL.md` 的已知债务里。
 */
import { and, eq, gt, isNull, or } from 'drizzle-orm';

import type { Database } from '../client';
import { inviteSnapshotColumns, invites, type InviteSnapshot } from '../schema/invites';

export type ConsumeInviteResult =
  /** 抢到了，`inviteId` 是邀请码行本身的 id。 */
  | { consumed: true; inviteId: string }
  /**
   * 没抢到。`snapshot` 是失败后的实际状态——交给领域层生成精确提示（已用 / 过期 / 脏数据）。
   * 为 null 表示这个码不存在。
   */
  | { consumed: false; snapshot: InviteSnapshot | null };

/** 按码查一条。大小写敏感，调用方负责先 `normalizeInviteCode`。 */
export async function findInviteByCode(db: Database, code: string): Promise<InviteSnapshot | null> {
  const rows = await db
    .select(inviteSnapshotColumns)
    .from(invites)
    .where(eq(invites.code, code))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * 原子消费一个邀请码。
 *
 * 一条带全部条件的 `UPDATE ... RETURNING` 就是 compare-and-set：并发下只有一个请求
 * 的 `WHERE` 会命中，其余返回 0 行。**不要把它拆成「先 SELECT 判断，再 UPDATE」，**
 * 那样两个并发注册都会看到「未使用」然后都写成功。
 *
 * `now` 由调用方传入而非用 SQL 的 `now()`：领域层的过期判定要拿同一个时间点，
 * 两边分别取当前时间会在边界上互相矛盾。也顺带让行为可测。
 */
export async function consumeInvite(
  db: Database,
  params: { code: string; userId: string; now: Date },
): Promise<ConsumeInviteResult> {
  const updated = await db
    .update(invites)
    .set({ usedBy: params.userId, usedAt: params.now })
    .where(
      and(
        eq(invites.code, params.code),
        isNull(invites.usedBy),
        isNull(invites.usedAt),
        or(isNull(invites.expiresAt), gt(invites.expiresAt, params.now)),
      ),
    )
    .returning({ id: invites.id });

  const claimed = updated[0];
  if (claimed) {
    return { consumed: true, inviteId: claimed.id };
  }

  // 失败原因只用于报错文案，读取放在 UPDATE 之后即可：抢码已经由上面的语句定死，
  // 这里再读只是解释「为什么没抢到」，读错也影响不了谁注册成功。
  return { consumed: false, snapshot: await findInviteByCode(db, params.code) };
}
