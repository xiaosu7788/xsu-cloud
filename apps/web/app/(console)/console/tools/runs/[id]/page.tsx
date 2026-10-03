/**
 * 单条运行记录。
 *
 * ## 「不存在」与「不是你的」拿到同一个视图
 *
 * 仓储的 `getToolRunById` 已经按 `id + user_id` 一起查（`packages/db/src/repositories/tools.ts`），
 * 不属于当前用户时返回 `null`——它连一行他人数据都不取回来。这一页再把「查不到」与
 * 「领域层判定不放行」翻译成**同一个**拒绝视图：两者如果长得不一样，别人就能用状态码或文案
 * 差异去判断某个 id 到底存不存在，那是一个存在性探针。`docs/spec/SPEC-tools.md` 第 4.1 节
 * 把这条写成「统一拒绝视图」，这里是它的唯一落点。
 *
 * ## 为什么归属判定要做两遍
 *
 * 数据层的 `user_id` 收窄与领域层的 `decideToolRunAccess` 是有意的重复（纵深防御）：前者保证
 * 不多取数据，后者保证「拒绝」这件事有一个统一出处，将来有人绕过仓储直连领域层也不会漏。
 * 管理员在这一页同样不放行——`docs/PRD.md` 3.3 验收 4 是「用户只能看到自己的运行历史」，
 * 后台查看属于 M5 且必须带审计日志。
 *
 * ## 为什么没有复用 `AccessDenied`
 *
 * `features/auth/access-denied.tsx` 的入参类型是 `ACCESS_DENIED` 两个成员的字面量联合，
 * 复用就得把它放宽成结构类型，那样「文案只能来自拒绝表」这条编译期保证会消失。真正需要共享
 * 的是**文案与错误码的来源**（这一页用的仍是 `TOOL_FAILURE`，没有第二份文案），不是这段排版；
 * 而且这里的有效去向是「运行历史 / 工具箱」，与分区拒绝的「首页 / 控制台」完全不同。
 *
 * ## 敏感工具不显示输出
 *
 * `sensitive` 的工具在 `buildRunSummary` 里就不存任何原文，`outputSummary` 是 `null`。这一页
 * 不把它渲染成空白，而是明写「不记录内容」——空着一行会让人以为记录丢了。
 */
import { decideToolRunAccess, findTool, TOOL_FAILURE, type ToolFailure } from '@xsu/core';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { AccessDenied } from '@/features/auth/access-denied';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readConsoleAccess } from '@/features/auth/session';
import {
  describeRunStatus,
  formatBytes,
  formatDuration,
  formatRunTime,
  toolDisplayName,
} from '@/features/tools/format';
import { CONSOLE_TOOLS, CONSOLE_TOOLS_RUNS, consoleToolPath } from '@/features/tools/routes';

import { createToolPorts } from '@xsu/platform';

export const metadata: Metadata = {
  title: '运行记录',
};

export default async function ConsoleToolRunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await readConsoleAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  const { id } = await params;
  /* 端口按当前用户建，`user_id` 在构造时就绑定了（见 `@xsu/platform` 的 `createToolPorts`）。 */
  const ports = createToolPorts({ userId: access.user.id });
  const run = await ports.getRun(id);

  if (!run) return <RunDenied denial={TOOL_FAILURE.runForbidden} />;

  const decision = decideToolRunAccess({ viewerId: access.user.id, ownerId: run.userId });
  if (!decision.allowed) return <RunDenied denial={decision.failure} />;

  /*
   * 目录是编译期常量，而 `tool_slug` 没有外键：一个已下架工具的旧记录仍然能打开，只是不再有
   * 执行入口、也问不到 `sensitive`。两种情况都在下面按 `tool` 是否存在分叉。
   */
  const tool = findTool(run.toolSlug);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">
          {toolDisplayName(run.toolSlug)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {describeRunStatus(run.status, run.errorCode)} · {formatRunTime(run.createdAt)}
        </p>
      </section>

      <div className="flex flex-wrap gap-3">
        <Button asChild variant="outline" size="sm">
          <Link href={CONSOLE_TOOLS_RUNS}>返回运行历史</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href={CONSOLE_TOOLS}>工具箱</Link>
        </Button>
        {/* 工具还在注册表里才给「再跑一次」；下架的旧记录只读。 */}
        {tool ? (
          <Button asChild size="sm">
            <Link href={consoleToolPath(tool.slug)}>再执行一次</Link>
          </Button>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>概况</CardTitle>
          {/*
           * ID 明写在这里而不是藏进 URL：用户反馈「这一条有问题」时，这句话能直接对上日志。
           * 失败时 raw code 也一样——中文文案会随码表改，码本身是稳定的。
           */}
          <CardDescription>记录 ID 与耗时都来自执行当时落库的那一份事实。</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="flex flex-col gap-2 text-sm">
            <Fact label="状态">
              {describeRunStatus(run.status, run.errorCode)}
              {run.errorCode ? (
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  {run.errorCode}
                </span>
              ) : null}
            </Fact>
            <Fact label="耗时">{formatDuration(run.durationMs)}</Fact>
            <Fact label="输入大小">{formatBytes(run.inputBytes)}</Fact>
            <Fact label="输出大小">
              {run.outputBytes === null ? '没有输出' : formatBytes(run.outputBytes)}
            </Fact>
            <Fact label="时间">{formatRunTime(run.createdAt)}</Fact>
            <Fact label="记录 ID">
              <span className="font-mono text-xs break-all">{run.id}</span>
            </Fact>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>输入摘要</CardTitle>
          <CardDescription>截断后的预览，不是原始输入；运行历史不存全文。</CardDescription>
        </CardHeader>
        <CardContent>
          {run.inputSummary === null ? (
            <p className="text-sm text-muted-foreground">这次执行没有留下输入摘要。</p>
          ) : (
            <Summary text={run.inputSummary} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>输出摘要</CardTitle>
          <CardDescription>同上，只是输出侧。</CardDescription>
        </CardHeader>
        <CardContent>
          {run.outputSummary === null ? (
            <p className="text-sm text-muted-foreground">
              {tool?.sensitive === true
                ? '这个工具的输入可能含口令或密钥，按设计不记录输出内容，只保留输出大小。'
                : '这次执行没有输出内容。'}
            </p>
          ) : (
            <Summary text={run.outputSummary} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** 「字段名 + 值」的一行。移动端是纵向堆叠，宽度不够时靠 `flex-wrap` 让值换到下一行。 */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/**
 * 摘要的展示。
 *
 * `whitespace-pre-wrap` 保留库里存下来的换行（输出预览常常带换行），`break-all` 让
 * 一长串 base64 或哈希在 360px 视口里换行而不是顶破布局（`docs/PRD.md` 4.1）。
 */
function Summary({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-border bg-muted p-3 text-xs whitespace-pre-wrap break-all">
      {text}
    </p>
  );
}

/**
 * 运行记录的拒绝视图。
 *
 * 文案、状态码、错误码全部来自领域层的 `TOOL_FAILURE`——这里只排版，不造文案。回退入口指向
 * 运行历史：被拒的这一刻连「这条记录是谁的」都不该透露，因此既不放「再执行一次」，也不放
 * 任何带那个 id 的链接。
 */
function RunDenied({ denial }: { denial: ToolFailure }) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>无法查看</CardTitle>
          <CardDescription>{denial.message}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* 给用户看的是上面那句中文，这一项是给排查用的对账信息。 */}
          <p className="font-mono text-xs text-muted-foreground">
            {denial.status} {denial.code}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href={CONSOLE_TOOLS_RUNS}>返回运行历史</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={CONSOLE_TOOLS}>工具箱</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
