/**
 * 评论：发表、删除、按帖子收集。
 *
 * 与帖子共用一套游标规则，但**排序方向相反**：评论正序（最早的在前），与详情页从上往下读的
 * 方向一致，也和 `comments_post_idx` 同序（`repositories/community.ts` 的 `listComments`）。
 * 游标里存的只是位置，方向由查询决定，所以 `paginate` 两边通用。
 *
 * 这里不重复「已删除的内容看不见」那条：单条读取在数据层不过滤 `deleted_at`，门由
 * `loadVisibleComment` 守；列表与收集由数据层的查询条件守（纵深防御，`SPEC-community.md` 4.1）。
 */
import type { CommentDetail, CommentListItem } from '@xsu/db/schema';

import { loadVisiblePost } from './posts';
import {
  decideCommentAccess,
  decodeCursor,
  isQuotaExceeded,
  paginate,
  quotaWindowStart,
  resolvePageSize,
  validateCommentInput,
} from './rules';
import {
  CONTENT_FAILURE,
  type CommentOutcome,
  type CommunityPorts,
  type PageOutcome,
} from './types';

/**
 * 按 id 取一条**还活着**的评论。`null` 表示「不存在，或已被删除 / 下架」。
 *
 * 举报评论前要过这道门（`reports.ts`），否则可以举报一条已经看不见的评论，而管理员在待处理
 * 列表里点「确认下架」时那条内容其实早就没了。
 */
export async function loadVisibleComment(
  ports: CommunityPorts,
  commentId: string,
): Promise<CommentDetail | null> {
  const comment = await ports.getCommentById({ id: commentId });
  return comment && comment.deletedAt === null ? comment : null;
}

/**
 * 在帖子下发表评论。顺序：目标帖子还在 → 校验 → 配额 → 写入。
 *
 * 目标检查放在校验之前是**故意的**：对一篇已下架的帖子，无论正文写得对不对，结论都是
 * 「这篇帖子不存在或已被删除」，先判这个能让失败原因更贴近用户实际看到的东西。
 */
export async function createComment(
  ports: CommunityPorts,
  request: { postId: string; authorId: string; body: unknown },
): Promise<CommentOutcome> {
  const now = ports.now();

  const post = await loadVisiblePost(ports, request.postId);
  if (!post) {
    return { ok: false, failure: CONTENT_FAILURE.postNotFound };
  }

  const input = validateCommentInput(request);
  if (!input.ok) {
    return { ok: false, failure: input.failure };
  }

  const recent = await ports.countCommentsSince({
    authorId: request.authorId,
    since: quotaWindowStart(now),
  });
  if (isQuotaExceeded({ recentCount: recent, quotaPerHour: ports.commentQuotaPerHour })) {
    // 配额拒绝不落行也不计数，理由见 `types.ts` 文件头第 3 条。
    return { ok: false, failure: CONTENT_FAILURE.quotaExceeded };
  }

  const commentId = ports.newId();
  await ports.insertComment({
    id: commentId,
    postId: post.id,
    authorId: request.authorId,
    body: input.value.body,
    createdAt: now,
    updatedAt: now,
  });

  return { ok: true, commentId };
}

/**
 * 作者删自己的评论（软删除）。**评论的删除不影响帖子的计数与可见性**：M3 没有评论数，
 * 列表页也不展示它，所以没有需要跟着改的缓存。
 */
export async function deleteComment(
  ports: CommunityPorts,
  request: { commentId: string; authorId: string },
): Promise<CommentOutcome> {
  const comment = await loadVisibleComment(ports, request.commentId);
  if (!comment) {
    return { ok: false, failure: CONTENT_FAILURE.commentNotFound };
  }

  const access = decideCommentAccess({ viewerId: request.authorId, authorId: comment.authorId });
  if (!access.allowed) {
    return { ok: false, failure: access.failure };
  }

  await ports.softDeleteComment({ id: comment.id, now: ports.now() });
  return { ok: true, commentId: comment.id };
}

/**
 * 一个帖子下的一页评论。**调用方先读帖子**（`readPost`）：已下架帖子的详情页渲染的是拒绝视图，
 * 不会走到这里，所以这里不重复判目标存在——重复一次就多一次查询，也不会让结论更可靠。
 */
export async function listPostComments(
  ports: CommunityPorts,
  request: { postId: string; limit?: unknown; cursor?: unknown },
): Promise<PageOutcome<CommentListItem>> {
  const decoded = decodeCursor(request.cursor);
  if (!decoded.ok) {
    return { ok: false, failure: decoded.failure };
  }

  const limit = resolvePageSize(request.limit);
  const rows = await ports.listComments({
    postId: request.postId,
    limit: limit + 1,
    cursor: decoded.cursor,
  });

  return {
    ok: true,
    ...paginate({ rows, limit, cursorOf: (item) => ({ createdAt: item.createdAt, id: item.id }) }),
  };
}
