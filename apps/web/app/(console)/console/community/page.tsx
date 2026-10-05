/**
 * 控制台的「我的帖子」：发帖表单 + 我发过的帖子列表。
 *
 * ## 这一页自己再守一次
 *
 * 与 `console/tools/page.tsx` 同一条理由：分区布局守的是「直接访问分区地址」，分区内部
 * 跳转时布局段可能被路由缓存复用。凡是要用用户信息的页面都必须自己再读一次
 * `readConsoleAccess()`（一个请求内被 `React.cache()` 收口，不会多一次数据库往返）。
 *
 * ## 列表与表单同页
 *
 * 「我的帖子」没有翻页（M3 已知债务，SPEC 已注明筛选与分页留给 M5）：整列表一次取回，
 * 每行直接给编辑 / 删除入口。发帖表单挂在页首，成功后 action redirect 到新帖详情页。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { listMyPosts } from '@xsu/core';
import { createCommunityPorts } from '@xsu/platform';

import { createPostAction, deletePostAction } from './actions';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { AccessDenied } from '@/features/auth/access-denied';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readConsoleAccess } from '@/features/auth/session';
import { DeletePostButton } from '@/features/community/delete-post-button';
import { PostForm } from '@/features/community/post-form';
import { PostCard } from '@/features/community/post-card';
import { COMMUNITY_HOME, consoleCommunityEditPath } from '@/features/community/routes';
import { toPostCardModels } from '@/features/community/view';

export const metadata: Metadata = {
  title: '我的帖子',
};

export default async function ConsoleCommunityPage() {
  const access = await readConsoleAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  const ports = await createCommunityPorts({ userId: access.user.id });
  const outcome = await listMyPosts(ports, { authorId: access.user.id });
  const items = outcome.ok ? outcome.items : [];
  const authors = await ports.authorSummaries(items.map((item) => item.authorId));
  const counts = await ports.reactionCounts(items.map((item) => item.id));
  const posts = toPostCardModels(items, authors, counts);
  /* 整页 id 一起传给卡片：一页只发一次批量点赞同步（`like-button.tsx` 的 in-flight 去重）。 */
  const pageIds = posts.map((post) => post.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="我的帖子"
        description={
          <>
            发帖、编辑与删除都在这里；公开时间线在{' '}
            <Link href={COMMUNITY_HOME} className="underline underline-offset-4">
              社区首页
            </Link>
            。
          </>
        }
      />

      <PostForm action={createPostAction} mode="create" />

      <section className="flex flex-col gap-3" aria-label="我发过的帖子">
        <h2 className="text-base font-semibold">我发过的帖子</h2>
        {posts.length === 0 ? (
          <EmptyState title="还没有发过帖子" description="用上面的表单写下第一篇。" />
        ) : (
          <ul className="flex flex-col gap-4">
            {posts.map((post) => (
              <li key={post.id} className="flex flex-col gap-2">
                <PostCard post={post} syncIds={pageIds} />
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link href={consoleCommunityEditPath(post.id)}>编辑</Link>
                  </Button>
                  <DeletePostButton action={deletePostAction} postId={post.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
