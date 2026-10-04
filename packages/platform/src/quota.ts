/**
 * 站点级每小时配额的解析（M5）：把 `site_config` 的覆盖值合并进 env 默认值。
 *
 * `docs/spec/SPEC-admin.md` 第 4 节：生效优先级是 **DB 覆盖 > env 默认 > core 常量**。
 * env 的解析已经在 `./env` 里完成了「env 默认 > core 常量」那一级，所以这里只需要
 * 处理 DB 覆盖这一层：单例行存在且某项非 `null` 就用它，否则落回 env 值。
 *
 * 三态语义（`site_config` 列的约定，与 core 的 `normalizeQuota` 一致）：
 *
 * - `null` = 不覆盖 → 用 env 默认；
 * - `0` = 关闭（该行为每小时配额为零，用户请求会被配额判定拒绝）；
 * - 正数 = 覆盖值。
 *
 * 刻意**不做任何缓存**：配置变更对下一次端口构造生效（SPEC 已接受这个时延）。
 * 读失败直接抛出——配额判定错向（把「读不到配置」当「用默认值」）比请求失败更糟：
 * 管理员把配额设成 0 关闭某类行为时，一次 DB 抖动不能把限制悄悄放回默认值。
 */
import { getSiteConfig, type Database } from '@xsu/db';

import type { ServerEnv } from './env';

/** 三项每小时配额的有效值（合并 DB 覆盖与 env 默认之后）。 */
export type QuotaOverrides = {
  postQuotaPerHour: number;
  commentQuotaPerHour: number;
  toolQuotaPerHour: number;
};

/**
 * 读站点配置并合并出三项有效值。每次 `createCommunityPorts` / `createToolPorts`
 * 构造时现读（两个工厂因此是异步的，SPEC 第 4 节的既定取舍）。
 */
export async function resolveQuotaOverrides(db: Database, env: ServerEnv): Promise<QuotaOverrides> {
  const config = await getSiteConfig(db);

  return {
    postQuotaPerHour: config?.postQuotaPerHour ?? env.community.postQuotaPerHour,
    commentQuotaPerHour: config?.commentQuotaPerHour ?? env.community.commentQuotaPerHour,
    toolQuotaPerHour: config?.toolQuotaPerHour ?? env.tools.quotaPerHour,
  };
}
