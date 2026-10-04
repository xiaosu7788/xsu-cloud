/**
 * 公开列表页共用的帖子列表段：首页、标签页、搜索页三处渲染同一结构。
 *
 * 单独成文件的理由与 `view.ts` 相同：三个页面必须用**同一份**卡片组装与翻页入口，
 * 否则改一处漏两处。空态文案各页不同（「还没有帖子」/「这个标签下还没有帖子」/
 * 「没有找到相关帖子」），所以空态留在各页面里，本组件只负责非空列表。
 *
 * 首屏帖子由服务端渲染；「加载更多」追加的页在浏览器里经列表 API 取（`load-more.tsx`）。
 * 整页 id 一起传给卡片：一页只发一次批量点赞同步（`like-button.tsx` 的 in-flight 去重）。
 */
import { LoadMore } from '@/features/community/load-more';
import { PostCard } from '@/features/community/post-card';
import type { PostCardModel } from '@/features/community/view';

export function PostList({
  posts,
  nextCursor,
  tag,
  q,
}: {
  posts: readonly PostCardModel[];
  nextCursor: string | null;
  /** 标签页的过滤条件，透传给「加载更多」的请求。 */
  tag?: string;
  /** 搜索页的过滤条件，透传给「加载更多」的请求。 */
  q?: string;
}) {
  const pageIds = posts.map((post) => post.id);

  return (
    <>
      <ul className="flex flex-col gap-4">
        {posts.map((post) => (
          <li key={post.id}>
            <PostCard post={post} syncIds={pageIds} />
          </li>
        ))}
      </ul>
      <LoadMore initialCursor={nextCursor} initialIds={pageIds} tag={tag} q={q} />
    </>
  );
}
