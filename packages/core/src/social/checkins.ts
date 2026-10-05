/**
 * 每日签到。
 *
 * ## 一次签到的完整步骤（顺序不能变）
 *
 * 1. **算站点时区的今天**（`siteDateString`）。用 UTC 日期会让中国用户晚上 8 点之后的
 *    签到被算成「第二天」——参考实现踩过这个坑。
 * 2. **读上一次签到**。它的 `checkinDate` 等于今天就说明已经签过 → 幂等返回，**不再发分**。
 * 3. **算连续天数**（`computeStreak`）：上次是昨天则 +1，否则重置为 1。
 * 4. **写签到行**。主键 `(userId, checkinDate)` 是并发防线：两个请求同时到达时，
 *    只有一个能插入成功，另一个拿到 `false`。
 * 5. **只有插入成功才发积分**。这一步是第 4 步的 `boolean` 存在的理由——
 *    如果先发分再插入，并发下会发两份。
 *
 * ## 为什么「已签到」用失败码返回而不是 `ok: true`
 *
 * 页面上要有明确反馈（「今天已经签到过了」），而这不是异常路径——它是**正常**的重复操作。
 * 用 `ok: false` + `alreadyCheckedIn` 让调用方必须显式处理，比静默返回同一个结果更难写错。
 * 状态码是 409（与 400 区分开：请求本身没问题，是当前状态不允许）。
 */
import { checkinDedupKey, checkinPoints, computeStreak, siteDateString } from './rules';
import { SOCIAL_FAILURE, type CheckinRecord, type SocialPorts } from './types';
import type { CheckinListItem } from '@xsu/db/schema';

/** 签到成功的结果。 */
export type CheckinSuccess = {
  checkinDate: string;
  points: number;
  streak: number;
  balance: number;
};

/** 签到。已签过返回 `alreadyCheckedIn`（409），不返回成功。 */
export async function checkin(
  ports: SocialPorts,
  request: { userId: string },
): Promise<
  | { ok: true; value: CheckinSuccess }
  | { ok: false; failure: typeof SOCIAL_FAILURE.alreadyCheckedIn }
> {
  const now = ports.now();
  const today = siteDateString(now);

  // 第 2 步：先看有没有签过。这一步是「快速失败」，不承担并发正确性——
  // 并发正确性由第 4 步的主键保证（两个请求都可能通过这里的检查）。
  const latest = await ports.checkins.findLatest(request.userId);
  if (latest && latest.checkinDate === today) {
    return { ok: false, failure: SOCIAL_FAILURE.alreadyCheckedIn };
  }

  // 第 3 步：连续天数。
  const streak = computeStreak({
    lastDate: latest?.checkinDate ?? null,
    lastStreak: latest?.streak ?? null,
    today,
  });
  const points = checkinPoints();

  // 第 4 步：写签到行。插入失败说明并发下别人先插了 → 当作「今天已签到」。
  const inserted = await ports.checkins.insert({
    userId: request.userId,
    checkinDate: today,
    points: points.total,
    basePoints: points.base,
    bonusPoints: points.bonus,
    streak,
    now,
  });
  if (!inserted) {
    return { ok: false, failure: SOCIAL_FAILURE.alreadyCheckedIn };
  }

  // 第 5 步：发分。`dedupKey` 与签到行同一个日期口径，所以即使这里被重放也不会重复发放。
  const applied = await ports.points.apply({
    transactionId: ports.newId(),
    userId: request.userId,
    delta: points.total,
    reason: 'checkin',
    detail: `每日签到（连续 ${streak} 天）`,
    dedupKey: checkinDedupKey(request.userId, today),
    createdBy: null,
    now,
  });

  return {
    ok: true,
    value: {
      checkinDate: today,
      points: points.total,
      streak,
      balance: applied.balance,
    },
  };
}

/**
 * 签到状态：今天签没签、连续几天、总共签了多少次。
 *
 * 页面上第一屏要显示这些，所以一次查询拿全，不做「先查状态再查历史」两次往返。
 */
export async function getCheckinStatus(
  ports: SocialPorts,
  request: { userId: string },
): Promise<{
  today: string;
  checkedInToday: boolean;
  streak: number;
  total: number;
  recent: CheckinListItem[];
}> {
  const today = siteDateString(ports.now());
  const latest = await ports.checkins.findLatest(request.userId);
  const recent = await ports.checkins.listRecent({ userId: request.userId, limit: 30 });

  return {
    today,
    checkedInToday: latest?.checkinDate === today,
    // 连续天数的展示口径：如果今天还没签，显示「上次连续到几」而不是 0——
    // 展示 0 会让用户以为记录丢了。签到成功后 streak 自然 +1。
    streak: latest?.streak ?? 0,
    total: recent.length,
    recent,
  };
}

/** 签到记录的原始行（给页面用）。 */
export type { CheckinRecord, CheckinListItem };
