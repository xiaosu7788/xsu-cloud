/**
 * 权限判定：谁能进入哪个路由分区。
 *
 * 「判定」属于领域层（`docs/ARCHITECTURE.md` 2.1），所以这里只吃一个角色字符串，
 * 返回一个可判定的结论；怎么把结论翻译成响应（重定向 / 403 页面 / JSON）由表现层与应用层决定。
 *
 * 两条必须一起看的设计约束：
 *
 * 1. **拒绝响应必须是同一个形状。** `docs/ROADMAP.md` M1 退出标准要求非管理员访问 `(admin)`
 *    得到「统一拒绝响应」。所有拒绝都从 `ACCESS_DENIED` 取值，不允许各处自己写文案与状态码。
 * 2. **角色必须每次请求从数据库读。** `docs/PRD.md` 3.6 验收 4 要求角色变更后权限立即生效。
 *    因此 `packages/platform` 的 auth 配置里**不启用会话 cookie 缓存**——把角色塞进 cookie
 *    就等于给了它一段过期时间内的旧值。这条决定的完整理由写在
 *    `packages/platform/src/auth.ts` 的文件头（`docs/SECURITY.md` 尚未建立，见
 *    `docs/ROADMAP.md` 第 5 节）。
 */
import { DEFAULT_ROLE, ROLES } from '@xsu/db/schema';

export { DEFAULT_ROLE, ROLES };

/** 角色取值。事实来源是数据层的 `user.role` 列，不要在别处另写一份。 */
export type Role = (typeof ROLES)[number];

/** 管理员角色常量。判权限一律用它，不要写字符串字面量。 */
export const ADMIN_ROLE = 'admin' satisfies Role;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isAdmin(role: unknown): boolean {
  return role === ADMIN_ROLE;
}

/**
 * 统一拒绝响应表。
 *
 * `status` 与 `code` 供应用层直接组装 HTTP 响应；`message` 是给用户看的中文文案。
 * 新增一种拒绝原因时加在这里，不要在调用点就地造。
 */
export const ACCESS_DENIED = {
  /** 没登录，或会话已失效。 */
  unauthenticated: {
    status: 401,
    code: 'UNAUTHENTICATED',
    message: '请先登录后再访问。',
  },
  /** 登录了，但角色不够。 */
  forbidden: {
    status: 403,
    code: 'FORBIDDEN',
    message: '当前账号没有访问该区域的权限。',
  },
} as const;

export type AccessDenial = (typeof ACCESS_DENIED)[keyof typeof ACCESS_DENIED];

export type AccessDecision =
  { allowed: true; role: Role } | { allowed: false; denial: AccessDenial };

/** 未登录时不会有角色，返回 null 而不是猜一个默认值。 */
export function readRole(role: unknown): Role | null {
  return isRole(role) ? role : null;
}

/** `(console)`：登录后可见。未登录给 401，由应用层决定重定向还是直接回响应。 */
export function decideConsoleAccess(role: unknown): AccessDecision {
  const actual = readRole(role);
  return actual
    ? { allowed: true, role: actual }
    : { allowed: false, denial: ACCESS_DENIED.unauthenticated };
}

/** `(admin)`：只有 `admin`。未登录给 401，登录了但不是管理员给 403。 */
export function decideAdminAccess(role: unknown): AccessDecision {
  const actual = readRole(role);
  if (!actual) {
    return { allowed: false, denial: ACCESS_DENIED.unauthenticated };
  }
  if (!isAdmin(actual)) {
    return { allowed: false, denial: ACCESS_DENIED.forbidden };
  }
  return { allowed: true, role: actual };
}
