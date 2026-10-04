/**
 * 后台举报队列（`/admin/reports`）：M3 的第一个真正的管理页面。
 *
 * ## 页面结构
 *
 * 上半是**待处理举报队列**：每条举报列出目标、理由、举报时间，附两个审核动作
 * （确认下架 / 驳回）；下半是**审计日志**（时间倒序）——它回答「谁在什么时候处置了哪条内容」。
 *
 * ## 为什么自己守一次门禁
 *
 * 与 `app/(admin)/admin/page.tsx` 同一理由：布局守的是直接访问，分区内部跳转时布局段可能被
 * 路由缓存复用。本页要用当前登录者，所以自己读一次判定。
 *
 * ## 目标预览与富化
 *
 * 举报行只有 `targetType` + `targetId`（多态，没有外键）。帖子目标带详情页链接（管理员点过去
 * 看一眼再决定）；评论目标不逐条查库，统一显示目标 id。举报人昵称用 `authorSummaries` 一批补齐。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import type { AuthorSummary } from '@xsu/db';
import type { AuditLogListItem, ReportListItem } from '@xsu/db/schema';
import { listAuditLogs, listPendingReports } from '@xsu/core';
import { createCommunityPorts } from '@xsu/platform';

import { confirmTakedownAction, dismissReportAction } from './actions';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AccessDenied } from '@/features/auth/access-denied';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { communityPostPath } from '@/features/community/routes';
import { readAdminAccess } from '@/features/auth/session';

export const metadata: Metadata = {
  title: '举报处理',
};

/** 审计目标类型的中文展示名（M5 起审计目标扩为四类，见 `@xsu/db` 的 `AUDIT_TARGET_TYPES`）。 */
const TARGET_TYPE_LABEL: Record<AuditLogListItem['targetType'], string> = {
  post: '帖子',
  comment: '评论',
  user: '用户',
  site_config: '站点配置',
};

/** 审计动作的中文展示名（`action` 是自由字符串，未知值原样显示）。 */
const AUDIT_ACTION_LABEL: Record<string, string> = {
  'report.takedown': '确认下架',
  'report.dismiss': '驳回举报',
};

/** 日期统一截 ISO 前 10 位（与 `features/community/view.ts` 的 `formatPostDate` 同一取舍）。 */
function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** 拼出「目标」一行的文案。帖子带标题链接，评论只带 id。 */
function targetSummary(report: ReportListItem): { label: string; href: string | null } {
  // 帖子目标给详情页链接（管理员点过去看一眼再决定）；评论目标不逐条查库，只给 id。
  if (report.targetType === 'post') {
    return { label: `帖子 ${report.targetId}`, href: communityPostPath(report.targetId) };
  }
  return { label: `评论 ${report.targetId}`, href: null };
}

export default async function AdminReportsPage() {
  const access = await readAdminAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  const ports = await createCommunityPorts({ userId: access.user.id });
  const reports = await listPendingReports(ports, { actorRole: access.role });
  const auditLogs = await listAuditLogs(ports, { actorRole: access.role });

  if (!reports.ok) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">举报处理</h1>
        <p className="text-sm text-destructive">{reports.failure.message}</p>
      </div>
    );
  }

  if (!auditLogs.ok) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">举报处理</h1>
        <p className="text-sm text-destructive">{auditLogs.failure.message}</p>
      </div>
    );
  }

  const reporterIds = [...new Set(reports.items.map((item) => item.reporterId))];
  const reporters: Map<string, AuthorSummary> = await ports.authorSummaries(reporterIds);

  const actorIds = [...new Set(auditLogs.items.map((item) => item.actorId))];
  const actors: Map<string, AuthorSummary> = await ports.authorSummaries(actorIds);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">举报处理</h1>
        <p className="text-sm text-muted-foreground">
          举报不会自动下架内容；确认下架由管理员在这里完成，全部动作都有审计记录。
        </p>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>待处理举报</CardTitle>
          <CardDescription>
            {reports.items.length === 0
              ? '队列是空的。'
              : `共 ${reports.items.length} 条未处理举报。`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {reports.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">当前没有待处理的举报。</p>
          ) : (
            <ul className="flex flex-col gap-4">
              {reports.items.map((report) => {
                const reporterName = reporters.get(report.reporterId)?.name ?? '已注销用户';
                const target = targetSummary(report);
                return (
                  <li
                    key={report.id}
                    className="flex flex-col gap-2 rounded-md border border-border px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <span className="font-medium">{TARGET_TYPE_LABEL[report.targetType]}</span>
                      {target.href === null ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          {report.targetId}
                        </span>
                      ) : (
                        <Link
                          href={target.href}
                          className="font-mono text-xs text-muted-foreground underline underline-offset-2"
                        >
                          {report.targetId}
                        </Link>
                      )}
                      <span className="text-xs text-muted-foreground">
                        举报人 {reporterName} · {formatDate(report.createdAt)}
                      </span>
                    </div>
                    <p className="text-sm">{report.reason}</p>
                    <div className="flex flex-wrap gap-2">
                      <form action={confirmTakedownAction}>
                        <input type="hidden" name="reportId" value={report.id} />
                        <Button type="submit" variant="destructive" size="sm">
                          确认下架
                        </Button>
                      </form>
                      <form action={dismissReportAction}>
                        <input type="hidden" name="reportId" value={report.id} />
                        <Button type="submit" variant="outline" size="sm">
                          驳回
                        </Button>
                      </form>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>审计日志</CardTitle>
          <CardDescription>内容处置留痕：谁在什么时候下架或驳回了哪条内容。</CardDescription>
        </CardHeader>
        <CardContent>
          {auditLogs.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有任何处置记录。</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {auditLogs.items.map((log) => {
                const actorName = actors.get(log.actorId)?.name ?? '已注销用户';
                const actionLabel = AUDIT_ACTION_LABEL[log.action] ?? log.action;
                return (
                  <li key={log.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="font-medium">{actionLabel}</span>
                    <span className="text-muted-foreground">
                      {TARGET_TYPE_LABEL[log.targetType]} {log.targetId}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      操作人 {actorName} · {formatDate(log.createdAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
