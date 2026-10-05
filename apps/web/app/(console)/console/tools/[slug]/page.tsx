/**
 * 工具执行页。
 *
 * ## 这一页自己再守一次
 *
 * `(console)/layout.tsx` 守的是「直接访问本分区地址」；分区内部跳转时布局段可能被路由缓存
 * 复用，服务端不再执行它。凡是要用用户信息的页面都必须自己再读一次
 * （`app/(console)/console/settings/page.tsx` 文件头有完整理由）。读的是同一个
 * `readConsoleAccess()`，一个请求内被 `React.cache()` 收口，不会多一次数据库往返。
 *
 * ## slug 不在注册表里就是 404
 *
 * 目录是编译期常量（`packages/core/src/tools/registry.ts`），所以这里能直接判定。返回
 * `notFound()` 而不是渲染一个「没有这个工具」的失败视图：后者需要自己编造文案与状态码，
 * 而全站唯一一份失败文案表是领域层的 `TOOL_FAILURE`——它在表单提交后由 Server Action 用，
 * 不是给「地址栏里手敲了一个不存在的 slug」用的。这条与 `features/tools/routes.ts` 里
 * `consoleToolPath` 的注释是同一件事。
 *
 * ## 只把可序列化的部分交给客户端组件
 *
 * `ToolDefinition.run` 是函数，跨不了 server → client 边界，所以 `RunForm` 只收
 * `{ slug, fields, sensitive }` 三样纯数据（理由见 `features/tools/run-form.tsx` 文件头）。
 */
import { findTool } from '@xsu/core';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { AccessDenied } from '@/features/auth/access-denied';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readConsoleAccess } from '@/features/auth/session';
import { CONSOLE_TOOLS, CONSOLE_TOOLS_RUNS } from '@/features/tools/routes';
import { RunForm } from '@/features/tools/run-form';

export const metadata: Metadata = {
  title: '执行工具',
};

/*
 * `params` 是 Promise，必须 await：Next 16 起动态段不再同步给出。
 */
export default async function ConsoleToolRunPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const access = await readConsoleAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  const { slug } = await params;
  const tool = findTool(slug);
  if (!tool) notFound();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={tool.name} description={tool.summary} />

      <div className="flex flex-wrap gap-3">
        <Button asChild variant="outline" size="sm">
          <Link href={CONSOLE_TOOLS}>返回工具箱</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href={CONSOLE_TOOLS_RUNS}>运行历史</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>输入</CardTitle>
          {/* 敏感提示与「表单提交后被重置」都写在 RunForm 里，这里只说这一页会发生什么。 */}
          <CardDescription>
            执行结果就在本页显示，同时在运行历史里留一条记录（摘要与耗时）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RunForm slug={tool.slug} fields={tool.fields} sensitive={tool.sensitive} />
        </CardContent>
      </Card>
    </div>
  );
}
