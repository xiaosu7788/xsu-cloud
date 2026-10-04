/**
 * 工具台：工具清单 + 收藏开关 + 进入执行页的入口。
 *
 * ## 这一页自己再守一次
 *
 * `(console)/layout.tsx` 守的是「直接访问本分区地址」；分区内部跳转时布局段可能被路由缓存
 * 复用，服务端不再执行它。凡是要用用户信息的页面都必须自己再读一次
 * （`app/(console)/console/settings/page.tsx` 文件头有完整理由）。读的是同一个
 * `readConsoleAccess()`，一个请求内被 `React.cache()` 收口，不会多一次数据库往返。
 *
 * ## 清单来自代码，收藏来自数据库
 *
 * 「有哪些工具」是 `@xsu/core` 的注册表（编译期常量），「收藏了哪些」是库里的行。两者在
 * 这一页相遇：收藏可能有已下架工具的残留（`tool_slug` 无外键），用 `isRegisteredToolSlug`
 * 过滤掉，而不是渲染一个点进去 404 的入口。
 *
 * ## 收藏用纯服务端表单
 *
 * `<form action={toggleFavoriteAction}>`，没有 `'use client'`：没有 JavaScript 也能用，
 * 收藏这种「一键一次」的操作不值得为它引入客户端状态。意图由隐藏字段携带，来自服务端渲染
 * 这一份表单时的实际状态——不在客户端「翻转一下再提交」，那样在并发点击下会与服务端事实
 * 不一致。
 */
import { isRegisteredToolSlug, listTools } from '@xsu/core';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { toggleFavoriteAction } from '@/app/(console)/console/tools/actions';
import { AccessDenied } from '@/features/auth/access-denied';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readConsoleAccess } from '@/features/auth/session';
import { FAVORITE_INTENT_FIELD, TOOL_SLUG_FIELD } from '@/features/tools/form-fields';
import { CONSOLE_TOOLS_RUNS, consoleToolPath } from '@/features/tools/routes';

import { createToolPorts } from '@xsu/platform';

export const metadata: Metadata = {
  title: '工具箱',
};

export default async function ConsoleToolsPage() {
  const access = await readConsoleAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  const ports = await createToolPorts({ userId: access.user.id });
  const favoriteSlugs = await ports.listFavoriteSlugs();
  const tools = listTools();
  const favorites = favoriteSlugs.filter(isRegisteredToolSlug);
  const favoriteTools = tools.filter((tool) => favorites.includes(tool.slug));

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">工具箱</h1>
        <p className="text-sm text-muted-foreground">
          {ports.quotaPerHour > 0
            ? `每个账号每小时最多执行 ${ports.quotaPerHour} 次，超限会返回明确的错误码。`
            : '当前已关闭工具执行（配额上限为 0）。'}
        </p>
      </section>

      {favoriteTools.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>我的收藏</CardTitle>
            <CardDescription>收藏只是入口的快捷方式，不影响工具本身。</CardDescription>
          </CardHeader>
          <CardContent>
            <ToolList tools={favoriteTools} favorites={favorites} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>全部工具</CardTitle>
          <CardDescription>
            都是纯函数工具，不碰网络也不碰磁盘。执行记录只保留摘要与耗时，详见每页的历史。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ToolList tools={tools} favorites={favorites} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>运行历史</CardTitle>
          <CardDescription>
            只有你自己能看到自己的记录；每条记录都带耗时与结果摘要。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href={CONSOLE_TOOLS_RUNS}>查看我的运行历史</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function ToolList({
  tools,
  favorites,
}: {
  tools: readonly { slug: string; name: string; summary: string; sensitive: boolean }[];
  favorites: readonly string[];
}) {
  if (tools.length === 0) {
    return <p className="text-sm text-muted-foreground">这里还没有工具。</p>;
  }

  /*
   * 移动端单列：`docs/PRD.md` 4.1 要求 360px 无横向滚动，两列在窄屏上会把「打开 + 收藏」
   * 两个按钮挤到换行。桌面两列只是利用宽屏空间，不是信息层级。
   */
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {tools.map((tool) => (
        <li
          key={tool.slug}
          className="flex flex-col gap-3 rounded-md border border-border px-3 py-3"
        >
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{tool.name}</p>
            <p className="text-xs text-muted-foreground">{tool.summary}</p>
            {tool.sensitive ? (
              <p className="text-xs text-muted-foreground">
                输入可能含口令或密钥：运行历史只记字段名与长度。
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href={consoleToolPath(tool.slug)}>打开</Link>
            </Button>
            <FavoriteToggle slug={tool.slug} isFavorite={favorites.includes(tool.slug)} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** 收藏开关。意图写在隐藏字段里，服务端按它决定是加还是删。 */
function FavoriteToggle({ slug, isFavorite }: { slug: string; isFavorite: boolean }) {
  return (
    <form action={toggleFavoriteAction}>
      <input type="hidden" name={TOOL_SLUG_FIELD} value={slug} />
      <input type="hidden" name={FAVORITE_INTENT_FIELD} value={isFavorite ? 'remove' : 'add'} />
      <Button type="submit" size="sm" variant="ghost">
        {isFavorite ? '取消收藏' : '收藏'}
      </Button>
    </form>
  );
}
