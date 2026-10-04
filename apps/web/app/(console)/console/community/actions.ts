'use server';

/**
 * 控制台的社区 Server Action：发帖、改帖、删帖。
 *
 * ## 这一层只做翻译
 *
 * 与 `app/(console)/console/tools/actions.ts` 同一条分层理由：合法性、配额、归属判定全在
 * `@xsu/core` 的 `src/community/`；这里只把 `FormData` 摊成一次调用、把结果摊成表单状态
 * 或重定向。数据访问一律经 `@xsu/platform` 的 `createCommunityPorts`，不 import `@xsu/db`。
 *
 * ## 未登录走重定向
 *
 * 控制台页面只在登录后可见，这里的拒绝实际上是「会话在填表期间失效了」——做成重定向，
 * 与分区布局的行为一致（`tools/actions.ts` 文件头）。判定后仍保留返回失败状态的分支，
 * 「拒绝必须有响应」这条结构不变。
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { createPost, deletePost, updatePost } from '@xsu/core';
import { createCommunityPorts } from '@xsu/platform';

import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readConsoleAccess } from '@/features/auth/session';
import { COMMUNITY_HOME, communityPostPath, CONSOLE_COMMUNITY } from '@/features/community/routes';
import type { PostFormState } from '@/features/community/post-state';

/**
 * 表单字段名。与渲染端（`features/community/post-form.tsx` 的 `name` 属性、
 * `delete-post-button.tsx` 的 hidden 字段）必须一起改，所以写在这里集中一处。
 */
const POST_TITLE_FIELD = 'title';
const POST_BODY_FIELD = 'body';
const POST_TAGS_FIELD = 'tags';
/** hidden 字段携带的 `posts.id`（UUID）。值由页面绑定，不信任表单之外的来源。 */
const POST_ID_FIELD = 'postId';

/** `FormData` 读出来的字符串。字段缺失时给 `undefined`，让领域层按「缺输入」拒绝。 */
function readField(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}

/** 发帖 / 编辑共用的失败返回。 */
function failureOf(outcome: {
  ok: false;
  failure: { code: string; message: string; field?: string };
}): PostFormState {
  return {
    status: 'error',
    code: outcome.failure.code,
    message: outcome.failure.message,
    ...(outcome.failure.field === undefined ? {} : { field: outcome.failure.field }),
  };
}

/**
 * 发一篇帖子。成功后 `redirect()` 到帖子详情页；失败返回结构化状态给 `useActionState`。
 */
export async function createPostAction(
  _previous: PostFormState,
  formData: FormData,
): Promise<PostFormState> {
  const access = await readConsoleAccess();
  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return { status: 'error', code: access.denial.code, message: access.denial.message };
  }

  const outcome = await createPost(await createCommunityPorts({ userId: access.user.id }), {
    authorId: access.user.id,
    title: readField(formData, POST_TITLE_FIELD),
    body: readField(formData, POST_BODY_FIELD),
    tags: readField(formData, POST_TAGS_FIELD),
  });

  if (!outcome.ok) {
    return failureOf(outcome);
  }

  /*
   * 新帖要先出现在公开 Feed 与控制台列表里，详情页也必须可直达。
   * redirect 会立即抛出控制流，revalidate 必须写在它前面。
   */
  revalidatePath(COMMUNITY_HOME);
  revalidatePath(CONSOLE_COMMUNITY);
  revalidatePath(communityPostPath(outcome.postId));
  redirect(communityPostPath(outcome.postId));
}

/**
 * 编辑自己的帖子。`postId` 由编辑页 `bind`（`app/(console)/console/community/[id]/edit/page.tsx`），
 * 不走表单字段——hidden 字段可被客户端篡改成任意 id。
 */
export async function updatePostAction(
  postId: string,
  _previous: PostFormState,
  formData: FormData,
): Promise<PostFormState> {
  const access = await readConsoleAccess();
  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return { status: 'error', code: access.denial.code, message: access.denial.message };
  }

  const outcome = await updatePost(await createCommunityPorts({ userId: access.user.id }), {
    postId,
    authorId: access.user.id,
    title: readField(formData, POST_TITLE_FIELD),
    body: readField(formData, POST_BODY_FIELD),
    tags: readField(formData, POST_TAGS_FIELD),
  });

  if (!outcome.ok) {
    return failureOf(outcome);
  }

  revalidatePath(COMMUNITY_HOME);
  revalidatePath(CONSOLE_COMMUNITY);
  revalidatePath(communityPostPath(postId));
  redirect(communityPostPath(postId));
}

/**
 * 删除自己的帖子（软删除）。纯服务端表单（`delete-post-button.tsx`）直接驱动，
 * 返回 `void`：没有需要展示的结果状态，成功路径 redirect 回「我的帖子」。
 */
export async function deletePostAction(formData: FormData): Promise<void> {
  const access = await readConsoleAccess();
  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return;
  }

  const rawId = readField(formData, POST_ID_FIELD);
  if (rawId === undefined) return;

  const outcome = await deletePost(await createCommunityPorts({ userId: access.user.id }), {
    postId: rawId,
    authorId: access.user.id,
  });

  if (outcome.ok) {
    revalidatePath(COMMUNITY_HOME);
    revalidatePath(CONSOLE_COMMUNITY);
    revalidatePath(communityPostPath(rawId));
  }

  // 失败（帖子不存在 / 不是自己的）也回到列表：列表只显示还活着的帖子，状态已经是对的。
  redirect(CONSOLE_COMMUNITY);
}
