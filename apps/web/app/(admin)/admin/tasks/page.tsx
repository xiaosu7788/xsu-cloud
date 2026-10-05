/**
 * 任务管理（`/admin/tasks`）：`tool_runs` 的只读统计。
 *
 * 只读页：不建 actions。M5 明确不做任务重试 / 取消（`SPEC-admin.md` §1 不做清单，重试在
 * M6 跟随队列管理落地），这里只把已有数据读出来：顶部三个状态计数 + 按工具维度的失败率
 * 聚合，底部是最近一批运行的明细（带用户邮箱，页面直接展示，无需富化）。
 */
import type { Metadata } from 'next';

import type { AdminToolRunRow } from '@xsu/core';
import { getAdminTaskBoard } from '@xsu/core';
import { createAdminGateway } from '@xsu/platform';

import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ResponsiveTable, type ResponsiveTableColumn } from '@/components/responsive-table';
import { AccessDenied } from '@/features/auth/access-denied';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readAdminAccess } from '@/features/auth/session';
import { AdminPager, adminStatusBadge, formatAdminDate } from '@/features/admin/view';

export const metadata: Metadata = {
  title: '任务管理',
};

/** 最近运行页数固定为 20（M5 无翻页诉求，超过这个量级再看 M6 的队列管理）。 */
const RECENT_RUNS_LIMIT = 20;

/** 失败率的小数转百分比文案。无运行显示「—」。 */
function failureRate(runs: number, failed: number): string {
  return runs === 0 ? '—' : `${Math.round((failed / runs) * 100)}%`;
}

/** 运行状态的中文徽章：succeeded 正常、failed 危险、其余（排队 / 运行中）弱化。 */
function runStatusCell(status: string) {
  if (status === 'succeeded') {
    return <span className={adminStatusBadge('ok')}>成功</span>;
  }
  if (status === 'failed') {
    return <span className={adminStatusBadge('danger')}>失败</span>;
  }
  return <span className={adminStatusBadge('muted')}>{status}</span>;
}

const recentColumns: ResponsiveTableColumn<AdminToolRunRow>[] = [
  {
    key: 'run',
    header: '运行',
    primary: true,
    cell: (row) => (
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-xs">{row.toolSlug}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{row.id}</span>
      </div>
    ),
  },
  {
    key: 'status',
    header: '状态',
    mobileLabel: '状态',
    cell: (row) => runStatusCell(row.status),
  },
  {
    key: 'user',
    header: '用户',
    mobileLabel: '用户',
    cell: (row) => <span className="truncate">{row.userEmail ?? '—'}</span>,
  },
  {
    key: 'error',
    header: '错误码',
    mobileLabel: '错误码',
    cell: (row) =>
      row.errorCode === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className="font-mono text-xs">{row.errorCode}</span>
      ),
  },
  {
    key: 'duration',
    header: '耗时',
    mobileLabel: '耗时',
    cell: (row) =>
      row.durationMs === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className="text-muted-foreground">{row.durationMs} ms</span>
      ),
  },
  {
    key: 'createdAt',
    header: '时间',
    mobileLabel: '时间',
    cell: (row) => <span className="text-muted-foreground">{formatAdminDate(row.createdAt)}</span>,
  },
];

const byToolColumns: ResponsiveTableColumn<{ toolSlug: string; runs: number; failed: number }>[] = [
  {
    key: 'tool',
    header: '工具',
    primary: true,
    cell: (row) => <span className="truncate font-mono text-xs">{row.toolSlug}</span>,
  },
  {
    key: 'runs',
    header: '运行次数',
    mobileLabel: '运行次数',
    cell: (row) => <span>{row.runs}</span>,
  },
  {
    key: 'failed',
    header: '失败次数',
    mobileLabel: '失败次数',
    cell: (row) => <span>{row.failed}</span>,
  },
  {
    key: 'rate',
    header: '失败率',
    mobileLabel: '失败率',
    cell: (row) => (
      <span className="text-muted-foreground">{failureRate(row.runs, row.failed)}</span>
    ),
  },
];

export default async function AdminTasksPage() {
  const access = await readAdminAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  const gateway = createAdminGateway();
  const board = await getAdminTaskBoard(gateway, {
    actorRole: access.role,
    runsLimit: RECENT_RUNS_LIMIT,
  });

  if (!board.ok) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="任务管理" />
        <p className="text-sm text-destructive">{board.failure.message}</p>
      </div>
    );
  }

  const { stats, recent } = board.value;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="任务管理"
        description="工具运行的只读统计。M5 不提供重试与取消，队列操作随 M6 落地。"
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">{stats.total}</CardTitle>
            <CardDescription>总运行次数</CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">{stats.succeeded}</CardTitle>
            <CardDescription>成功</CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">{stats.failed}</CardTitle>
            <CardDescription>失败</CardDescription>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>按工具聚合</CardTitle>
          <CardDescription>哪些工具失败得最多，一眼可见。</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveTable
            columns={byToolColumns}
            rows={stats.byTool}
            rowKey={(row) => row.toolSlug}
            empty="还没有任何工具运行记录。"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>最近运行</CardTitle>
          <CardDescription>最新 {recent.length} 条运行明细。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ResponsiveTable
            columns={recentColumns}
            rows={recent}
            rowKey={(row) => row.id}
            empty="还没有任何工具运行记录。"
          />
          {recent.length > 0 ? (
            <AdminPager
              base="/admin/tasks"
              page={1}
              total={recent.length}
              limit={RECENT_RUNS_LIMIT + 1}
            />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
