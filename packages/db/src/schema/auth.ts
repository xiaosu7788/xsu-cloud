/**
 * 鉴权相关表（Better Auth 的标准四张表）。
 *
 * 字段命名遵循 Better Auth 的约定：Drizzle 属性名用 camelCase（Better Auth 的
 * adapter 按属性名访问），数据库列名用 snake_case。两者不一致时以 Better Auth
 * 文档为准，改这里之前先跑通登录再改。
 *
 * 表结构的事实来源是 `docs/DATA-MODEL.md`；本文件与之不一致即为缺陷。
 */
import { boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** 角色取值。领域层的权限判定基于这里的两个值（见 `packages/core`）。 */
export const ROLES = ['user', 'admin'] as const;

/**
 * 新用户的默认角色。
 *
 * 领域层（`packages/core/src/access.ts`）把这个常量转出去给应用层用，两边共用同一个值。
 * 不在别处写 `'user'` 字面量：代码里判一种角色、数据库默认值是另一种，只会在生产露出来。
 */
export const DEFAULT_ROLE = 'user' satisfies (typeof ROLES)[number];

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  /** 角色。默认 user；提升为 admin 只能由管理员在后台操作，且要写审计日志（红线 8）。 */
  role: text('role').notNull().default(DEFAULT_ROLE),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('session_user_id_idx').on(table.userId)],
);

/**
 * 第三方账号绑定。
 *
 * `providerId` 是 Better Auth 的提供方标识；`accountId` 是该提供方侧的用户标识。
 * 同一个 (providerId, accountId) 唯一，避免同一个第三方账号绑到两个本地用户上。
 */
export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    /** 邮箱密码路径的密码散列；OAuth 账号此列为 null。 */
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('account_user_id_idx').on(table.userId),
    index('account_provider_idx').on(table.providerId, table.accountId),
  ],
);

/** 邮箱验证、找回密码等一次性令牌的存放处。 */
export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);
