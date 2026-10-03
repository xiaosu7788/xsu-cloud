/**
 * 我的运行历史。
 *
 * ## 数据层已经收窄，这一页不再判
 *
 * 列表查询在仓储层就带 `user_id` 条件（`packages/db/src/repositories/tools.ts` 的纵深防御），
 * 所以这一页拿到的一定是自己的记录，没有「这条该不该显示」的判定可写。归属判定只在
 * 单条详情页做一次（`runs/[id]/page.tsx`），那里才有「别人把 id 拼进地址栏」这条路径。
 *
 * ## 只显示最近一页，并在页面上写出来
 *
 * 保留期由清理任务决定（`maintenance.cleanup`），删除更早的记录；这一页再取最近
 * {@link RUN_LIST_LIMIT} 条。**显式传 limit 而不是用平台的默认值**：这句话要写在
 * caption 里，而「最多显示多少条」得是一个这一页能核对的事实，不能是别处的默认值。
 *
 * ## 宽表在移动端降级为卡片
 *
 * `ResponsiveTable` 一份列定义驱动两种形态（`docs/ARCHITECTURE.md` 7.4）。每个
 * Desktop-only 的想法都没有：五列里时间与输入大小在手机上同样是用户会看的，
 * 所以都给了 `mobileLabel`。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ResponsiveTable, type ResponsiveTableColumn } from '@/components/responsive-table';

import { AccessDenied } from '@/features/auth/access-denied';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readConsoleAccess } from '@/features/auth/session';
import {
  describeRunStatus,
  formatBytes,
  formatDuration,
  formatRunTime,
  toolDisplayName,
  type ToolRunRow,
} from '@/features/tools/format';
import { CONSOLE_TOOLS, consoleToolRunPath } from '@/features/tools/routes';

import { createToolPorts } from '@xsu/platform';

export const metadata: Metadata = {
  title: '运行历史',
};

/** 一页取多少条。上限由数据层的 `TOOL_RUN_PAGE_SIZE_MAX`（100）兜底。 */
const RUN_LIST_LIMIT = 50;

export default async function ConsoleToolRunsPage() {
  const access = await readConsoleAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  const ports = createToolPorts({ userId: access.user.id });
  const runs = await ports.listRuns({ limit: RUN_LIST_LIMIT });

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">运行历史</h1>
        <p className="text-sm text-muted-foreground">
          只有你自己能看到自己的记录；每条记录都带耗时与结果摘要。
        </p>
      </section>

      <div className="flex flex-wrap gap-3">
        <Button asChild variant="outline" size="sm">
          <Link href={CONSOLE_TOOLS}>返回工具箱</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>最近 {RUN_LIST_LIMIT} 条</CardTitle>
          <CardDescription>点工具名可以看单条记录的详情。</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveTable
            caption={`按时间倒序，最多显示最近 ${RUN_LIST_LIMIT} 条。`}
            columns={RUN_COLUMNS}
            rows={runs}
            rowKey={(row) => row.id}
            empty="还没有运行记录。"
          />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * 列定义。
 *
 * 放在组件外而不是内联：它不依赖任何请求期数据，每次渲染重建一遍数组只是让 React 多做一次
 * 无意义的比较。
 */
const RUN_COLUMNS: readonly ResponsiveTableColumn<ToolRunRow>[] = [
  {
    key: 'tool',
    header: '工具',
    /* 移动端作为卡片标题：链接本身就是入口，不需要再写一遍字段名。 */
    primary: true,
    cell: (row) => (
      <Link href={consoleToolRunPath(row.id)} className="underline underline-offset-2">
        {toolDisplayName(row.toolSlug)}
      </Link>
    ),
  },
  {
    key: 'status',
    header: '结果',
    mobileLabel: '结果',
    cell: (row) => describeRunStatus(row.status, row.errorCode),
  },
  {
    key: 'duration',
    header: '耗时',
    mobileLabel: '耗时',
    align: 'end',
    cell: (row) => formatDuration(row.durationMs),
  },
  {
    key: 'inputBytes',
    header: '输入大小',
    mobileLabel: '输入大小',
    align: 'end',
    cell: (row) => formatBytes(row.inputBytes),
  },
  {
    key: 'createdAt',
    header: '时间',
    mobileLabel: '时间',
    cell: (row) => formatRunTime(row.createdAt),
  },
];
