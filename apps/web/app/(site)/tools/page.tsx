/**
 * 公开的工具清单页（`docs/spec/SPEC-tools.md` 第 6 节：静态、不含执行）。
 *
 * ## 为什么它必须是静态的
 *
 * 它是公开页，按 `docs/ARCHITECTURE.md` 7.1 红线 1 默认要静态预渲染，所以这里
 * **不读会话、不读 headers、不读 searchParams**。判断依据不是「代码里没出现 cookies」，
 * 而是 `next build` 的输出里这一页标着 `○`，并且被 `apps/web/e2e/static-render.spec.ts`
 * 逐页对账（该文件自动枚举 `(site)` 下的所有页面，本页加进来就自动纳入）。
 *
 * ## 为什么只列清单，不放执行入口
 *
 * 执行要登录——运行历史与收藏都归属到人。公开页放一个「点进去被弹到登录页」的按钮，
 * 得到的是「这里坏了」的印象；给一个登录入口、把执行在哪说清楚就够了。
 *
 * ## 清单内容全部来自注册表
 *
 * `listTools()` 是「有哪些工具」的唯一来源（`packages/core/src/tools/registry.ts`），
 * 本页不抄一份清单：抄件会在加工具时静默漏掉，而这里漏掉的表现是「工具能用但没人知道」。
 * 顺序也用它给的顺序——展示顺序是产品的决定，分散到各页面排序就会出现两种顺序。
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { listTools } from '@xsu/core';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { CONSOLE_HOME, SIGN_IN_PATH } from '@/features/auth/routes';

export const metadata: Metadata = {
  title: '工具箱',
  description: '小工具的清单与说明。执行需要登录，运行历史与收藏都在控制台里。',
};

export default function ToolsHomePage() {
  const tools = listTools();

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">工具箱</h1>
        <p className="max-w-2xl text-sm text-muted-foreground md:text-base">
          一批不依赖外部服务的在线小工具。清单在这里公开可读，执行需要登录——每次执行都会在运行历史里
          留一条记录，记录归属到账号，只有本人能看到。
        </p>
      </section>

      <section className="flex flex-wrap gap-3">
        <Button asChild>
          <Link href={SIGN_IN_PATH}>登录后使用</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={CONSOLE_HOME}>我的控制台</Link>
        </Button>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>工具清单</CardTitle>
          <CardDescription>
            共 {tools.length} 个工具。登录之后在控制台的「工具箱」里进入执行页面。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* 移动端单列、宽屏两列，不靠横向滚动展示：`docs/PRD.md` 4.1 要求 360px 无横向滚动。 */}
          <ul className="grid gap-3 sm:grid-cols-2">
            {tools.map((tool) => (
              <li
                key={tool.slug}
                className="flex flex-col gap-1 rounded-md border border-border px-3 py-2"
              >
                <p className="text-sm font-medium">{tool.name}</p>
                <p className="text-xs text-muted-foreground">{tool.summary}</p>
                <p className="text-xs text-muted-foreground">
                  输入：{tool.fields.map((field) => field.label).join('、')}
                  {tool.sensitive ? ' · 输入可能含口令或密钥，运行历史不记录内容' : ''}
                </p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>登录之后有什么</CardTitle>
          <CardDescription>
            控制台里的工具箱提供清单、收藏与运行历史三件事，入口在控制台导航里。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
            <li>· 收藏：把常用的工具放进「我的收藏」，排在最上面。</li>
            <li>· 运行历史：每次执行都记一行摘要与耗时，只有本人能看到。</li>
            <li>· 配额：单位时间内的执行次数有上限，超限会返回一个明确的错误码而不是静默失败。</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
