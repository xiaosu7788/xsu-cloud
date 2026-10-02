/**
 * 邀请码表。
 *
 * 准入规则（`docs/PRD.md` 3.6）：注册必须携带邀请码，**一个码只能用一次**，
 * 重复使用必须被拒并给出明确提示。规则本身在领域层，本表只负责持久化。
 *
 * `usedBy` / `usedAt` 同时有值才表示已使用；只给一个值属于脏数据。
 */
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { user } from './auth';

export const invites = pgTable(
  'invites',
  {
    id: text('id').primaryKey(),
    /** 邀请码本体，大小写敏感，全局唯一。 */
    code: text('code').notNull().unique(),
    /** 发放者。首个管理员由脚本直接建，此时为 null。 */
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    /** 使用者的用户 id；未使用时为 null。 */
    usedBy: text('used_by').references(() => user.id, { onDelete: 'set null' }),
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** 过期时间；为 null 表示不过期。 */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('invites_used_by_idx').on(table.usedBy)],
);

/**
 * 判定邀请码可用性所需的字段投影。
 *
 * 放在表旁边而不是各层各写一份：`@xsu/core` 的 `checkInviteUsable` 直接引用这个类型，
 * 表结构改了而判定还按旧结构走会被编译器拦下，不会变成静默漂移。
 */
export type InviteSnapshot = {
  /** 使用者的用户 id；未使用时为 null。 */
  usedBy: string | null;
  /** 使用时间；未使用时为 null。 */
  usedAt: Date | null;
  /** 过期时间；为 null 表示不过期。 */
  expiresAt: Date | null;
};

/** `InviteSnapshot` 对应的 select 投影。加字段时必须和上面的类型一起改。 */
export const inviteSnapshotColumns = {
  usedBy: invites.usedBy,
  usedAt: invites.usedAt,
  expiresAt: invites.expiresAt,
};
