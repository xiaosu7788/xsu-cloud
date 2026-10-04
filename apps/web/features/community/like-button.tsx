'use client';

/**
 * 点赞按钮：读初始计数 → 挂载后同步计数与「我有没有点过」→ 点击时调点赞接口。
 *
 * ## 状态从哪来
 *
 * - `initialCount` 是服务端渲染进 HTML 的首帧值（ISR 缓存里的计数可能旧 30 秒）；挂载后
 *   计数与「我有没有点过」一起经批量接口（`/api/community/posts/likes`）修正为库中真值；
 * - 「我有没有点过」服务端不知道（不读会话），同步未登录得到空标记，
 *   按钮照常显示但点击时得到 401 文案；
 * - 点击走乐观更新：先改界面，请求失败（含 401、404）再回滚并显示接口给的一句话。
 *   点赞是最轻的写操作，为它转一圈 loading 不值得；真正落库的事实由接口保证。
 *
 * ## 批量同步的去重
 *
 * 一页列表里的每张卡片拿到的是**同一个** `allPostIds` 集合，各自发起请求就是 20 个相同的
 * GET。`syncLikes` 按 ids 串做模块级 in-flight 去重：先到的组件发请求，其余组件 await 同一个
 * Promise 并各自读取自己的条目——响应体仍被解析多次，但网络上一页只有一次请求。Promise 落定
 * 后即从表里删除，晚挂载的组件（「加载更多」追加的卡片）发的是自己的新请求。
 *
 * ## 独立单文件
 *
 * `PostCard` 与详情页都用它。放进 post-card 会让详情页 import 整张卡片；放进详情页会让
 * 卡片 import 整个详情页的依赖树。
 */
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/components/utils';
import { API_COMMUNITY_POST_LIKES, apiCommunityPostLikePath } from '@/features/community/routes';

type LikeState = {
  count: number;
  liked: boolean;
};

/**
 * 从批量接口的响应里读出本帖的计数与点赞标记。
 *
 * 响应形状 `counts` / `likedIds` 由 route handler 定义；缺键、类型不对时取 `undefined` /
 * 不猜测。
 */
function readOwnEntry(
  data: unknown,
  postId: string,
): { count: number | undefined; liked: boolean } {
  if (typeof data !== 'object' || data === null) {
    return { count: undefined, liked: false };
  }
  const { counts, likedIds } = data as { counts?: unknown; likedIds?: unknown };
  const rawCount =
    typeof counts === 'object' && counts !== null
      ? (counts as Record<string, unknown>)[postId]
      : undefined;
  const liked = Array.isArray(likedIds) && (likedIds as unknown[]).includes(postId);

  return { count: typeof rawCount === 'number' ? rawCount : undefined, liked };
}

/**
 * 逗号拼接是网络上的键。id 是 UUID（不含逗号），所以拼接串与 id 集合一一对应，
 * 可以直接当去重键用。
 */
function joinIds(ids: string[]): string {
  return ids.join(',');
}

const inflightSyncs = new Map<string, Promise<unknown>>();

function syncLikes(ids: string[]): Promise<unknown> {
  const key = joinIds(ids);
  const existing = inflightSyncs.get(key);
  if (existing) return existing;

  const promise = fetch(`${API_COMMUNITY_POST_LIKES}?ids=${encodeURIComponent(key)}`)
    .then(async (response) => (response.ok ? response.json() : null))
    .finally(() => {
      inflightSyncs.delete(key);
    });
  inflightSyncs.set(key, promise);
  return promise;
}

/**
 * 本帖在批量同步中的行为。
 *
 * 列表页把整页的 id 一起传进来（经 `syncLikes` 去重后一次请求解决一页），详情页只传自己。
 * 挂载即发；不做 AbortController——这是幂等的读，晚到的响应写入的是本帖自己的状态，
 * 不会串到别的帖子。计数与点赞标记一起修正：ISR 首帧值可能落后（e2e 实证 15 秒窗口内
 * reload 拿到的还是旧计数），批量响应里的计数是库中真值。
 */
function useSyncLikes(
  postId: string,
  ids: string[],
  onSynced: (entry: { count: number | undefined; liked: boolean }) => void,
): void {
  useEffect(() => {
    if (ids.length === 0) return;
    syncLikes(ids)
      .then((data: unknown) => {
        onSynced(readOwnEntry(data, postId));
      })
      .catch(() => {
        /* 失败保持「没点过」的乐观渲染：未登录、网络抖动都不该把按钮变灰。 */
      });
  }, [postId, joinIds(ids)]);
}

export function LikeButton({
  postId,
  initialCount,
  allPostIds,
  compact = false,
}: {
  postId: string;
  /** 服务端渲染进 HTML 的首帧计数，挂载后由批量同步修正（见文件头）。 */
  initialCount: number;
  /**
   * 一次批量同步里要包含的 id 集合（列表页传整页，详情页省略即只同步自己）。
   * 传法见 `post-card.tsx`。
   */
  allPostIds?: readonly string[];
  /** 列表页的紧凑形态（`sm` 尺寸）；详情页省略即常规尺寸。 */
  compact?: boolean;
}) {
  const [state, setState] = useState<LikeState>({ count: initialCount, liked: false });
  const [error, setError] = useState<string | null>(null);

  useSyncLikes(postId, [...(allPostIds ?? [postId])], (synced) => {
    setState((prev) => ({
      count: synced.count ?? prev.count,
      liked: synced.liked,
    }));
  });

  async function toggle() {
    setError(null);
    /* 乐观更新：结果由接口裁决，失败回滚到点击前的状态。 */
    const before = state;
    const optimisticLiked = !state.liked;
    const optimisticCount = state.count + (optimisticLiked ? 1 : -1);
    setState({ count: Math.max(0, optimisticCount), liked: optimisticLiked });

    try {
      const response = await fetch(apiCommunityPostLikePath(postId), {
        method: optimisticLiked ? 'POST' : 'DELETE',
      });
      const data: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setState(before);
        setError(
          typeof data === 'object' &&
            data !== null &&
            typeof (data as { message?: unknown }).message === 'string'
            ? (data as { message: string }).message
            : '操作失败，请重试。',
        );
        return;
      }

      /*
       * 接口返回 `{ liked }`（操作完成后的状态）。以它为准修正乐观值：重复点击、
       * 计数缓存旧值都在这里被收敛。
       */
      if (
        typeof data === 'object' &&
        data !== null &&
        typeof (data as { liked?: unknown }).liked === 'boolean'
      ) {
        const liked = (data as { liked: boolean }).liked;
        setState((prev) => ({
          liked,
          count: Math.max(0, prev.count + (liked === prev.liked ? 0 : liked ? 1 : -1)),
        }));
      }
    } catch {
      setState(before);
      setError('网络异常，请重试。');
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Button
        type="button"
        variant={state.liked ? 'default' : 'outline'}
        size={compact ? 'sm' : 'default'}
        onClick={() => void toggle()}
        aria-pressed={state.liked}
        aria-label={state.liked ? '取消点赞' : '点赞'}
        className={cn('gap-1.5', compact && 'h-9 px-3')}
      >
        <span aria-hidden>👍</span>
        <span>{state.count}</span>
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
