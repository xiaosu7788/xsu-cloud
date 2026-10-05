/**
 * 积分账本。
 *
 * ## 唯一的写入口
 *
 * `applyPoints` 是**全站唯一**能改动积分余额的函数。它必须同时写 `user_points` 与
 * `point_transactions`，**在同一事务内**——只写一个就会出现两种坏结果：
 *
 * - 只写余额：用户看到「积分变了但流水里没有」，无法对账；
 * - 只写流水：用户看到「流水显示加了但余额没变」。
 *
 * 事务由仓储层的 `points.apply` 保证（见 `SocialPorts` 的注释），领域层不感知实现。
 *
 * ## 幂等
 *
 * `dedupKey` 是幂等的唯一手段，不是可选的优化。签到一天只能发一次分、管理员误点两次
 * 「发放」不该发两份——这些都靠 `(user_id, dedup_key)` 唯一索引挡下，**不靠先查再插**
 * （并发下后者会重复）。撞索引时 `applied: false`，这不是错误。
 */
import { SOCIAL_PAGE_SIZE_DEFAULT, type PointTransactionRecord, type SocialPorts } from './types';

/**
 * 发放（或扣减）积分。
 *
 * `delta` 为负表示扣减。**不在这里校验余额是否够**：本站没有消费出口（SPEC 1.2），
 * 扣减只由管理员操作，管理员有权把余额扣成负数（用于纠正错误发放）。
 * `insufficientPoints` 失败码先占位，等真的有了消费出口再启用。
 */
export async function applyPoints(
  ports: SocialPorts,
  input: {
    userId: string;
    delta: number;
    reason: string;
    detail?: string | null;
    dedupKey?: string | null;
    createdBy?: string | null;
  },
): Promise<{ ok: true; applied: boolean; balance: number }> {
  // delta 为 0 是合法的（记录一次「发生了什么但没改余额」的事件），不做特判。
  const delta = Math.trunc(input.delta);

  const result = await ports.points.apply({
    transactionId: ports.newId(),
    userId: input.userId,
    delta,
    reason: input.reason,
    detail: input.detail ?? null,
    dedupKey: input.dedupKey ?? null,
    createdBy: input.createdBy ?? null,
    now: ports.now(),
  });

  return { ok: true, applied: result.applied, balance: result.balance };
}

/** 查余额。没有记录时返回 0（未初始化的用户余额就是 0，不需要先建行）。 */
export async function getPointsBalance(
  ports: SocialPorts,
  request: { userId: string },
): Promise<number> {
  return ports.points.getBalance(request.userId);
}

/**
 * 最近的积分流水。
 *
 * 只取最近 N 条，不做游标分页：流水是「我最近获得了什么」的自查视图，
 * 没有「翻到第三页」的真实需求（参考实现也只给最近记录）。
 */
export async function listPointTransactions(
  ports: SocialPorts,
  request: { userId: string; limit?: number },
): Promise<PointTransactionRecord[]> {
  const limit = request.limit ?? SOCIAL_PAGE_SIZE_DEFAULT;
  return ports.points.listTransactions({
    userId: request.userId,
    limit: Math.max(1, Math.trunc(limit)),
  });
}
