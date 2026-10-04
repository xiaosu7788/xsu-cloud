/**
 * 后台页面共享的小件：结果横幅、分页器、日期与文本格式化。
 *
 * 全部是服务端可用的纯组件 / 纯函数——`/admin` 五页没有客户端状态，成功与失败的反馈
 * 统一走「Server Action redirect 回本页 + `?ok=` / `?error=` 查询参数」（SPEC-admin §5），
 * 这里的 `AdminBanner` 是那条反馈链路的唯一渲染点。
 */
import Link from 'next/link';

import { ADMIN_FAILURE, type AdminFailureCode } from '@xsu/core';

/** Server Action 成功后允许出现在 `?ok=` 里的值。白名单外的值一律不渲染（不可信输入）。 */
export type AdminOkCode =
  | 'user-role'
  | 'user-ban'
  | 'user-unban'
  | 'post-takedown'
  | 'post-restore'
  | 'comment-takedown'
  | 'comment-restore'
  | 'site-config';

const ADMIN_OK_MESSAGE: Record<AdminOkCode, string> = {
  'user-role': '角色已更新。',
  'user-ban': '已封禁，该用户的全部会话已下线。',
  'user-unban': '已解封，该用户需要重新登录。',
  'post-takedown': '帖子已下架，公开侧立即不可见。',
  'post-restore': '帖子已恢复。',
  'comment-takedown': '评论已下架，公开侧立即不可见。',
  'comment-restore': '评论已恢复。',
  'site-config': '站点配置已保存，新的配额立即生效。',
};

/** `?ok=` 值的收窄：不在白名单里就当没带过。 */
export function readOkCode(raw: string | string[] | undefined): AdminOkCode | null {
  const value = typeof raw === 'string' ? raw : undefined;
  if (value === undefined) return null;
  return (ADMIN_OK_MESSAGE as Record<string, string>)[value] !== undefined
    ? (value as AdminOkCode)
    : null;
}

/**
 * 把领域失败对象转成 `?error=` 用的键（`ADMIN_FAILURE` 的 key，如 `notAdmin`）。
 * `AdminFailure.code` 是面向 API 的稳定串（如 `ADMIN_NOT_ADMIN`），而横幅按 key 取
 * `ADMIN_FAILURE[key].message`——两个命名空间都在 core 的码表里，这里只做映射。
 */
export function failureKey(failure: { code: string }): string | undefined {
  const entry = (Object.entries(ADMIN_FAILURE) as Array<[string, { code: string }]>).find(
    ([, value]) => value.code === failure.code,
  );
  return entry?.[0];
}

/** `?error=` 值的收窄：必须是 `ADMIN_FAILURE` 的合法 key，否则当没带过。 */
export function readErrorCode(raw: string | string[] | undefined): AdminFailureCode | null {
  const value = typeof raw === 'string' ? raw : undefined;
  if (value === undefined) return null;
  return value in ADMIN_FAILURE ? (value as AdminFailureCode) : null;
}

/**
 * 操作结果横幅。查询参数是 URL 的一部分，会被截图、被分享、被刷新重放——
 * 所以这里只读白名单内的键并渲染固定文案，不回显任何用户可控的字符串。
 */
export function AdminBanner({
  ok,
  error,
}: {
  ok: AdminOkCode | null;
  error: AdminFailureCode | null;
}) {
  if (ok !== null) {
    return (
      <p
        role="status"
        className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground"
      >
        {ADMIN_OK_MESSAGE[ok]}
      </p>
    );
  }
  if (error !== null) {
    return (
      <p
        role="alert"
        className="rounded-md border border-destructive px-3 py-2 text-sm text-destructive"
      >
        {ADMIN_FAILURE[error].message}
      </p>
    );
  }
  return null;
}

/**
 * 偏移分页器（上一页 / 下一页）。`total` 由领域层的 `AdminPage` 带回：
 * 「有没有下一页」用总数算，不用「请求 pageSize+1 再裁掉」的猜法。
 */
export function AdminPager({
  base,
  page,
  total,
  limit,
  q,
  pageKey = 'page',
}: {
  base: string;
  page: number;
  total: number;
  limit: number;
  q?: string;
  /** 分页参数名。内容页帖子 / 评论两个表各自分页，用 `postPage` / `commentPage` 区分。 */
  pageKey?: string;
}) {
  const totalPages = Math.max(Math.ceil(total / limit), 1);
  if (totalPages <= 1) {
    return null;
  }
  const build = (target: number) => {
    const search = new URLSearchParams();
    if (target > 1) search.set(pageKey, String(target));
    if (q !== undefined && q !== '') search.set('q', q);
    const query = search.toString();
    return query === '' ? base : `${base}?${query}`;
  };
  return (
    <nav className="flex items-center justify-between text-sm" aria-label="分页">
      {page > 1 ? (
        <Link href={build(page - 1)} className="underline underline-offset-2">
          上一页
        </Link>
      ) : (
        <span className="text-muted-foreground">上一页</span>
      )}
      <span className="text-muted-foreground">
        第 {page} / {totalPages} 页 · 共 {total} 条
      </span>
      {page < totalPages ? (
        <Link href={build(page + 1)} className="underline underline-offset-2">
          下一页
        </Link>
      ) : (
        <span className="text-muted-foreground">下一页</span>
      )}
    </nav>
  );
}

/** 后台统一的时间显示（与公开侧 `formatPostDate` 同一取舍：ISO 前 10 位）。 */
export function formatAdminDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** 后台统一的正文摘要：过长的截断，换行抹平（移动卡片里多行正文会顶爆卡片）。 */
export function adminExcerpt(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 状态徽章的共用样式：内容管理页的「正常 / 已下架 / 已删除」。 */
export function adminStatusBadge(tone: 'ok' | 'muted' | 'danger'): string {
  const toneClass =
    tone === 'ok'
      ? 'bg-muted text-foreground'
      : tone === 'danger'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-muted text-muted-foreground';
  return `inline-block rounded px-1.5 py-0.5 text-xs ${toneClass}`;
}
