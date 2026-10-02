/**
 * 公开首页。
 *
 * 服务端组件，不含任何请求期 API（`cookies` / `headers` / `searchParams`），因此
 * `next build` 会把它预渲染成静态 HTML——这是 `docs/ROADMAP.md` M1 退出标准 1 的直接
 * 证据。**不要**为了「顺便显示一下登录后的欢迎语」在这里读会话，那会把首页变成动态渲染，
 * 是 `docs/ARCHITECTURE.md` 7.1 红线 1 明确禁止的；登录态已经在顶栏由
 * `SessionBadge` 以客户端方式表达。
 *
 * 内容刻意只描述**现状**：M1 阶段能到的地方只有登录页与控制台骨架，还没有任何业务模块。
 * 写一段「支持生图、社区、工具箱」的营销文案是实现给文档让步——用户点进去只有空壳。
 * 每个模块落地时再把入口加进来（见 `SITE_NAV_ITEMS` 的注释）。
 */
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { CONSOLE_HOME, SIGN_IN_PATH } from '@/features/auth/routes';

/** 尚未落地的模块。列在这里是为了让「有链接但点不开」变成「明确写着还没做」。 */
const PENDING_MODULES = [
  { name: '中转站', scope: '入口与控制台' },
  { name: '社区', scope: '发帖与讨论' },
  { name: '工具箱', scope: '工具清单与运行历史' },
  { name: '生图工作台', scope: '任务提交与结果画廊' },
];

export default function SiteHomePage() {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">xsu-cloud</h1>
        <p className="max-w-2xl text-sm text-muted-foreground md:text-base">
          个人云站。M1 阶段先把骨架搭起来：账号体系、双主题、响应式原语与三个路由分区。 业务模块从
          M2 开始逐个填进来。
        </p>
      </section>

      <section className="flex flex-wrap gap-3">
        <Button asChild>
          <Link href={SIGN_IN_PATH}>登录</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={CONSOLE_HOME}>我的控制台</Link>
        </Button>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>尚未开放的模块</CardTitle>
          <CardDescription>
            下面这些是已排期的模块，代码还没有。导航里不会出现它们的入口。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* 移动端单列、宽屏两列，不靠横向滚动展示：`docs/PRD.md` 4.1 要求 360px 无横向滚动。 */}
          <ul className="grid gap-3 sm:grid-cols-2">
            {PENDING_MODULES.map((module) => (
              <li key={module.name} className="rounded-md border border-border px-3 py-2">
                <p className="text-sm font-medium">{module.name}</p>
                <p className="text-xs text-muted-foreground">{module.scope}</p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
