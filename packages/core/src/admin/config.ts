/**
 * 站点配置：每小时配额覆盖的读取与更新。
 *
 * 三态语义在 `schema/admin.ts`：`null` = 不覆盖（跟随 env 默认）、`0` = 关闭、
 * 正数 = 覆盖值。读取走 `getSiteConfig`（无行 = 尚未设置过，页面显示默认态）；
 * 更新是 upsert（单例行 `id=1`），审计行与业务写同事务。
 */
import type { SiteConfigDetail } from '@xsu/db/schema';

import {
  ADMIN_AUDIT_TARGET,
  normalizeQuotaOverride,
  requireAdminActor,
  siteConfigDetail,
} from './rules';
import { ADMIN_AUDIT_ACTION, type AdminFailure, type AdminOutcome, type AdminPorts } from './types';

/** 读站点配置。无行返回 `null`（页面据此显示「尚未设置过」）。 */
export async function getSiteConfigForAdmin(
  ports: AdminPorts,
  request: { actorRole: unknown },
): Promise<AdminOutcome<SiteConfigDetail | null>> {
  const access = requireAdminActor(request.actorRole);
  if (!access.ok) {
    return access;
  }
  return { ok: true, value: await ports.getSiteConfig() };
}

/** 校验后的三个覆盖值。`null` = 不覆盖。 */
export type NormalizedSiteConfigInput = {
  postQuotaPerHour: number | null;
  commentQuotaPerHour: number | null;
  toolQuotaPerHour: number | null;
};

/**
 * 更新站点配置（upsert 单例行）。幂等性由 upsert 本身保证：重复提交同一组值会改
 * `updated_at` / `updated_by` 但值不变——审计行照写，因为「谁在什么时候动过配置」
 * 本身就是要留痕的事实。
 */
export async function updateSiteConfig(
  ports: AdminPorts,
  request: {
    actorId: string;
    actorRole: unknown;
    postQuotaPerHour: unknown;
    commentQuotaPerHour: unknown;
    toolQuotaPerHour: unknown;
  },
): Promise<AdminOutcome<NormalizedSiteConfigInput>> {
  const access = requireAdminActor(request.actorRole);
  if (!access.ok) {
    return access;
  }

  const post = normalizeQuota(request.postQuotaPerHour, 'postQuotaPerHour');
  if (!post.ok) {
    return post;
  }
  const comment = normalizeQuota(request.commentQuotaPerHour, 'commentQuotaPerHour');
  if (!comment.ok) {
    return comment;
  }
  const tool = normalizeQuota(request.toolQuotaPerHour, 'toolQuotaPerHour');
  if (!tool.ok) {
    return tool;
  }

  const values = {
    postQuotaPerHour: post.value,
    commentQuotaPerHour: comment.value,
    toolQuotaPerHour: tool.value,
  };
  const now = ports.now();
  await ports.updateSiteConfig({
    ...values,
    updatedBy: request.actorId,
    now,
    audit: {
      id: ports.newId(),
      actorId: request.actorId,
      action: ADMIN_AUDIT_ACTION.siteConfigUpdate,
      targetType: ADMIN_AUDIT_TARGET.siteConfig,
      targetId: 'site_config',
      detail: siteConfigDetail(values),
      createdAt: now,
    },
  });
  return { ok: true, value: values };
}

/** 单字段校验的内部包装：把字段名交给 `normalizeQuotaOverride`。 */
function normalizeQuota(
  raw: unknown,
  field: 'postQuotaPerHour' | 'commentQuotaPerHour' | 'toolQuotaPerHour',
): { ok: true; value: number | null } | { ok: false; failure: AdminFailure } {
  return normalizeQuotaOverride(raw, field);
}
