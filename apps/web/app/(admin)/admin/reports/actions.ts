'use server';

/**
 * 后台举报审核的 Server Action：确认下架 / 驳回。
 *
 * ## 这一层只做翻译
 *
 * 与 `app/(console)/console/community/actions.ts` 同一条分层理由：管理员判定、举报状态流转、
 * 「软删内容 + 举报置终态 + 写审计行」三步同事务全部在 `@xsu/core` 的 `src/community/`；
 * 这里只把 `FormData` 摊成一次调用，并把结果摊成「精确 revalidate + redirect」。
 * 数据访问一律经 `@xsu/platform` 的 `createCommunityPorts`，不 import `@xsu/db`。
 *
 * ## 返回 `void` 而不是表单状态
 *
 * 与 `deletePostAction` 同一取舍：审核动作没有需要回填的表单字段，失败（举报已被另一个
 * 管理员处理掉、权限中途变化）也一律回到队列页——队列只列 `open` 的举报，状态已经是对的。
 * 队列页在 `revalidatePath(ADMIN_REPORTS)` 之后重新渲染，两个管理员同时处理同一条举报时，
 * 输的那次点击只会看到这条举报已经不在队列里，不会看到报错界面。
 *
 * ## revalidate 的对象
 *
 * 队列页固定失效；确认下架帖子目标时还要精确失效被处置内容的详情页。评论目标没有独立
 * 详情页（评论列表在帖子详情页内），详情页 ISR 15s 后自然刷新，无需手动失效。
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { confirmTakedown, dismissReport } from '@xsu/core';
import { createCommunityPorts } from '@xsu/platform';

import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readAdminAccess } from '@/features/auth/session';
import { ADMIN_REPORTS, communityPostPath } from '@/features/community/routes';

/** 表单 hidden 字段携带的 `reports.id`（UUID）。 */
const REPORT_ID_FIELD = 'reportId';

/** `FormData` 读出来的字符串。字段缺失时给 `undefined`。 */
function readField(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * 确认下架：举报成立，内容被软删除（+ 审计）。纯服务端表单驱动，返回 `void`。
 */
export async function confirmTakedownAction(formData: FormData): Promise<void> {
  const access = await readAdminAccess();
  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return;
  }

  const reportId = readField(formData, REPORT_ID_FIELD);
  if (reportId === undefined) return;

  const outcome = await confirmTakedown(await createCommunityPorts({ userId: access.user.id }), {
    reportId,
    actorId: access.user.id,
    actorRole: access.role,
  });

  if (outcome.ok) {
    revalidatePath(ADMIN_REPORTS);
    if (outcome.targetType === 'post') {
      revalidatePath(communityPostPath(outcome.targetId));
    }
  }

  // 举报不存在 / 已被处理 / 权限变化 → 回队列：队列只列 open 的举报，状态已经是对的。
  redirect(ADMIN_REPORTS);
}

/**
 * 驳回举报：举报置终态，**内容保持可见**（+ 审计）。同样纯服务端表单驱动。
 */
export async function dismissReportAction(formData: FormData): Promise<void> {
  const access = await readAdminAccess();
  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return;
  }

  const reportId = readField(formData, REPORT_ID_FIELD);
  if (reportId === undefined) return;

  const outcome = await dismissReport(await createCommunityPorts({ userId: access.user.id }), {
    reportId,
    actorId: access.user.id,
    actorRole: access.role,
  });

  // 驳回不动内容，失效队列页即可。
  if (outcome.ok) {
    revalidatePath(ADMIN_REPORTS);
  }

  redirect(ADMIN_REPORTS);
}
