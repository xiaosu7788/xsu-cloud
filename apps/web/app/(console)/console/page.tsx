/**
 * 控制台首页。
 *
 * 内容严格按现状写：M1 还没有任何业务模块，所以这里不给任何指向不存在页面的入口。
 * 列出排期中的模块并明写「尚未开放」，比放一个点进去 404 的链接诚实——这条约束见
 * `features/auth/routes.ts` 文件头。
 *
 * 本页**不读会话**：它没有任何需要用户信息的地方，而布局已经把登录态与用户信息处理完了。
 * 少一次读取就少一处「万一没有用户」的分支。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { CONSOLE_SETTINGS } from '@/features/auth/routes';

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
      <section className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">控制台</h1>
        <p className="text-sm text-muted-foreground">
          M1 阶段这里只有账号相关的东西。模块从 M2 起逐个接进来。
        </p>
      </section>

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
