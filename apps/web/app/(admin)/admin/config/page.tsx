/**
 * 站点配置（`/admin/config`）：三项每小时配额覆盖。
 *
 * ## 三态语义（SPEC §3）
 *
 * 输入留空 = 不覆盖（跟随部署环境默认值）、`0` = 关闭该动作、正整数 = 覆盖值（上限
 * `SITE_CONFIG_QUOTA_MAX`，前端 `min` / `max` 只是友好提示，真正校验在领域层，与
 * `site_config` 列的 CHECK 同口径）。
 *
 * ## 展示
 *
 * 无配置行时显示「尚未设置过」；有行时显示三个当前值 + 最后改动人与时间。保存后新的
 * 配额立即生效（读取侧直接查这行）。
 */
import type { Metadata } from 'next';

import { SITE_CONFIG_QUOTA_MAX } from '@xsu/core';
import type { SiteConfigDetail } from '@xsu/db/schema';
import { getSiteConfigForAdmin } from '@xsu/core';
import { createAdminGateway, createCommunityPorts } from '@xsu/platform';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AccessDenied } from '@/features/auth/access-denied';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readAdminAccess } from '@/features/auth/session';
import { AdminBanner, formatAdminDate, readErrorCode, readOkCode } from '@/features/admin/view';

import { updateSiteConfigAction } from './actions';

export const metadata: Metadata = {
  title: '站点配置',
};

/** 一个配额字段的行：标签、当前值说明与数字输入。三态语义在 placeholder 里说清。 */
function QuotaField(params: {
  name: string;
  label: string;
  current: number | null;
  description: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={params.name}>{params.label}</Label>
      <Input
        type="number"
        id={params.name}
        name={params.name}
        min={0}
        max={SITE_CONFIG_QUOTA_MAX}
        step={1}
        defaultValue={params.current === null ? '' : String(params.current)}
        placeholder="留空 = 不覆盖"
        aria-describedby={`${params.name}-hint`}
        className="max-w-xs"
      />
      <p id={`${params.name}-hint`} className="text-xs text-muted-foreground">
        {params.description}
      </p>
    </div>
  );
}

export default async function AdminConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const access = await readAdminAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  const params = await searchParams;
  const gateway = createAdminGateway();
  const config = await getSiteConfigForAdmin(gateway, { actorRole: access.role });

  if (!config.ok) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="站点配置" />
        <p className="text-sm text-destructive">{config.failure.message}</p>
      </div>
    );
  }

  // 最后改动人的名字富化（可能是历史账号，名字会随账号删除而为空）。
  const siteConfig: SiteConfigDetail | null = config.value;
  const communityPorts = await createCommunityPorts({ userId: access.user.id });
  const updater: Map<string, { name: string }> = siteConfig?.updatedBy
    ? await communityPorts.authorSummaries([siteConfig.updatedBy])
    : new Map();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="站点配置"
        description="覆盖社区与工具的每小时配额。保存后立即生效，全部改动都有审计记录。"
      />

      <AdminBanner ok={readOkCode(params.ok)} error={readErrorCode(params.error)} />

      <Card>
        <CardHeader>
          <CardTitle>每小时配额覆盖</CardTitle>
          <CardDescription>
            {siteConfig === null
              ? '尚未设置过：三项配额都跟随部署环境的默认值。'
              : `最后改动：${updater.get(siteConfig.updatedBy ?? '')?.name ?? '已注销用户'} · ${formatAdminDate(siteConfig.updatedAt)}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={updateSiteConfigAction} className="flex flex-col gap-6">
            <QuotaField
              name="postQuotaPerHour"
              label="发帖配额（条 / 小时）"
              current={siteConfig?.postQuotaPerHour ?? null}
              description="留空 = 不覆盖（跟随默认）；0 = 关闭发帖；正整数 = 覆盖值。"
            />
            <QuotaField
              name="commentQuotaPerHour"
              label="评论配额（条 / 小时）"
              current={siteConfig?.commentQuotaPerHour ?? null}
              description="留空 = 不覆盖（跟随默认）；0 = 关闭评论；正整数 = 覆盖值。"
            />
            <QuotaField
              name="toolQuotaPerHour"
              label="工具运行配额（次 / 小时）"
              current={siteConfig?.toolQuotaPerHour ?? null}
              description="留空 = 不覆盖（跟随默认）；0 = 关闭工具运行；正整数 = 覆盖值。"
            />
            <div>
              <Button type="submit">保存配置</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
