/**
 * 按标签浏览（公开）。`SPEC-community.md` 第 7 节路由表里的 `/community/tags/[tag]`。
 *
 * ## 渲染策略（ISR 30 秒）
 *
 * 与首页同窗口：标签页和首页一样是公开只读内容，30 秒内新帖不出现是可接受的代价。
 * 不读会话，登录态相关的东西（点赞标记）全部客户端化。
 *
 * ## 标签参数
 *
 * `communityTagPath` 用 `encodeURIComponent` 生成链接；Next 对路径段的处理在不同版本间
 * 有「已解码 / 仍编码」两种行为，所以这里**幂等地**解码一次：解不开（ stray `%`）就按
 * 原样当标签用。空标签（归一化后只剩空白）不当作「无筛选」——那是完整时间线，不是这个
 * 页面的语义，直接给空态。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { listFeed } from '@xsu/core';
import { createCommunityPorts, type CommunityGateway } from '@xsu/platform';

import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { COMMUNITY_SEARCH } from '@/features/community/routes';
import { PostList } from '@/features/community/post-list';
import { toPostCardModels } from '@/features/community/view';

export const revalidate = 30;

/**
 * 构建期预渲染现有标签，新标签由 ISR 在第一次被访问时生成。
 *
 * 与详情页的 `generateStaticParams` 同一条理由（Next 16 不把没有本函数的动态路由写进
 * `prerender-manifest.json`）。清单来自未删除帖子的标签并集；空清单是合法状态——
 * 库为空或读取失败时页面仍能构建，具体标签在运行期按需生成。
 */
export async function generateStaticParams(): Promise<{ tag: string }[]> {
  const ports: Pick<CommunityGateway, 'listFeedTags'> = await createCommunityPorts({});
  const tags = await ports.listFeedTags();
  return tags.map((tag) => ({ tag }));
}

type TagPageProps = { params: Promise<{ tag: string }> };

function decodeTagParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function generateMetadata({ params }: TagPageProps): Promise<Metadata> {
  const { tag } = await params;
  return {
    title: `标签：${decodeTagParam(tag)}`,
    description: '按标签浏览的公开帖子。',
  };
}

export default async function CommunityTagPage({ params }: TagPageProps) {
  const { tag } = await params;
  const normalized = decodeTagParam(tag).trim().toLowerCase();

  if (normalized === '') {
    return <p className="text-sm text-muted-foreground">标签不存在。</p>;
  }

  const ports = await createCommunityPorts({});
  const outcome = await listFeed(ports, { tag: normalized });
  if (!outcome.ok) {
    // 与首页同一条取舍：读取失败给诚实的空态文案，不抛 500（`app/(site)/community/page.tsx`）。
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
      <PageHeader title={`标签：${normalized}`} description="按标签浏览的公开帖子。" />
      {posts.length === 0 ? (
        <EmptyState
          title="这个标签下还没有帖子"
          description="换个标签，或直接搜索标题与正文。"
          action={
            <Link href={COMMUNITY_SEARCH} className="text-sm underline underline-offset-4">
              搜索帖子
            </Link>
          }
        />
      ) : (
        <PostList posts={posts} nextCursor={outcome.nextCursor} tag={normalized} />
      )}
    </div>
  );
}
