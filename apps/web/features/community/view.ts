/**
 * 社区列表与详情共用的视图模型与格式化。
 *
 * 单独成文件（而不是放在某个组件里）的理由与 `features/tools/format.ts` 相同：帖子卡片
 * 服务端渲染首屏、客户端渲染「加载更多」追加的行，两边必须用**同一份**字段裁剪与日期格式，
 * 否则同一篇帖子在两处渲染出两种样子。
 *
 * 这里不做任何判定：可见性、归属、配额都在 `@xsu/core` 的 `src/community/`。
 */
import type { PostListItem } from '@xsu/db/schema';

/**
 * 帖子卡片的 props：字段裁剪 + 作者摘要 + 点赞计数，全部是可序列化的纯数据。
 *
 * **不直接把 `PostListItem` 传给客户端组件**：作者名与点赞数来自网关的两个页面读取
 * （`@xsu/platform` 的 `CommunityGateway`），由页面组装好再传下来，客户端组件因此不需要
 * 也不允许再发查询。`createdAt` 跨边界会变成 ISO 字符串，类型上用 `string` 说破这件事。
 */
export type PostCardModel = {
  id: string;
  title: string;
  tags: string[];
  createdAt: string;
  /** 作者显示名。作者账号已被删除时为 `null`（正常路径上不会发生，见仓储的注释）。 */
  authorName: string | null;
  /** 归一化后的标签已按字母序排好，保证服务端与客户端渲染同一顺序。 */
  likeCount: number;
};

/**
 * 确定性的日期展示格式：`2026-02-03`。
 *
 * **不用 `toLocaleDateString`**：它依赖运行环境的时区与 locale，服务端预渲染出的字符串与
 * 浏览器水合后算出的不一致，React 会报 hydration mismatch。ISO 日期（UTC）两边必然一致；
 * 代价是日期可能比本地时间早 / 晚一天，对「社区帖子发布于哪天」这个精度是可接受的。
 */
export function formatPostDate(iso: string): string {
  return iso.slice(0, 10);
}

/** 从一页列表行组装卡片模型。作者摘要缺的 id 显示「已注销」而不是猜一个名字。 */
export function toPostCardModels(
  items: readonly PostListItem[],
  authors: ReadonlyMap<string, { name: string }>,
  counts: ReadonlyMap<string, number>,
): PostCardModel[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    tags: [...item.tags].sort((a, b) => a.localeCompare(b)),
    createdAt: item.createdAt.toISOString(),
    authorName: authors.get(item.authorId)?.name ?? null,
    likeCount: counts.get(item.id) ?? 0,
  }));
}
