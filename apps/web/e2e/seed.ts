/**
 * 端到端夹具：造出用例需要的账号。
 *
 * ## 为什么这里可以直接 import `@xsu/db`
 *
 * `docs/ARCHITECTURE.md` 2.2 规定应用层不自己 import `@xsu/db` 取连接，要走
 * `@xsu/platform`。本文件不属于应用层——它不在任何请求路径上，是**构建与验证侧的脚本**，
 * 与 `packages/db` 的 `db:migrate`、`db:studio` 同一性质。规则要守的是「请求处理时的
 * 依赖方向」，不是「任何地方都不许碰数据层」。同时它也不可能违反分层：没有任何生产代码
 * import 它。
 *
 * ## 走的是真实路径，只有一处例外
 *
 * 建号走 `@xsu/core` 的 `registerWithInvite`（真编排）→ `@xsu/platform` 的适配器 →
 * Better Auth 的 `auth.api.signUpEmail`（真口令散列）→ 真库，与用户点注册按钮是同一条路。
 *
 * 唯一的例外是**邮箱验证**：`requireEmailVerification` 打开时未验证的账号不能登录，
 * 而验证链接里那个 token 是 Better Auth 用密钥签出来的 JWT，**不落库**，只在邮件正文里
 * 出现一次。本项目的邮件传输是控制台实现（`packages/platform/src/mail.ts`），链接打在
 * 注册进程的 stdout 上——夹具与服务器不是同一个进程，取不到。所以这里直接把
 * `emailVerified` 置为真。
 *
 * 代价：**「点邮件里的链接完成验证」这条路径没有被端到端覆盖**，它只被 M1 的手工实测
 * 走过一次。这条记在 `docs/ROADMAP.md` 的已知债务里。不要去抓 stdout 里那行链接来
 * 伪装覆盖——那会让测试依赖一段给开发者看的日志格式。
 */
import { randomUUID } from 'node:crypto';

import { registerWithInvite } from '@xsu/core';
import { deleteUserById, getDb, invites } from '@xsu/db';
import { createRegistrationPorts, ensureDotEnvLoaded, getAuth } from '@xsu/platform';

import { NON_ADMIN } from './env';

/** 数据层的连接失败是环境问题，报错要能把人引到正确的下一步。 */
function explainDatabaseFailure(error: unknown): Error {
  return new Error(
    `端到端夹具连不上数据库：${String(error)}\n` +
      '先启动本地 Postgres 并跑迁移：\n' +
      '  docker compose -f docker/docker-compose.yml up -d postgres\n' +
      '  pnpm --filter @xsu/db db:migrate\n' +
      '并确认仓库根目录的 .env 里有 DATABASE_URL（见 README「本地开发」）。',
  );
}

/**
 * 准备好非管理员账号，并把它置为「邮箱已验证」。可重复执行。
 *
 * 幂等靠「先删后建」而不是「存在就跳过」：口令散列与邀请码消费都必须真实发生一次，
 * 跳过就等于这一轮跑在一份不知道多久以前留下的数据上。`invites.used_by` 的外键是
 * `ON DELETE SET NULL`，删用户不会连累邀请码行，也不会阻塞删除。
 */
export async function seedNonAdmin(): Promise<void> {
  /*
   * `.env` 的载入点只有 `@xsu/platform` 一处（`packages/platform/src/env.ts`）。
   * 夹具在 Next 之外运行，没有框架帮忙载入，所以显式调一次。
   */
  ensureDotEnvLoaded();

  const db = getDb();
  const auth = getAuth();

  let existing: Awaited<ReturnType<typeof findExisting>>;
  try {
    existing = await findExisting();
  } catch (error) {
    throw explainDatabaseFailure(error);
  }

  if (existing) {
    await deleteUserById(db, existing.id);
  }

  /** 每个码只用一次，所以每轮都新建一个：固定码在第二次运行时会判定为「已使用」。 */
  const code = `E2E-${randomUUID()}`;
  await db.insert(invites).values({ id: randomUUID(), code });

  const outcome = await registerWithInvite(createRegistrationPorts({ db, auth }), {
    name: NON_ADMIN.name,
    email: NON_ADMIN.email,
    password: NON_ADMIN.password,
    inviteCode: code,
  });

  if (!outcome.ok) {
    throw new Error(
      `端到端夹具注册失败：${outcome.failure.code} ${outcome.failure.message}` +
        '（这条路径与用户注册相同，失败说明注册编排或环境配置有问题，不是夹具的问题。）',
    );
  }

  await markEmailVerified();

  /*
   * 用 Better Auth 自己的适配器而不是 `@xsu/db` 的 SQL：字段名到列的映射（`emailVerified`
   * → `email_verified`）由库的 schema 决定，手写 UPDATE 会在列名变化时静默写错地方。
   */
  async function findExisting(): Promise<{ id: string } | null> {
    const found = await (await auth.$context).internalAdapter.findUserByEmail(NON_ADMIN.email);
    return found ? { id: found.user.id } : null;
  }

  async function markEmailVerified(): Promise<void> {
    await (
      await auth.$context
    ).internalAdapter.updateUserByEmail(NON_ADMIN.email, {
      emailVerified: true,
    });
  }
}
