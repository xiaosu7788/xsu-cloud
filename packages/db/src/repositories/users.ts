/**
 * 账号（`user` / `account`）仓储。
 *
 * 建用户与会话签发由 Better Auth 负责（见 `packages/platform`）。这里只提供它不做、
 * 而本项目必须自己做的两件事：
 *
 * - 列出某个用户名下绑定了哪些登录方式（账号绑定页与解除绑定前的检查要用）；
 * - 删除一个用户（邀请码注册回滚要用，见 `packages/core/src/registration.ts`）。
 *
 * 「最后一个可用登录方式不能解绑」这类判定**不在本文件**——它在 `@xsu/core`
 * 的 `checkAccountUnlinkable`。仓储只负责取到事实。
 */
import { eq } from 'drizzle-orm';

import type { Database } from '../client';
import { account, user } from '../schema/auth';

/**
 * 该用户名下绑定的登录方式。
 *
 * 只返回 `providerId`：口令散列与 token 没有进入领域层的必要（见 `packages/core/src/accounts.ts`
 * 的 `StoredAccount`）。排序固定，调用方拿到的顺序才稳定。
 */
export async function listAccountProviderIds(db: Database, userId: string): Promise<string[]> {
  const rows = await db
    .select({ providerId: account.providerId })
    .from(account)
    .where(eq(account.userId, userId))
    .orderBy(account.providerId);

  return rows.map((row) => row.providerId);
}

/**
 * 删除用户。`session` 与 `account` 上的外键都是 `ON DELETE CASCADE`，会跟着一起清掉。
 *
 * 用户不存在时**不算失败**：调用方（注册回滚）要的是「这个人不存在」这个结果状态，
 * 而不是「我删掉了一行」。把 0 行当成错误会让重试路径误报事故。
 */
export async function deleteUserById(db: Database, userId: string): Promise<void> {
  await db.delete(user).where(eq(user.id, userId));
}

/**
 * 这个 id 在库里是否真的存在。
 *
 * 存在的理由是一个反直觉的行为：开了 `requireEmailVerification` 之后，
 * 用已注册邮箱调 `auth.api.signUpEmail` 会返回 **HTTP 200 与一个合成用户**
 * （`better-auth@1.7.7` 的 `dist/api/routes/sign-up.mjs` 第 155、196-205 行），
 * 用来避免暴露「这个邮箱注册过没有」。所以调用方**不能**把拿到的用户当成已落库，
 * 必须回查一次。合成用户的 id 是新生成的随机值，不会命中。
 *
 * 查询只取主键，不做 `count(*)`：这里要的是「有没有」，代价要可预期。
 */
export async function userExists(db: Database, userId: string): Promise<boolean> {
  const rows = await db.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);

  return rows.length > 0;
}
