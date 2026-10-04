/**
 * 审计日志（`/admin/audit`）：全站敏感操作的只读时间线。
 *
 * 只读页：不建 actions。数据是 `listAuditLogsForAdmin`（时间倒序，含 M3 的社区审计行），
 * 分页用偏移制（与用户页同款 `?page=`）。动作与目标类型用 `features/admin/audit-labels`
 * 的中文映射（与举报页共用）；`detail` 是 JSON 串（目前只有 `site.config.update` 会写），
 * 原样等宽展示，未知动作回退为原始 action 字符串。操作人名字用 `authorSummaries` 批量富化。
 */
import type { Metadata } from 'next';

import type { AuditLogListItem } from '@xsu/db/schema';
import { ADMIN_PAGE_SIZE_DEFAULT, listAuditLogsForAdmin } from '@xsu/core';
import type { AuthorSummary } from '@xsu/db';
import { createAdminGateway, createCommunityPorts } from '@xsu/platform';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ResponsiveTable, type ResponsiveTableColumn } from '@/components/responsive-table';
import { AccessDenied } from '@/features/auth/access-denied';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readAdminAccess } from '@/features/auth/session';
import { ADMIN_AUDIT } from '@/features/admin/routes';
import { AUDIT_ACTION_LABEL, AUDIT_TARGET_TYPE_LABEL } from '@/features/admin/audit-labels';
import { AdminPager, formatAdminDate, adminExcerpt } from '@/features/admin/view';

export const metadata: Metadata = {
  title: '审计日志',
};

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const access = await readAdminAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  const params = await searchParams;
  const parsedPage = Number(params.page ?? '');
  const page =
    Number.isFinite(parsedPage) && Math.trunc(parsedPage) >= 1 ? Math.trunc(parsedPage) : 1;

  const gateway = createAdminGateway();
  const logs = await listAuditLogsForAdmin(gateway, { actorRole: access.role, page });

  if (!logs.ok) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">审计日志</h1>
        <p className="text-sm text-destructive">{logs.failure.message}</p>
      </div>
    );
  }

  // 操作人富化：审计行不存名字（账号可删），一批查回，缺失显示「已注销用户」。
  const communityPorts = await createCommunityPorts({ userId: access.user.id });
  const actorIds = [...new Set(logs.value.items.map((log) => log.actorId))];
  const actors: Map<string, AuthorSummary> = await communityPorts.authorSummaries(actorIds);
  const actorName = (actorId: string) => actors.get(actorId)?.name ?? '已注销用户';

  const columns: ResponsiveTableColumn<AuditLogListItem>[] = [
    {
      key: 'action',
      header: '动作',
      primary: true,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">
            {AUDIT_ACTION_LABEL[row.action] ?? row.action}
          </span>
          <span className="truncate font-mono text-xs text-muted-foreground">{row.action}</span>
        </div>
      ),
    },
    {
      key: 'target',
      header: '目标',
      mobileLabel: '目标',
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate">
            {AUDIT_TARGET_TYPE_LABEL[row.targetType] ?? row.targetType}
          </span>
          <span className="truncate font-mono text-xs text-muted-foreground">{row.targetId}</span>
        </div>
      ),
    },
    {
      key: 'detail',
      header: '详情',
      mobileLabel: '详情',
      cell: (row) =>
        row.detail === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="font-mono text-xs break-all">{adminExcerpt(row.detail, 80)}</span>
        ),
    },
    {
      key: 'actor',
      header: '操作人',
      mobileLabel: '操作人',
      cell: (row) => <span className="truncate">{actorName(row.actorId)}</span>,
    },
    {
      key: 'createdAt',
      header: '时间',
      mobileLabel: '时间',
      cell: (row) => (
        <span className="text-muted-foreground">{formatAdminDate(row.createdAt)}</span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">审计日志</h1>
        <p className="text-sm text-muted-foreground">
          全站敏感操作的只读时间线：审计行与业务写在同一事务里落库，没有 UPDATE / DELETE 路径。
        </p>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>全部记录</CardTitle>
          <CardDescription>共 {logs.value.total} 条，按时间倒序。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ResponsiveTable
            columns={columns}
            rows={logs.value.items}
            rowKey={(row) => row.id}
            empty="还没有任何审计记录。"
          />
          <AdminPager
            base={ADMIN_AUDIT}
            page={page}
            total={logs.value.total}
            limit={ADMIN_PAGE_SIZE_DEFAULT}
          />
        </CardContent>
      </Card>
    </div>
  );
}
