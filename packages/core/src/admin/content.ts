/**
 * 内容管理：帖子的下架 / 恢复与评论的下架 / 恢复。
 *
 * 执行顺序（`SPEC-admin.md` 3.3）：管理员 → 目标存在（不过滤软删除）→ 幂等短路
 * （已在目标状态 → `changed:false`，不写审计）→ 条件写 + 审计同事务。
 *
 * 评论恢复的父帖检查在领域层预检一次（父帖已删 → `parentPostDeleted`），数据层
 * 条件 UPDATE 的 WHERE 再兜一次（样板 `resolveReport` 的双层结构）。
 */
import type { AuditLogListItem } from '@xsu/db/schema';

import { ADMIN_AUDIT_TARGET, adminPageParams, requireAdminActor } from './rules';
import {
  ADMIN_AUDIT_ACTION,
  ADMIN_FAILURE,
  type AdminCommentRow,
  type AdminOutcome,
  type AdminPage,
  type AdminPorts,
  type AdminPostRow,
} from './types';

/** 帖子列表（时间倒序，含下架 / 已删除行——后台要能看见并恢复它们）。 */
export async function listPostsForAdmin(
  ports: AdminPorts,
  request: { actorRole: unknown; page?: unknown },
): Promise<AdminOutcome<AdminPage<AdminPostRow>>> {
  const access = requireAdminActor(request.actorRole);
  if (!access.ok) {
    return access;
  }
  const { limit, offset } = adminPageParams({ page: request.page });
  const items = await ports.listPostsForAdmin({ limit, offset });
  return { ok: true, value: items };
}

/** 评论列表（时间倒序，含下架 / 已删除行）。 */
export async function listCommentsForAdmin(
  ports: AdminPorts,
  request: { actorRole: unknown; page?: unknown },
): Promise<AdminOutcome<AdminPage<AdminCommentRow>>> {
  const access = requireAdminActor(request.actorRole);
  if (!access.ok) {
    return access;
  }
  const { limit, offset } = adminPageParams({ page: request.page });
  const items = await ports.listCommentsForAdmin({ limit, offset });
  return { ok: true, value: items };
}

/** 管理员下架一篇帖子（软删除，公开侧立刻不可见）。 */
export async function takedownPost(
  ports: AdminPorts,
  request: { actorId: string; actorRole: unknown; postId: string },
): Promise<AdminOutcome<{ postId: string; changed: boolean }>> {
  const access = requireAdminActor(request.actorRole);
  if (!access.ok) {
    return access;
  }
  const target = await ports.getAdminPostById({ id: request.postId });
  if (!target) {
    return { ok: false, failure: ADMIN_FAILURE.postNotFound };
  }
  if (target.deletedAt !== null) {
    return { ok: true, value: { postId: target.id, changed: false } };
  }

  const now = ports.now();
  const applied = await ports.adminTakedownPost({
    postId: target.id,
    now,
    audit: {
      id: ports.newId(),
      actorId: request.actorId,
      action: ADMIN_AUDIT_ACTION.postTakedown,
      targetType: ADMIN_AUDIT_TARGET.post,
      targetId: target.id,
      detail: null,
      createdAt: now,
    },
  });
  if (!applied) {
    // 条件 UPDATE 的 WHERE（deleted_at IS NULL）没让开 = 并发下已被处置，与幂等短路同义。
    return { ok: true, value: { postId: target.id, changed: false } };
  }
  return { ok: true, value: { postId: target.id, changed: true } };
}

/** 管理员恢复一篇被下架的帖子。 */
export async function restorePost(
  ports: AdminPorts,
  request: { actorId: string; actorRole: unknown; postId: string },
): Promise<AdminOutcome<{ postId: string; changed: boolean }>> {
  const access = requireAdminActor(request.actorRole);
  if (!access.ok) {
    return access;
  }
  const target = await ports.getAdminPostById({ id: request.postId });
  if (!target) {
    return { ok: false, failure: ADMIN_FAILURE.postNotFound };
  }
  if (target.deletedAt === null) {
    return { ok: true, value: { postId: target.id, changed: false } };
  }

  const now = ports.now();
  const applied = await ports.adminRestorePost({
    postId: target.id,
    now,
    audit: {
      id: ports.newId(),
      actorId: request.actorId,
      action: ADMIN_AUDIT_ACTION.postRestore,
      targetType: ADMIN_AUDIT_TARGET.post,
      targetId: target.id,
      detail: null,
      createdAt: now,
    },
  });
  if (!applied) {
    return { ok: true, value: { postId: target.id, changed: false } };
  }
  return { ok: true, value: { postId: target.id, changed: true } };
}

/** 管理员下架一条评论。 */
export async function takedownComment(
  ports: AdminPorts,
  request: { actorId: string; actorRole: unknown; commentId: string },
): Promise<AdminOutcome<{ commentId: string; changed: boolean }>> {
  const access = requireAdminActor(request.actorRole);
  if (!access.ok) {
    return access;
  }
  const target = await ports.getAdminCommentById({ id: request.commentId });
  if (!target) {
    return { ok: false, failure: ADMIN_FAILURE.commentNotFound };
  }
  if (target.deletedAt !== null) {
    return { ok: true, value: { commentId: target.id, changed: false } };
  }

  const now = ports.now();
  const applied = await ports.adminTakedownComment({
    commentId: target.id,
    now,
    audit: {
      id: ports.newId(),
      actorId: request.actorId,
      action: ADMIN_AUDIT_ACTION.commentTakedown,
      targetType: ADMIN_AUDIT_TARGET.comment,
      targetId: target.id,
      detail: null,
      createdAt: now,
    },
  });
  if (!applied) {
    return { ok: true, value: { commentId: target.id, changed: false } };
  }
  return { ok: true, value: { commentId: target.id, changed: true } };
}

/**
 * 管理员恢复一条评论。**父帖已删除时拒绝**：恢复会让评论出现在一个公开侧不可见的
 * 帖子下面，与公开侧「详情不过滤 deleted_at、但渲染拒绝视图」的语义打架。
 */
export async function restoreComment(
  ports: AdminPorts,
  request: { actorId: string; actorRole: unknown; commentId: string },
): Promise<AdminOutcome<{ commentId: string; changed: boolean }>> {
  const access = requireAdminActor(request.actorRole);
  if (!access.ok) {
    return access;
  }
  const target = await ports.getAdminCommentById({ id: request.commentId });
  if (!target) {
    return { ok: false, failure: ADMIN_FAILURE.commentNotFound };
  }
  if (target.deletedAt === null) {
    return { ok: true, value: { commentId: target.id, changed: false } };
  }

  const parent = await ports.getAdminPostById({ id: target.postId });
  if (!parent) {
    return { ok: false, failure: ADMIN_FAILURE.postNotFound };
  }
  if (parent.deletedAt !== null) {
    return { ok: false, failure: ADMIN_FAILURE.parentPostDeleted };
  }

  const now = ports.now();
  const applied = await ports.adminRestoreComment({
    commentId: target.id,
    now,
    audit: {
      id: ports.newId(),
      actorId: request.actorId,
      action: ADMIN_AUDIT_ACTION.commentRestore,
      targetType: ADMIN_AUDIT_TARGET.comment,
      targetId: target.id,
      detail: null,
      createdAt: now,
    },
  });
  if (!applied) {
    return { ok: true, value: { commentId: target.id, changed: false } };
  }
  return { ok: true, value: { commentId: target.id, changed: true } };
}

/** 审计日志列表（时间倒序，含 M3 的社区审计行）。只有管理员能看。 */
export async function listAuditLogsForAdmin(
  ports: AdminPorts,
  request: { actorRole: unknown; page?: unknown },
): Promise<AdminOutcome<AdminPage<AuditLogListItem>>> {
  const access = requireAdminActor(request.actorRole);
  if (!access.ok) {
    return access;
  }
  const { limit, offset } = adminPageParams({ page: request.page });
  const items = await ports.listAuditLogsForAdmin({ limit, offset });
  return { ok: true, value: items };
}
