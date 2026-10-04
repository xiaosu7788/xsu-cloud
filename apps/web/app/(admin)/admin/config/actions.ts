'use server';

/**
 * 站点配置的 Server Action：保存三项每小时配额覆盖。
 *
 * 三态校验在 `@xsu/core` 的 `normalizeQuotaOverride`（与 `site_config` 列的 CHECK 同口径）：
 * 空串 = 不覆盖（跟随部署环境默认）、0 = 关闭、正整数 = 覆盖值。这里只把 `FormData` 摊成
 * 一次调用；upsert + 审计同事务在数据层端口里。
 *
 * ## 失败也 redirect
 *
 * `?error=` 传 `ADMIN_FAILURE` 的**键**（`failureKey` 从 API code 映射）。本页没有分页与
 * 搜索上下文，成功与失败都直接回 `/admin/config`。
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { updateSiteConfig } from '@xsu/core';
import { createAdminGateway } from '@xsu/platform';

import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readAdminAccess } from '@/features/auth/session';
import { ADMIN_CONFIG } from '@/features/admin/routes';
import { failureKey } from '@/features/admin/view';

/** `FormData` 读出来的字符串。字段缺失时给 `undefined`（领域层与空串同样按「不覆盖」处理）。 */
function readField(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * 保存三项配额覆盖。幂等性由 upsert 本身保证：重复提交同一组值也会留一行审计——
 * 「谁在什么时候动过配置」本身就是要留痕的事实（SPEC §3）。
 */
export async function updateSiteConfigAction(formData: FormData): Promise<void> {
  const access = await readAdminAccess();
  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return;
  }

  const outcome = await updateSiteConfig(createAdminGateway(), {
    actorId: access.user.id,
    actorRole: access.role,
    postQuotaPerHour: readField(formData, 'postQuotaPerHour'),
    commentQuotaPerHour: readField(formData, 'commentQuotaPerHour'),
    toolQuotaPerHour: readField(formData, 'toolQuotaPerHour'),
  });

  revalidatePath(ADMIN_CONFIG);
  redirect(
    outcome.ok
      ? `${ADMIN_CONFIG}?ok=site-config`
      : `${ADMIN_CONFIG}?error=${encodeURIComponent(failureKey(outcome.failure) ?? 'inputInvalid')}`,
  );
}
