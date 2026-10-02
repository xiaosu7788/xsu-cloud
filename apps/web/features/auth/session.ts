/**
 * 会话读取与分区守卫（服务端）。
 *
 * `(console)` 与 `(admin)` 两个分区布局唯一的会话入口。收口在一处的理由：
 * 「角色每次请求从数据库读」这件事（`docs/PRD.md` 3.6 验收 4）只能在读会话的那一行保证，
 * 分散到各个布局里，迟早有人图省事改成从 cookie 或 token 里读角色。
 *
 * ## 为什么用 `cache()` 包一层
 *
 * 同一个请求里布局与页面都可能要用户信息。不加缓存就是两次数据库往返——Better Auth
 * 默认不启用会话 cookie 缓存（`packages/platform/src/auth.ts` 文件头写了为什么），
 * 每次 `getSession` 都真查库。`React.cache` 的生存期恰好是「一次请求」，不跨请求复用，
 * 因此不会把角色缓存成旧值；这与「不开 cookie 缓存」是同一条要求的两面。
 *
 *
 * ## 顺序：`headers()` 必须先于 `getAuth()`
 *
 * `headers()` 不只是读请求头——它是「这个页面必须在请求期渲染」的信号，Next 在预渲染
 * 阶段收到它就放弃静态化。`getAuth()` 相反，它会立刻校验服务端配置，缺配置时抛普通
 * `Error`。把两者合成一行 `getAuth().api.getSession({ headers: await headers() })`，
 * `getAuth()` 先求值，于是**构建期**先撞上配置校验：构建机没有生产密钥，`next build`
 * 因此失败，报错还看起来像配置问题，掩盖了「这本来是个动态页面」（M1 实跑遇到）。
 * 拆成两条语句、请求头在前，构建机就不需要任何服务端密钥。
 * ## 判定结果里带用户对象
 *
 * 布局既要知道「能不能进」，也要知道「是谁」（侧边栏底部要显示名字与邮箱）。只返回
 * `AccessDecision` 的话，`allowed: true` 并不让 TypeScript 相信用户存在——判定函数只看
 * 角色字符串——调用方于是只能写 `!` 断言或再判一次空。因此这里把两者合成一个联合类型
 * （`PartitionAccess`），放行分支上用户必然可取。
 *
 * ## 角色取值
 *
 * `role` 是 Better Auth 的 `additionalFields` 加上去的（同见 `packages/platform/src/auth.ts`），
 * 解析一律交给 `@xsu/core` 的 `readRole`：拿不到合法值时返回 `null`，
 * 于是「字段缺失」「值不在枚举里」与「未登录」得到一致的拒绝，
 * 而不会被当成某个默认角色放行。
 */
import { cache } from 'react';
import { headers } from 'next/headers';

import {
  ACCESS_DENIED,
  decideAdminAccess,
  decideConsoleAccess,
  readRole,
  type AccessDecision,
  type AccessDenial,
  type Role,
} from '@xsu/core';
import { getAuth } from '@xsu/platform';

/** 当前登录用户。只带布局与菜单需要的字段，不把整个 user 对象暴露出去。 */
export type SessionUser = {
  id: string;
  name: string;
  email: string;
  /** 已收口：非法值在这里就是 `null`，不会流到判定函数里被当成有效角色。 */
  role: Role | null;
};

/**
 * 读当前请求的会话。
 *
 * 未登录返回 `null` 而不是抛错——调用方对「没登录」和「登录了但没权限」的处理完全不同
 * （前者去登录页，后者给拒绝页）。
 */
export const readSessionUser = cache(async (): Promise<SessionUser | null> => {
  // 顺序不能调换（见文件头）：先读请求头，Next 才会把本页面判成动态。
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session?.user) return null;

  const { user } = session;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: readRole((user as { role?: unknown }).role),
  };
});

/** 分区守卫的判定结果：放行时连带给出「是谁」。 */
export type PartitionAccess =
  { allowed: true; user: SessionUser; role: Role } | { allowed: false; denial: AccessDenial };

/**
 * 把「会话」与「角色判定」合成一个结果。
 *
 * 「判定放行但拿不到用户」在当前的判定函数下不可能出现（合法角色只能来自一个存在的会话），
 * 这里仍然显式处理并按**未登录**收场：哪天判定函数被放宽，挡住的是一个没有身份的界面，
 * 而不是把它当 403 放过去。
 */
function toPartitionAccess(user: SessionUser | null, decision: AccessDecision): PartitionAccess {
  if (decision.allowed && user) return { allowed: true, user, role: decision.role };
  return {
    allowed: false,
    denial: decision.allowed ? ACCESS_DENIED.unauthenticated : decision.denial,
  };
}

/** `(console)` 的判定结果：任何合法角色都放行，未登录给 401。 */
export async function readConsoleAccess(): Promise<PartitionAccess> {
  const user = await readSessionUser();
  return toPartitionAccess(user, decideConsoleAccess(user?.role ?? null));
}

/** `(admin)` 的判定结果：只有 `admin`。未登录给 401，登录了但不是管理员给 403。 */
export async function readAdminAccess(): Promise<PartitionAccess> {
  const user = await readSessionUser();
  return toPartitionAccess(user, decideAdminAccess(user?.role ?? null));
}
