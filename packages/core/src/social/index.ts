/**
 * 社交模块的入口。`packages/core/src/index.ts` 只转发本文件，操作文件再多也不用改根入口。
 *
 * 依赖方向（不允许反向，也没有环）：
 *
 * ```text
 * types.ts          契约、失败码、端口、常量。只有声明
 *    ▲
 * rules.ts          纯规则：日期口径、校验、连续天数、申请三态、展示裁剪（无 I/O）
 *    ▲
 * notifications.ts  通知的读写 + notify()（供 messages.ts 调用）
 * points.ts         积分账本（唯一写入口 applyPoints）
 * checkins.ts       签到（用 points 发分）
 * messages.ts       私信（用 notifications 通知）
 * space.ts          个人空间的设置与访问计数
 * achievements.ts   成就定义表 + 纯计算 + 解锁落库
 * ```
 *
 * **横向依赖只有两处**（`messages → notifications`、`checkins → points`），都是有意的：
 * 它们表达的是真实的业务因果（发私信要通知对方、签到要发分），不是便利性复用。
 */
export * from './achievements';
export * from './checkins';
export * from './messages';
export * from './notifications';
export * from './points';
export * from './rules';
export * from './space';
export * from './types';
