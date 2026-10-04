'use client';

/**
 * 「加载更多」按钮：客户端取下一页并追加。
 *
 * ## 为什么翻页在客户端
 *
 * `/community` 是 ISR 页（30 秒窗口），如果用 `<Link href="?cursor=...">` 翻页，每页都会让
 * Next 重新走一遍 RSC 请求并把查询参数带进缓存键——公开 Feed 的翻页频率远高于改帖频率，
 * 客户端 fetch 一份与首屏同构的 JSON（`GET /api/community/posts`，响应已带富化）是最便宜的一条路。
 * 「连续翻页不重复不遗漏」由游标规则保证（`@xsu/core` 的 `listFeed`），本组件不做第二套分页。
 *
 * ## 响应形状
 *
 * `{ items: PostCardModel[], nextCursor }`，由 `app/api/community/posts/route.ts` 定义。
 * `nextCursor` 为 `null`（或响应不可解析）时按钮变成「到底了」并禁用；网络失败保留按钮可重试。
 */
import { useState } from 'react';

import { PostCard } from '@/features/community/post-card';
import { API_COMMUNITY_POSTS } from '@/features/community/routes';
import type { PostCardModel } from '@/features/community/view';

type LoadMoreResponse = {
  items?: unknown;
  nextCursor?: unknown;
};

/** 响应行不可信，逐字段核对后才进状态；形状不对的行整页丢弃，不猜。 */
function readPage(data: unknown): { items: PostCardModel[]; nextCursor: string | null } | null {
  if (typeof data !== 'object' || data === null) return null;
  const { items, nextCursor } = data as LoadMoreResponse;
  if (!Array.isArray(items)) return null;

  const posts: PostCardModel[] = [];
  for (const row of items) {
    if (typeof row !== 'object' || row === null) return null;
    const item = row as Record<string, unknown>;
    if (
      typeof item.id !== 'string' ||
      typeof item.title !== 'string' ||
      !Array.isArray(item.tags) ||
      !item.tags.every((tag) => typeof tag === 'string') ||
      typeof item.createdAt !== 'string' ||
      (item.authorName !== null && typeof item.authorName !== 'string') ||
      typeof item.likeCount !== 'number'
    ) {
      return null;
    }
    posts.push({
      id: item.id,
      title: item.title,
      tags: item.tags as string[],
      createdAt: item.createdAt,
      authorName: item.authorName,
      likeCount: item.likeCount,
    });
  }

  return {
    items: posts,
    nextCursor: typeof nextCursor === 'string' && nextCursor !== '' ? nextCursor : null,
  };
}

export function LoadMore({
  initialCursor,
  initialIds = [],
  tag,
  q,
}: {
  initialCursor: string | null;
  /** 首屏已渲染的帖子 id：追加页与首屏合并成一次批量点赞同步。 */
  initialIds?: readonly string[];
  /** 标签页 / 搜索页的过滤条件，原样透传给列表 API。 */
  tag?: string;
  q?: string;
}) {
  const [posts, setPosts] = useState<PostCardModel[]>([]);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadNext() {
    if (cursor === null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const search = new URLSearchParams({ cursor });
      if (tag) search.set('tag', tag);
      if (q) search.set('q', q);
      const response = await fetch(`${API_COMMUNITY_POSTS}?${search.toString()}`);
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError('加载失败，请重试。');
        return;
      }
      const page = readPage(data);
      if (!page) {
        setError('加载失败，请重试。');
        return;
      }
      setPosts((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      setError('网络异常，请重试。');
    } finally {
      setLoading(false);
    }
  }

  /* 追加页与首屏共用同一次批量点赞同步：id 合并后交给卡片的 in-flight 去重。 */
  const allIds = [...initialIds, ...posts.map((post) => post.id)];
  return (
    <div className="flex flex-col items-center gap-2">
      {posts.map((post) => (
        <PostCard key={post.id} post={post} syncIds={allIds} />
      ))}

      {cursor !== null ? (
        <button
          type="button"
          onClick={() => void loadNext()}
          disabled={loading}
          className="inline-flex h-11 w-full max-w-xs items-center justify-center rounded-md border border-border text-sm transition-colors hover:bg-accent disabled:opacity-60"
        >
          {loading ? '正在加载…' : (error ?? '加载更多')}
        </button>
      ) : posts.length > 0 ? (
        <p className="text-xs text-muted-foreground">到底了</p>
      ) : null}
    </div>
  );
}
