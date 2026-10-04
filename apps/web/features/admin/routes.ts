/**
 * 后台管理（M5）的路由常量。
 *
 * 与 `features/auth/routes.ts`、`features/community/routes.ts` 同一条约定：路径只写一处，
 * 本文件**只放常量与纯拼接函数，不 import 任何东西**——页面、Server Action 与 e2e 一起引用。
 *
 * | 常量 / 函数 | 目录 | 说明 |
 * | --- | --- | --- |
 * | `ADMIN_HOME` | `app/(admin)/admin/page.tsx` | 概览（auth/routes.ts 已有，这里不重复） |
 * | `ADMIN_USERS` | `app/(admin)/admin/users/page.tsx` | 用户管理 |
 * | `ADMIN_CONTENT` | `app/(admin)/admin/content/page.tsx` | 内容管理 |
 * | `ADMIN_TASKS` | `app/(admin)/admin/tasks/page.tsx` | 任务管理（只读） |
 * | `ADMIN_CONFIG` | `app/(admin)/admin/config/page.tsx` | 站点配置 |
 * | `ADMIN_AUDIT` | `app/(admin)/admin/audit/page.tsx` | 审计日志（只读） |
 *
 * `adminPagePath` 把 `?page=` 与回跳上下文（`q`）拼进链接；Server Action 的 redirect 也用它，
 * 保证「翻页第几页」只有一个事实来源。
 */

/** 用户管理：搜索、改角色、封禁 / 解封。 */
export const ADMIN_USERS = '/admin/users';

/** 内容管理：帖子与评论的全状态列表、下架与恢复。 */
export const ADMIN_CONTENT = '/admin/content';

/** 任务管理：`tool_runs` 的只读统计（M5 不做重试 / 取消，见 SPEC-admin §1）。 */
export const ADMIN_TASKS = '/admin/tasks';

/** 站点配置：三项每小时配额的覆盖。 */
export const ADMIN_CONFIG = '/admin/config';

/** 审计日志：全部敏感操作的只读留痕。 */
export const ADMIN_AUDIT = '/admin/audit';

/** 拼后台列表页的路径（含页码与搜索关键词，供翻页链接与回跳用）。 */
export function adminPagePath(base: string, params: { page?: number; q?: string } = {}): string {
  const search = new URLSearchParams();
  if (params.page !== undefined && params.page > 1) {
    search.set('page', String(params.page));
  }
  if (params.q !== undefined && params.q !== '') {
    search.set('q', params.q);
  }
  const query = search.toString();
  return query === '' ? base : `${base}?${query}`;
}
