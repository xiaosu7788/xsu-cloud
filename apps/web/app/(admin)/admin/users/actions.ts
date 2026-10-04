'use server';

/**
 * 用户管理的 Server Action：改角色 / 封禁 / 解封。
 *
 * 与 `app/(admin)/admin/reports/actions.ts` 同一条分层理由：管理员判定、防自锁、
 * 「条件写 + 审计同事务」全部在 `@xsu/core` 的 `src/admin/`；这里只把 `FormData` 摊成
 * 一次调用，并把结果摊成「精确 revalidate + redirect 回本页（带 `?ok=` / `?error=`）」。
 * 数据访问一律经 `@xsu/platform` 的 `createAdminGateway`，不 import `@xsu/db`。
 *
 * ## 失败也 redirect
 *
 * 返回 `void`：失败键经 `?error=` 回本页，页面用 `AdminBanner` 渲染固定文案（SPEC §5）。
 * `?error=` 传的是 `ADMIN_FAILURE` 的**键**（如 `notAdmin`）——领域失败对象先用
 * `failureKey` 从 API code（如 `ADMIN_NOT_ADMIN`）映射过来。表单隐藏字段带 `q` / `page`，
 * 失败回到原来的搜索结果页，上下文不丢。
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { banUser, unbanUser, updateUserRole } from '@xsu/core';
import { createAdminGateway } from '@xsu/platform';

import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readAdminAccess } from '@/features/auth/session';
import { adminPagePath, ADMIN_USERS } from '@/features/admin/routes';
import { failureKey } from '@/features/admin/view';

/** `FormData` 读出来的字符串。字段缺失时给 `undefined`。 */
function readField(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}

/** 回跳路径：保留搜索关键词与页码，再叠上结果码。 */
function backPath(params: { q?: string; page?: string }): string {
  const page = params.page !== undefined ? Number(params.page) : undefined;
  return adminPagePath(ADMIN_USERS, {
    page: page !== undefined && Number.isFinite(page) && page >= 1 ? Math.trunc(page) : undefined,
    q: params.q,
  });
}

/** 追加 `?ok=` / `?error=`（adminPagePath 不认识这两个键，在这里拼）。 */
function withResult(path: string, ok: string | undefined, error: string | undefined): string {
  if (ok === undefined && error === undefined) return path;
  const joiner = path.includes('?') ? '&' : '?';
  const result =
    ok !== undefined
      ? `ok=${encodeURIComponent(ok)}`
      : `error=${encodeURIComponent(error as string)}`;
  return `${path}${joiner}${result}`;
}

/**
 * 改角色。`?ok=user-role` 表示成功；`changed:false`（目标已在角色里）与成功同义，
 * 同样回成功横幅——领域层的幂等短路保证了不写第二行审计。
 */
export async function updateUserRoleAction(formData: FormData): Promise<void> {
  const access = await readAdminAccess();
  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return;
  }

  const userId = readField(formData, 'userId');
  const role = readField(formData, 'role');
  const q = readField(formData, 'q');
  const page = readField(formData, 'page');

  if (userId === undefined || role === undefined) {
    redirect(withResult(backPath({ q, page }), undefined, 'inputInvalid'));
  }

  const outcome = await updateUserRole(createAdminGateway(), {
    actorId: access.user.id,
    actorRole: access.role,
    userId,
    role,
  });

  revalidatePath(ADMIN_USERS);
  redirect(
    withResult(
      backPath({ q, page }),
      outcome.ok ? 'user-role' : undefined,
      outcome.ok ? undefined : failureKey(outcome.failure),
    ),
  );
}

/**
 * 封禁：写 `banned_at` / `ban_reason` 并删掉该用户全部会话（同事务，端口职责）。
 * 封禁理由是唯一需要用户输入的表单字段。
 */
export async function banUserAction(formData: FormData): Promise<void> {
  const access = await readAdminAccess();
  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return;
  }

  const userId = readField(formData, 'userId');
  const reason = readField(formData, 'reason') ?? '';
  const q = readField(formData, 'q');
  const page = readField(formData, 'page');

  if (userId === undefined) {
    redirect(withResult(backPath({ q, page }), undefined, 'inputInvalid'));
  }

  const outcome = await banUser(createAdminGateway(), {
    actorId: access.user.id,
    actorRole: access.role,
    userId,
    reason,
  });

  revalidatePath(ADMIN_USERS);
  redirect(
    withResult(
      backPath({ q, page }),
      outcome.ok ? 'user-ban' : undefined,
      outcome.ok ? undefined : failureKey(outcome.failure),
    ),
  );
}

/** 解封：清 `banned_at` / `ban_reason`。被删掉的会话不会回来，用户需要重新登录。 */
export async function unbanUserAction(formData: FormData): Promise<void> {
  const access = await readAdminAccess();
  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return;
  }

  const userId = readField(formData, 'userId');
  const q = readField(formData, 'q');
  const page = readField(formData, 'page');

  if (userId === undefined) {
    redirect(withResult(backPath({ q, page }), undefined, 'inputInvalid'));
  }

  const outcome = await unbanUser(createAdminGateway(), {
    actorId: access.user.id,
    actorRole: access.role,
    userId,
  });

  revalidatePath(ADMIN_USERS);
  redirect(
    withResult(
      backPath({ q, page }),
      outcome.ok ? 'user-unban' : undefined,
      outcome.ok ? undefined : failureKey(outcome.failure),
    ),
  );
}
