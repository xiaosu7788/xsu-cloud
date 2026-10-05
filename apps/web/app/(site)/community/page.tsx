/**
 * 公开社区首页：按时间倒序的帖子列表。
 *
 * ## 渲染策略（SPEC §7 的路由表）
 *
 * ISR（30 秒）：社区是公开只读内容，30 秒的过期窗口是「新帖最迟 30 秒后出现在列表里」的
 * 代价，换来的是每次请求都不打数据库——与 PRD 红线 1「公开内容页不得默认动态渲染」一致。
 * 布局不读会话，本页也不读：登录态相关的东西（点赞按钮的「我有没有点过」）全部客户端化，
 * 挂载后经批量接口同步（`features/community/like-button.tsx` 文件头）。
 *
 * ## 首屏渲染、追加翻页走 API
 *
 * 服务端渲染第一页（`listFeed`）；「加载更多」在浏览器里经 `GET /api/community/posts`
 * 取下一页并追加。两条路共用同一套归一化与游标（`@xsu/core` 的 `listFeed`），
 * 「连续翻页不重复不遗漏」由游标规则保证，本页不做第二套分页。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { listFeed } from '@xsu/core';
import { createCommunityPorts } from '@xsu/platform';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { COMMUNITY_SEARCH, CONSOLE_COMMUNITY } from '@/features/community/routes';
import { toPostCardModels } from '@/features/community/view';
import { PostList } from '@/features/community/post-list';

// ISR 窗口（秒）。「重新生成」由 Next 在后台完成，请求命中的始终是上一次的成品。
export const revalidate = 30;

export const metadata: Metadata = {
  title: '社区',
  description: '公开的帖子时间线，支持按标签浏览与搜索。',
};

export default async function CommunityHomePage() {
  const ports = await createCommunityPorts({});
  const outcome = await listFeed(ports, {});
  if (!outcome.ok) {
    /*
     * 列表读取失败时给一个诚实的空态文案，而不是抛 500：游标解码失败在首屏不可能发生
     * （没有入参），唯一可能的是数据库暂时不可用——那是部署问题，文案与重试入口都交给布局。
     */
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        {outcome.failure.message}
      </p>
    );
  }

  const authors = await ports.authorSummaries(outcome.items.map((item) => item.authorId));
  const counts = await ports.reactionCounts(outcome.items.map((item) => item.id));
  const posts = toPostCardModels(outcome.items, authors, counts);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="社区"
        description={
          <>
            公开的帖子时间线。
            <Link href={COMMUNITY_SEARCH} className="underline underline-offset-4">
              搜索帖子
            </Link>
            {/* 发帖入口在控制台：公开页不读会话，写操作一律登录后进行。 */} 想发帖？
            <Link href={CONSOLE_COMMUNITY} className="underline underline-offset-4">
              去控制台
            </Link>
          </>
        }
      />
      {posts.length === 0 ? (
        <EmptyState
          title="还没有帖子"
          description="这个站点的公开讨论从第一篇开始。"
          action={
            <Link href={CONSOLE_COMMUNITY} className="text-sm underline underline-offset-4">
              去控制台发帖
            </Link>
          }
        />
      ) : (
        <PostList posts={posts} nextCursor={outcome.nextCursor} />
      )}
    </div>
  );
}
