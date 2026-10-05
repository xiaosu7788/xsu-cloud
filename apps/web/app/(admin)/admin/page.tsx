/**
 * 后台概览（`/admin`）：五个计数卡 + 到各子页的入口。
 *
 * 这一页自己守一次的理由与举报页相同：布局守的是直接访问，分区内部跳转时布局段可能被
 * 路由缓存复用。本页要用当前登录者，所以自己读一次判定。
 *
 * 计数来自 `getAdminOverview`（领域层只读入口，第一步就是管理员判定）：
 * 用户、帖子（可见口径）、评论、待处理举报、工具运行。不做任何耗时统计。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { getAdminOverview } from '@xsu/core';
import { createAdminGateway } from '@xsu/platform';

import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ADMIN_AUDIT,
  ADMIN_CONFIG,
  ADMIN_CONTENT,
  ADMIN_TASKS,
  ADMIN_USERS,
} from '@/features/admin/routes';
import { AccessDenied } from '@/features/auth/access-denied';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readAdminAccess } from '@/features/auth/session';
import { ADMIN_REPORTS } from '@/features/community/routes';

export const metadata: Metadata = {
  title: '后台管理',
};

/** 概览卡：计数 + 到子页的入口。 */
function OverviewCard({
  label,
  value,
  description,
  href,
  linkLabel,
}: {
  label: string;
  value: number;
  description: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{label}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex items-end justify-between gap-2">
        <p className="text-3xl font-semibold tracking-tight">{value}</p>
        <Link href={href} className="text-sm underline underline-offset-2">
          {linkLabel}
        </Link>
      </CardContent>
    </Card>
  );
}

export default async function AdminHomePage() {
  const access = await readAdminAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  const gateway = createAdminGateway();
  const overview = await getAdminOverview(gateway, { actorRole: access.role });

  if (!overview.ok) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="后台管理" />
        <p className="text-sm text-destructive">{overview.failure.message}</p>
      </div>
    );
  }

  const cards: Array<{
    label: string;
    value: number;
    description: string;
    href: string;
    linkLabel: string;
  }> = [
    {
      label: '用户',
      value: overview.value.userCount,
      description: '全部注册账号，含被封禁用户。',
      href: ADMIN_USERS,
      linkLabel: '用户管理',
    },
    {
      label: '帖子',
      value: overview.value.postCount,
      description: '公开可见口径（不含下架与已删除）。',
      href: ADMIN_CONTENT,
      linkLabel: '内容管理',
    },
    {
      label: '评论',
      value: overview.value.commentCount,
      description: '全部评论，含下架。',
      href: ADMIN_CONTENT,
      linkLabel: '内容管理',
    },
    {
      label: '待处理举报',
      value: overview.value.openReportCount,
      description: 'status = open 的举报。',
      href: ADMIN_REPORTS,
      linkLabel: '举报处理',
    },
    {
      label: '工具运行',
      value: overview.value.toolRunCount,
      description: '全部工具运行记录，含失败。',
      href: ADMIN_TASKS,
      linkLabel: '任务管理',
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="后台管理" description={`当前登录：${access.user.name}（管理员）`} />

      {/* 移动端单列，宽屏两到三列（`docs/PRD.md` 4.1：360px 无横向滚动）。 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <OverviewCard
            key={card.label}
            label={card.label}
            value={card.value}
            description={card.description}
            href={card.href}
            linkLabel={card.linkLabel}
          />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>站点配置</CardTitle>
          <CardDescription>每小时配额的覆盖入口。</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href={ADMIN_CONFIG} className="text-sm underline underline-offset-2">
            管理站点配置
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>审计日志</CardTitle>
          <CardDescription>敏感操作留痕，只追加不更新（无 UPDATE / DELETE 路径）。</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href={ADMIN_AUDIT} className="text-sm underline underline-offset-2">
            查看审计日志
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
