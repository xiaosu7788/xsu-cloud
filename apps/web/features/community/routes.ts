/**
 * 社区模块的路由常量。
 *
 * 与 `features/auth/routes.ts`、`features/tools/routes.ts` 同一条约定：路径只写一处，本文件
 * **只放常量与纯拼接函数，不 import 任何东西**——它会被服务端组件、客户端组件与 Server Action
 * 一起引用。
 *
 * 与 `app/` 下的目录一一对应（`docs/spec/SPEC-community.md` 第 7 节）：
 *
 * | 常量 / 函数 | 目录 | 所在分区 |
 * | --- | --- | --- |
 * | `COMMUNITY_HOME` | `app/(site)/community/page.tsx` | `(site)` |
 * | `communityPostPath` | `app/(site)/community/[id]/page.tsx` | `(site)` |
 * | `communityTagPath` | `app/(site)/community/tags/[tag]/page.tsx` | `(site)` |
 * | `COMMUNITY_SEARCH` | `app/(site)/community/search/page.tsx` | `(site)` |
 * | `CONSOLE_COMMUNITY` | `app/(console)/console/community/page.tsx` | `(console)` |
 * | `consoleCommunityEditPath` | `app/(console)/console/community/[id]/edit/page.tsx` | `(console)` |
 * | `ADMIN_REPORTS` | `app/(admin)/admin/reports/page.tsx` | `(admin)` |
 *
 * API 路径常量单独一段：它们不对应页面目录，但同样只写一处——客户端组件直接 fetch 这些路径，
 * 页面如果再手写一份，改路径时就会出现「页面打得到、按钮打不到」的分叉。
 */

/** 公开社区首页：按时间倒序的帖子列表。 */
export const COMMUNITY_HOME = '/community';

/** 单篇帖子的详情页。`id` 是 `posts.id`（UUID），拼一个不存在的 id 得到的是 404。 */
export function communityPostPath(id: string): string {
  return `${COMMUNITY_HOME}/${id}`;
}

/** 按标签浏览。`tag` 必须是归一化后的标签值（小写、去空格）。 */
export function communityTagPath(tag: string): string {
  return `${COMMUNITY_HOME}/tags/${encodeURIComponent(tag)}`;
}

/**
 * 搜索页。**唯一**读 `searchParams` 的社区公开页（动态渲染，已在
 * `apps/web/e2e/static-render.spec.ts` 的 `SITE_DYNAMIC_EXCEPTIONS` 里登记理由）。
 */
export const COMMUNITY_SEARCH = '/community/search';

/** 控制台里的「我的帖子」。 */
export const CONSOLE_COMMUNITY = '/console/community';

/** 编辑自己的某篇帖子。非作者与已删除帖子渲染统一拒绝视图（判定在页面里）。 */
export function consoleCommunityEditPath(id: string): string {
  return `${CONSOLE_COMMUNITY}/${id}/edit`;
}

/** 后台的待处理举报队列。只有 `admin` 角色可达。 */
export const ADMIN_REPORTS = '/admin/reports';

/*
 * API 路径（Route Handlers，`app/api/community/`）。
 */

/** 帖子列表接口：`GET`，参数 `cursor` / `tag` / `q` / `limit`。 */
export const API_COMMUNITY_POSTS = '/api/community/posts';

/** 帖子点赞接口：`GET` 读状态、`POST` 点赞、`DELETE` 取消。 */
export function apiCommunityPostLikePath(postId: string): string {
  return `${API_COMMUNITY_POSTS}/${postId}/like`;
}

/**
 * 批量点赞接口：`GET ?ids=` → 计数 + 当前用户的点赞标记。
 *
 * 参数名是 `ids`，重复 id 由服务端去重（`app/api/community/posts/likes/route.ts`）。
 */
export const API_COMMUNITY_POST_LIKES = '/api/community/posts/likes';

/** 举报接口：`POST`，body 为 JSON。 */
export const API_COMMUNITY_REPORTS = '/api/community/reports';

/** 评论接口：`GET`（翻页）与 `POST`（发表）。 */
export function apiCommunityPostCommentsPath(postId: string): string {
  return `${API_COMMUNITY_POSTS}/${postId}/comments`;
}
