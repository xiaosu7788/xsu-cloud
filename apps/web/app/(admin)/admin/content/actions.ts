'use server';

/**
 * 内容管理的 Server Action：帖子下架 / 恢复、评论下架 / 恢复。
 *
 * 判定与「条件写 + 审计同事务」都在 `@xsu/core` 的 `src/admin/content.ts`；这里只把
 * `FormData` 摊成一次调用，并把结果摊成「精确 revalidate + redirect 回本页」。数据访问
 * 一律经 `@xsu/platform` 的 `createAdminGateway`，不 import `@xsu/db`。
 *
 * ## revalidate 两条路径
 *
 * 下架 / 恢复改变公开侧可见性：后台列表要刷新（`ADMIN_CONTENT`），帖子目标还要刷新
 * 详情页（`communityPostPath`）。评论没有独立路由，跟帖子详情页一起失效。
 *
 * ## 失败也 redirect
 *
 * `?error=` 传 `ADMIN_FAILURE` 的**键**（`failureKey` 从 API code 映射），页面横幅按键取
 * 固定文案。隐藏字段 `postPage` / `commentPage` 带回原来的分页位置。
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { restoreComment, restorePost, takedownComment, takedownPost } from '@xsu/core';
import { createAdminGateway } from '@xsu/platform';

import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readAdminAccess } from '@/features/auth/session';
import { communityPostPath } from '@/features/community/routes';
import { ADMIN_CONTENT } from '@/features/admin/routes';
import { failureKey } from '@/features/admin/view';

/** `FormData` 读出来的字符串。字段缺失时给 `undefined`。 */
function readField(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}

/** 回跳路径：保留两个表的页码，再叠上结果码。 */
function backPath(params: { postPage?: string; commentPage?: string }): string {
  const search = new URLSearchParams();
  const postPage = Number(params.postPage ?? '');
  if (Number.isFinite(postPage) && Math.trunc(postPage) >= 2) {
    search.set('postPage', String(Math.trunc(postPage)));
  }
  const commentPage = Number(params.commentPage ?? '');
  if (Number.isFinite(commentPage) && Math.trunc(commentPage) >= 2) {
    search.set('commentPage', String(Math.trunc(commentPage)));
  }
  const query = search.toString();
  return query === '' ? ADMIN_CONTENT : `${ADMIN_CONTENT}?${query}`;
}

/** 追加 `?ok=` / `?error=`（backPath 不认识这两个键，在这里拼）。 */
function withResult(path: string, ok: string | undefined, error: string | undefined): string {
  if (ok === undefined && error === undefined) return path;
  const joiner = path.includes('?') ? '&' : '?';
  const result =
    ok !== undefined
      ? `ok=${encodeURIComponent(ok)}`
      : `error=${encodeURIComponent(error as string)}`;
  return `${path}${joiner}${result}`;
}

/** 帖子动作共用的收尾：刷新后台列表与帖子详情页，回本页带结果码。 */
function finishPostAction(params: {
  postId: string;
  outcome: { ok: true; value: { changed: boolean } } | { ok: false; failure: { code: string } };
  postPage?: string;
  commentPage?: string;
  okCode: 'post-takedown' | 'post-restore';
}): never {
  revalidatePath(ADMIN_CONTENT);
  revalidatePath(communityPostPath(params.postId));
  redirect(
    withResult(
      backPath({ postPage: params.postPage, commentPage: params.commentPage }),
      params.outcome.ok ? params.okCode : undefined,
      params.outcome.ok ? undefined : failureKey(params.outcome.failure),
    ),
  );
}

/** 评论动作共用的收尾：评论随帖子详情页展示，刷新同一条路径。 */
function finishCommentAction(params: {
  postId: string;
  outcome: { ok: true; value: { changed: boolean } } | { ok: false; failure: { code: string } };
  postPage?: string;
  commentPage?: string;
  okCode: 'comment-takedown' | 'comment-restore';
}): never {
  revalidatePath(ADMIN_CONTENT);
  revalidatePath(communityPostPath(params.postId));
  redirect(
    withResult(
      backPath({ postPage: params.postPage, commentPage: params.commentPage }),
      params.outcome.ok ? params.okCode : undefined,
      params.outcome.ok ? undefined : failureKey(params.outcome.failure),
    ),
  );
}

/** 下架一篇帖子（软删除，公开侧立即不可见）。 */
export async function takedownPostAction(formData: FormData): Promise<void> {
  const access = await readAdminAccess();
  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return;
  }

  const postId = readField(formData, 'postId');
  const postPage = readField(formData, 'postPage');
  const commentPage = readField(formData, 'commentPage');

  if (postId === undefined) {
    redirect(withResult(backPath({ postPage, commentPage }), undefined, 'inputInvalid'));
  }

  const outcome = await takedownPost(createAdminGateway(), {
    actorId: access.user.id,
    actorRole: access.role,
    postId,
  });

  finishPostAction({ postId, outcome, postPage, commentPage, okCode: 'post-takedown' });
}

/** 恢复一篇帖子。数据层只看 `deleted_at`，作者软删除与管理员下架在这里同形，都能恢复。 */
export async function restorePostAction(formData: FormData): Promise<void> {
  const access = await readAdminAccess();
  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return;
  }

  const postId = readField(formData, 'postId');
  const postPage = readField(formData, 'postPage');
  const commentPage = readField(formData, 'commentPage');

  if (postId === undefined) {
    redirect(withResult(backPath({ postPage, commentPage }), undefined, 'inputInvalid'));
  }

  const outcome = await restorePost(createAdminGateway(), {
    actorId: access.user.id,
    actorRole: access.role,
    postId,
  });

  finishPostAction({ postId, outcome, postPage, commentPage, okCode: 'post-restore' });
}

/** 下架一条评论（软删除，公开侧立即不可见）。 */
export async function takedownCommentAction(formData: FormData): Promise<void> {
  const access = await readAdminAccess();
  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return;
  }

  const commentId = readField(formData, 'commentId');
  const postId = readField(formData, 'postId');
  const postPage = readField(formData, 'postPage');
  const commentPage = readField(formData, 'commentPage');

  if (commentId === undefined) {
    redirect(withResult(backPath({ postPage, commentPage }), undefined, 'inputInvalid'));
  }

  const outcome = await takedownComment(createAdminGateway(), {
    actorId: access.user.id,
    actorRole: access.role,
    commentId,
  });

  // 评论动作的 revalidate 走它所属的帖子详情页；postId 只是路由参数，缺省给空串兜底。
  finishCommentAction({
    postId: postId ?? '',
    outcome,
    postPage,
    commentPage,
    okCode: 'comment-takedown',
  });
}

/**
 * 恢复一条评论。父帖已删除时领域层拒绝（`parentPostDeleted`），横幅给固定文案。
 */
export async function restoreCommentAction(formData: FormData): Promise<void> {
  const access = await readAdminAccess();
  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return;
  }

  const commentId = readField(formData, 'commentId');
  const postId = readField(formData, 'postId');
  const postPage = readField(formData, 'postPage');
  const commentPage = readField(formData, 'commentPage');

  if (commentId === undefined) {
    redirect(withResult(backPath({ postPage, commentPage }), undefined, 'inputInvalid'));
  }

  const outcome = await restoreComment(createAdminGateway(), {
    actorId: access.user.id,
    actorRole: access.role,
    commentId,
  });

  finishCommentAction({
    postId: postId ?? '',
    outcome,
    postPage,
    commentPage,
    okCode: 'comment-restore',
  });
}
