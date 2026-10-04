/**
 * 用户管理：搜索列表、角色变更、封禁与解封。
 *
 * 写入口的执行顺序（`SPEC-admin.md` 3.2）：管理员 → 目标存在 → 输入合法 →
 * 防自锁前置（不能改自己的角色 / 不能封自己）→ 幂等短路（已在目标状态 →
 * `changed:false`，**不写审计**）→ 条件写 + 审计同事务。
 *
 * `lastAdmin` 防线不在领域层数人头，而在数据层条件 UPDATE 的 WHERE 里
 * （「还有别的管理员」的 EXISTS 与「未被封禁」由 SQL 兜底）：两个管理员同时操作时
 * 只有一个能真的改成，另一个拿到 0 行 → `lastAdmin`。端口返回 `false` 的其余竞态
 * 也归到同一个失败码——这是已接受的简化（SPEC 7 节）。
 */
import {
  ADMIN_AUDIT_ACTION,
  ADMIN_FAILURE,
  type AdminOutcome,
  type AdminPage,
  type AdminPorts,
  type AdminUserView,
} from './types';
import {
  ADMIN_AUDIT_TARGET,
  adminPageParams,
  banDetail,
  normalizeAdminQuery,
  normalizeRoleInput,
  requireAdminActor,
  roleChangeDetail,
  validateBanReason,
} from './rules';
import type { Role } from '../access';

/** 用户列表。`query` 非空时按邮箱 / 名字模糊匹配；包含被封禁用户（后台要能看见他们）。 */
export async function listUsersForAdmin(
  ports: AdminPorts,
  request: { actorRole: unknown; query: unknown; page?: unknown },
): Promise<AdminOutcome<AdminPage<AdminUserView>>> {
  const access = requireAdminActor(request.actorRole);
  if (!access.ok) {
    return access;
  }
  const { limit, offset } = adminPageParams({ page: request.page });
  const items = await ports.listUsersForAdmin({
    query: normalizeAdminQuery(request.query) ?? '',
    limit,
    offset,
  });
  return { ok: true, value: items };
}

/**
 * 改角色。与社区审核同构：领域层预检给出明确失败码，数据层条件 UPDATE 兜并发。
 * 幂等（目标已在角色里）返回 `changed:false`，不写第二行审计。
 */
export async function updateUserRole(
  ports: AdminPorts,
  request: { actorId: string; actorRole: unknown; userId: string; role: unknown },
): Promise<AdminOutcome<{ userId: string; role: Role; changed: boolean }>> {
  const access = requireAdminActor(request.actorRole);
  if (!access.ok) {
    return access;
  }
  const target = await ports.getAdminUserById({ id: request.userId });
  if (!target) {
    return { ok: false, failure: ADMIN_FAILURE.userNotFound };
  }
  // 防自锁第一规则：改自己的角色（含给自己升权）一律拒绝，路径只有「另一个管理员来改」。
  if (target.id === request.actorId) {
    return { ok: false, failure: ADMIN_FAILURE.selfRoleChange };
  }
  const role = normalizeRoleInput(request.role);
  if (!role) {
    return { ok: false, failure: { ...ADMIN_FAILURE.inputInvalid, field: 'role' } };
  }
  if (target.role === role) {
    return { ok: true, value: { userId: target.id, role, changed: false } };
  }

  const now = ports.now();
  const applied = await ports.updateUserRole({
    userId: target.id,
    role,
    audit: {
      id: ports.newId(),
      actorId: request.actorId,
      action: ADMIN_AUDIT_ACTION.userRoleUpdate,
      targetType: ADMIN_AUDIT_TARGET.user,
      targetId: target.id,
      detail: roleChangeDetail({ from: target.role, to: role }),
      createdAt: now,
    },
  });
  if (!applied) {
    // WHERE 里的「还有别的管理员」EXISTS 没让开：目标是最后一名管理员（或竞态下刚好只剩他）。
    return { ok: false, failure: ADMIN_FAILURE.lastAdmin };
  }
  return { ok: true, value: { userId: target.id, role, changed: true } };
}

/** 封禁：写 `banned_at` / `ban_reason` 并删掉该用户全部会话（同事务，端口职责）。 */
export async function banUser(
  ports: AdminPorts,
  request: { actorId: string; actorRole: unknown; userId: string; reason: unknown },
): Promise<AdminOutcome<{ userId: string; changed: boolean }>> {
  const access = requireAdminActor(request.actorRole);
  if (!access.ok) {
    return access;
  }
  const target = await ports.getAdminUserById({ id: request.userId });
  if (!target) {
    return { ok: false, failure: ADMIN_FAILURE.userNotFound };
  }
  // 防自锁第二规则。封其他管理员整体走不通：条件 UPDATE 只放行 `role <> 'admin'` 的目标，
  // 对管理员的封禁会拿到 0 行 → `lastAdmin`（先降权再封禁，两步都留审计）。
  if (target.id === request.actorId) {
    return { ok: false, failure: ADMIN_FAILURE.selfBan };
  }
  const reason = validateBanReason(request.reason);
  if (!reason.ok) {
    return reason;
  }
  if (target.bannedAt !== null) {
    return { ok: true, value: { userId: target.id, changed: false } };
  }

  const now = ports.now();
  const applied = await ports.banUser({
    userId: target.id,
    reason: reason.reason,
    audit: {
      id: ports.newId(),
      actorId: request.actorId,
      action: ADMIN_AUDIT_ACTION.userBan,
      targetType: ADMIN_AUDIT_TARGET.user,
      targetId: target.id,
      detail: banDetail(reason.reason),
      createdAt: now,
    },
  });
  if (!applied) {
    return { ok: false, failure: ADMIN_FAILURE.lastAdmin };
  }
  return { ok: true, value: { userId: target.id, changed: true } };
}

/** 解封：清 `banned_at` / `ban_reason`。被删掉的会话不会回来，用户需要重新登录。 */
export async function unbanUser(
  ports: AdminPorts,
  request: { actorId: string; actorRole: unknown; userId: string },
): Promise<AdminOutcome<{ userId: string; changed: boolean }>> {
  const access = requireAdminActor(request.actorRole);
  if (!access.ok) {
    return access;
  }
  const target = await ports.getAdminUserById({ id: request.userId });
  if (!target) {
    return { ok: false, failure: ADMIN_FAILURE.userNotFound };
  }
  if (target.bannedAt === null) {
    return { ok: true, value: { userId: target.id, changed: false } };
  }

  const now = ports.now();
  const applied = await ports.unbanUser({
    userId: target.id,
    audit: {
      id: ports.newId(),
      actorId: request.actorId,
      action: ADMIN_AUDIT_ACTION.userUnban,
      targetType: ADMIN_AUDIT_TARGET.user,
      targetId: target.id,
      detail: null,
      createdAt: now,
    },
  });
  // 0 行只可能是并发下已被解封（解封没有 lastAdmin 问题）：结果与幂等短路相同。
  return { ok: true, value: { userId: target.id, changed: applied } };
}
