/**
 * 后台管理（M5）的站点配置表。
 *
 * 单例行设计：`id` 恒为 1（CHECK 兜底），配额覆盖用 nullable 整数列表达三态——
 * null = 不覆盖（用 env 默认）、0 = 关闭、正数 = 覆盖值。这样做比「一行一项」少一半行数，
 * 且「读一次拿全量」与领域层的配额判定形状一致。规则（取值范围）同时在列 CHECK 与
 * 领域层各兜一道：CHECK 挡直接写库的绕过，领域层挡入口校验。
 *
 * 表结构的事实来源是 `docs/spec/SPEC-admin.md` 第 2.2 节；本文件与之不一致即为缺陷。
 */
import { check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql, type SQLWrapper } from 'drizzle-orm';

import { user } from './auth';

/** 配额覆盖列的取值上限。领域层 `SITE_CONFIG_QUOTA_MAX` 与这里共用同一个数。 */
export const SITE_CONFIG_QUOTA_MAX = 1_000_000;

/** 配额覆盖列的 SQL 约束片段：null 放行，有值必须在 [0, MAX]。 */
/** 配额覆盖列的 SQL 约束片段：null 放行，有值必须在 [0, MAX]（上限是字面量，drizzle-kit 生不成参数）。 */
const quotaCheck = (col: SQLWrapper) =>
  sql`${col} is null or (${col} >= 0 and ${col} <= ${sql.raw(String(SITE_CONFIG_QUOTA_MAX))})`;

export const siteConfig = pgTable(
  'site_config',
  {
    /** 永远只有一行：id = 1。 */
    id: integer('id').primaryKey(),
    postQuotaPerHour: integer('post_quota_per_hour'),
    commentQuotaPerHour: integer('comment_quota_per_hour'),
    toolQuotaPerHour: integer('tool_quota_per_hour'),
    /** 最后改动者。账号删除时置 null，不抹掉「被改过」这件事。 */
    updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('site_config_id_check', sql`${table.id} = 1`),
    check('site_config_post_quota_check', quotaCheck(table.postQuotaPerHour)),
    check('site_config_comment_quota_check', quotaCheck(table.commentQuotaPerHour)),
    check('site_config_tool_quota_check', quotaCheck(table.toolQuotaPerHour)),
  ],
);

/** 页面展示用的投影：配置行带上改动者，页面直接引用。 */
export type SiteConfigDetail = {
  id: number;
  postQuotaPerHour: number | null;
  commentQuotaPerHour: number | null;
  toolQuotaPerHour: number | null;
  updatedBy: string | null;
  updatedAt: Date;
};

export const siteConfigDetailColumns = {
  id: siteConfig.id,
  postQuotaPerHour: siteConfig.postQuotaPerHour,
  commentQuotaPerHour: siteConfig.commentQuotaPerHour,
  toolQuotaPerHour: siteConfig.toolQuotaPerHour,
  updatedBy: siteConfig.updatedBy,
  updatedAt: siteConfig.updatedAt,
};
