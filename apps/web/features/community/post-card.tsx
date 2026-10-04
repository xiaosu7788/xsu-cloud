'use client';

/**
 * 帖子卡片。公开列表、按标签浏览、搜索与「我的帖子」共用同一张卡片。
 *
 * ## 为什么是客户端组件
 *
 * 卡片内嵌「点赞」按钮，而点赞按钮必须等会话查询返回才能确定「我有没有点过」
 * （`features/auth/session-badge.tsx` 的同一条理由：公开页服务端不读会话，否则整区变动态）。
 * 卡片本身没有任何需要 JavaScript 的行为，服务端首屏照常渲染出完整 HTML——`'use client'`
 * 只影响水合，不影响预渲染，`/community` 的 ISR 不受影响。
 *
 * ## props 只收纯数据
 *
 * 类型见 `./view` 的 `PostCardModel`：字段裁剪、作者名兜底、计数兜底都由页面（或加载更多的
 * fetch 回调）组装好再传进来，本组件不做查询、不做判定。
 */
import Link from 'next/link';

import { cn } from '@/components/utils';
import { LikeButton } from '@/features/community/like-button';
import { communityPostPath, communityTagPath } from '@/features/community/routes';
import { formatPostDate, type PostCardModel } from '@/features/community/view';

export function PostCard({
  post,
  syncIds,
  className,
}: {
  post: PostCardModel;
  /**
   * 「一次批量同步」要覆盖的 id 集合，原样透传给 `LikeButton.allPostIds`。
   * 列表页传整页 id（一页只发一次批量请求，去重见 `like-button.tsx`）；详情页 / 控制台
   * 省略即只同步本帖。
   */
  syncIds?: readonly string[];
  className?: string;
}) {
  return (
    <article
      className={cn('flex flex-col gap-2 rounded-md border border-border px-4 py-3', className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="min-w-0 text-base font-medium">
          <Link href={communityPostPath(post.id)} className="transition-colors hover:underline">
            {post.title}
          </Link>
        </h3>
        <LikeButton postId={post.id} initialCount={post.likeCount} allPostIds={syncIds} compact />
      </div>

      <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span className="truncate">{post.authorName ?? '作者已注销'}</span>
        <span aria-hidden>·</span>
        {/* 确定性格式（`./view` 的 `formatPostDate`），服务端与客户端必然一致。 */}
        <time dateTime={post.createdAt}>{formatPostDate(post.createdAt)}</time>
      </p>

      {post.tags.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {post.tags.map((tag) => (
            <li key={tag}>
              <Link
                href={communityTagPath(tag)}
                className="inline-flex h-8 items-center rounded-full bg-muted px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {tag}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
