/**
 * 帖子详情页（公开）。`SPEC-community.md` 第 7 节路由表里唯一带正文渲染的公开页。
 *
 * ## 渲染策略（ISR 15 秒）
 *
 * 与列表页（30 秒）的差异是内容的新鲜度要求不同：新评论、新点赞计数 15 秒内可见。
 * 本页不读会话：点赞状态挂载后由 `LikeButton` 自己同步；登录态由 `CommentForm` 提交时
 * 服务端 action 判定。公开页一律不读会话，否则 ISR 全部失效。
 *
 * ## 404 与拒绝视图
 *
 * id 确实不存在 → `notFound()`（404）；存在但已删除 / 已下架 → 统一拒绝视图（不透出
 * 软删除原因，见 `SPEC-community.md` 4.1）。判定由 `readPost` 给出（它不过滤 `deletedAt`）。
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { listPostComments, readPost } from '@xsu/core';
import { createCommunityPorts, type CommunityGateway } from '@xsu/platform';

import { PageHeader } from '@/components/page-header';
import { CommentForm } from '@/features/community/comment-form';
import { LikeButton } from '@/features/community/like-button';
import { ReportButton } from '@/features/community/report-button';
import { COMMUNITY_HOME } from '@/features/community/routes';
import { formatPostDate } from '@/features/community/view';
import { createCommentAction } from './actions';

export const revalidate = 15;

/**
 * 构建期预渲染已存在的帖子，其余 id 由 ISR 在第一次被访问时生成。
 *
 * **为什么必须有这个函数**：Next 16 不会把没有 `generateStaticParams` 的动态路由写进
 * `prerender-manifest.json`（M3 e2e 实测 `dynamicRoutes` 为空对象），静态化的对账断言
 * （`e2e/static-render.spec.ts`）因此落空。清单不追求完整——它只是「构建那天已存在的帖子」，
 * 之后发布的新帖由 ISR 按需生成，两条路径在运行期行为一致。
 *
 * 读取失败时返回空清单而不是抛错：预渲染问题不能阻塞构建，运行期照常回源数据库。
 */
export async function generateStaticParams(): Promise<{ id: string }[]> {
  const ports: Pick<CommunityGateway, 'listRecentPostIds'> = await createCommunityPorts({});
  const ids = await ports.listRecentPostIds();
  return ids.map((id) => ({ id }));
}

export default async function CommunityPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ports = await createCommunityPorts({});

  const outcome = await readPost(ports, { postId: id });
  if (!outcome.ok) {
    notFound();
  }
  const post = outcome.post;

  if (post.deletedAt !== null) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="内容不可见"
          description="这篇帖子已被删除或下架，或不存在。"
          actions={
            <Link href={COMMUNITY_HOME} className="text-sm underline underline-offset-4">
              返回社区首页
            </Link>
          }
        />
      </div>
    );
  }

  const likeCounts = await ports.reactionCounts([post.id]);
  // 详情页拒绝视图不渲染评论：这里的调用前提「帖子可见」由上面的分支保证（`listPostComments` 注释）。
  const comments = await listPostComments(ports, { postId: post.id });
  const commentItems = comments.ok ? comments.items : [];
  const authorIds = [...new Set([post.authorId, ...commentItems.map((item) => item.authorId)])];
  const authorSummaries = await ports.authorSummaries(authorIds);

  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{post.title}</h1>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{authorSummaries.get(post.authorId)?.name ?? '作者已注销'}</span>
          <span aria-hidden>·</span>
          <time dateTime={post.createdAt.toISOString()}>
            {formatPostDate(post.createdAt.toISOString())}
          </time>
        </p>
      </header>

      <div className="flex flex-col gap-3 whitespace-pre-wrap text-sm">{post.body}</div>

      <div className="flex items-center gap-3">
        <LikeButton postId={post.id} initialCount={likeCounts.get(post.id) ?? 0} />
        <ReportButton targetType="post" targetId={post.id} />
      </div>

      <section className="flex flex-col gap-3" aria-label="评论">
        <h2 className="text-base font-semibold">评论</h2>
        {commentItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有评论。</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {commentItems.map((comment) => (
              <li
                key={comment.id}
                className="flex flex-col gap-1 rounded-md border border-border px-4 py-3"
              >
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span>{authorSummaries.get(comment.authorId)?.name ?? '作者已注销'}</span>
                  <span aria-hidden>·</span>
                  <time dateTime={comment.createdAt.toISOString()}>
                    {formatPostDate(comment.createdAt.toISOString())}
                  </time>
                </p>
                <p className="whitespace-pre-wrap text-sm">{comment.body}</p>
              </li>
            ))}
          </ul>
        )}

        <CommentForm action={createCommentAction.bind(null, post.id)} />
      </section>
    </article>
  );
}
