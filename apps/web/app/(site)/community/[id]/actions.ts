/**
 * 帖子详情页的 Server Action：发表评论。
 *
 * ## 为什么只有评论 action 在公开分区
 *
 * 帖子的写操作（发 / 改 / 删）都归属控制台分区（`app/(console)/console/community/`），
 * 唯一发生在公开页上的写操作是「在读的这篇帖子下面发一条评论」。
 *
 * ## 未登录 → redirect 登录页
 *
 * 详情页是 ISR（15 秒），不读会话；登录态由 action 服务端判定。`redirect()` 抛出的控制流
 * 由 Next 接住并让浏览器跳转，`useActionState` 照常工作——不需要在客户端先查一次会话。
 */
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { createComment } from '@xsu/core';
import { createCommunityPorts } from '@xsu/platform';

import { readSessionUser } from '@/features/auth/session';
import { communityPostPath } from '@/features/community/routes';
import type { CommentFormState } from '@/features/community/post-state';

/**
 * 表单字段名与读取（与 `features/tools/form-fields.ts` 的同一条约定：字段名只写一处）。
 * 评论表单只有一个字段，专门为它建一个 form-fields 文件不值当，常量直接放这里——
 * 渲染端（`comment-form.tsx`）的 `name="body"` 与这里的读取必须一起改。
 */
const COMMENT_BODY_FIELD = 'body';

/**
 * `postId` 不走表单字段：表单字段可被客户端篡改成任意 id，而这里的值由页面
 * `createCommentAction.bind(null, post.id)` 绑定，与正在渲染的帖子一致。
 */
export async function createCommentAction(
  postId: string,
  _prev: CommentFormState,
  formData: FormData,
): Promise<CommentFormState> {
  const user = await readSessionUser();
  if (!user) {
    redirect('/sign-in');
  }

  const ports = await createCommunityPorts({ userId: user.id });
  const outcome = await createComment(ports, {
    postId,
    authorId: user.id,
    body: formData.get(COMMENT_BODY_FIELD),
  });

  if (!outcome.ok) {
    return {
      status: 'error',
      code: outcome.failure.code,
      message: outcome.failure.message,
      field: outcome.failure.field,
    };
  }

  // 评论落在详情页上，详情页是 ISR：精确 revalidate 让新评论立即可见。
  revalidatePath(communityPostPath(postId));
  return { status: 'ok' };
}
