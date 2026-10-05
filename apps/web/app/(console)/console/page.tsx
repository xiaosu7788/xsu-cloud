/**
 * 控制台首页。
 *
 * 内容严格按现状写：这里只指向**真的存在**的页面。M1 落地了账号，M2 落地了工具箱；其余模块
 * 列在下面并明写「尚未开放」——比放一个点进去 404 的链接诚实，这条约束见
 * `features/auth/routes.ts` 文件头。
 *
 * 本页**不读会话**：它没有任何需要用户信息的地方，而布局已经把登录态与用户信息处理完了。
 * 少一次读取就少一处「万一没有用户」的分支。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { CONSOLE_SETTINGS } from '@/features/auth/routes';
import { CONSOLE_TOOLS, CONSOLE_TOOLS_RUNS, TOOLS_HOME } from '@/features/tools/routes';

export const metadata: Metadata = {
  title: '控制台',
};

/** 排期中的模块。写在这里是为了让「还没有」成为一个明确的事实，而不是一个坏掉的链接。 */
const PENDING_SECTIONS = [
  { name: '中转站入口', scope: '用量、额度与密钥', milestone: 'M4' },
  { name: '我的任务', scope: '提交记录与运行状态', milestone: 'M6' },
];

export default function ConsoleHomePage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="控制台"
        description="账号与工具箱在这里。其余模块从 M4 起逐个接进来，还没落地的都列在最下面。"
      />

      <Card>
        <CardHeader>
          <CardTitle>工具箱</CardTitle>
          <CardDescription>
            一批不依赖外部服务的在线小工具。公开清单在 {TOOLS_HOME}，执行需要登录——每次执行都
            在运行历史里留一条记录，只有本人能看到。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button asChild>
            <Link href={CONSOLE_TOOLS}>进入工具箱</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={CONSOLE_TOOLS_RUNS}>运行历史</Link>
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>账号</CardTitle>
          <CardDescription>
            资料、主题与退出登录都在账号设置页。手机上没有侧边栏，底部导航里的「账号设置」就是
            退出登录的入口。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href={CONSOLE_SETTINGS}>前往账号设置</Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>尚未开放的模块</CardTitle>
          <CardDescription>导航里不会出现这些入口，直到它们真的有页面。</CardDescription>
        </CardHeader>
        <CardContent>
          {/* 移动端单列，不靠横向滚动容纳两列（`docs/PRD.md` 4.1：360px 无横向滚动）。 */}
          <ul className="grid gap-3 sm:grid-cols-2">
            {PENDING_SECTIONS.map((section) => (
              <li key={section.name} className="rounded-md border border-border px-3 py-2">
                <p className="text-sm font-medium">{section.name}</p>
                <p className="text-xs text-muted-foreground">
                  {section.scope} · 计划 {section.milestone}
                </p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
