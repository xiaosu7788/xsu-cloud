/**
 * 搜索页（公开）。`SPEC-community.md` 第 7 节路由表里**唯一**读 `searchParams` 的社区公开页。
 *
 * ## 渲染策略（动态例外）
 *
 * 读了 `searchParams`，Next 把本页判为动态渲染——这是登记在
 * `apps/web/e2e/static-render.spec.ts` 的 `SITE_DYNAMIC_EXCEPTIONS` 里的**有意例外**：
 * 搜索词的组合空间无限，预渲染无意义。首页与标签页仍然守 ISR 红线。
 *
 * ## 空词
 *
 * `q` 归一化后为空（首次进入 / 只提交了空白）时只渲染搜索框，不发查询——「无筛选」是
 * 完整时间线，不是搜索页的语义。
 */
import type { Metadata } from 'next';

import { listFeed } from '@xsu/core';
import { createCommunityPorts } from '@xsu/platform';

import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { PostList } from '@/features/community/post-list';
import { toPostCardModels } from '@/features/community/view';

export const metadata: Metadata = {
  title: '搜索帖子',
  description: '按关键词搜索公开的帖子。',
};

type SearchPageProps = { searchParams: Promise<{ q?: string | string[] }> };

/** 同名参数出现多次时取第一个：与表单提交（`name="q"` 单字段）的形状一致。 */
function firstParam(raw: string | string[] | undefined): string {
  return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
}

export default async function CommunitySearchPage({ searchParams }: SearchPageProps) {
  const query = firstParam((await searchParams).q).trim();

  let posts: ReturnType<typeof toPostCardModels> = [];
  let nextCursor: string | null = null;
  if (query !== '') {
    const ports = await createCommunityPorts({});
    const outcome = await listFeed(ports, { query });
    if (!outcome.ok) {
      // 与首页同一条取舍：读取失败给诚实的空态文案，不抛 500。
      return (
        <div className="flex flex-col gap-6">
          <SearchForm initialQuery={query} />
          <p role="alert" className="text-sm text-muted-foreground">
            {outcome.failure.message}
          </p>
        </div>
      );
    }
    const authors = await ports.authorSummaries(outcome.items.map((item) => item.authorId));
    const counts = await ports.reactionCounts(outcome.items.map((item) => item.id));
    posts = toPostCardModels(outcome.items, authors, counts);
    nextCursor = outcome.nextCursor;
  }

  return (
    <div className="flex flex-col gap-6">
      <SearchForm initialQuery={query} />
      {query === '' ? null : posts.length === 0 ? (
        <EmptyState title="没有找到相关帖子。" description="试试换个关键词，或去掉过于具体的词。" />
      ) : (
        <PostList posts={posts} nextCursor={nextCursor} q={query} />
      )}
    </div>
  );
}

/**
 * GET 表单：提交就是跳转到 `/community/search?q=...`，服务端渲染结果。
 * 不用客户端状态——搜索是「输入 → 整页结果」的一次性交互，动态渲染已经覆盖它。
 */
function SearchForm({ initialQuery }: { initialQuery: string }) {
  return (
    <>
      <PageHeader title="搜索帖子" />
      <form action="/community/search" method="get" className="flex gap-2" role="search">
        <input
          type="search"
          name="q"
          defaultValue={initialQuery}
          placeholder="按标题或正文搜索…"
          aria-label="搜索关键词"
          className="h-11 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="submit"
          className="inline-flex h-11 shrink-0 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          搜索
        </button>
      </form>
    </>
  );
}
