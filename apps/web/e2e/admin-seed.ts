/**
 * 端到端夹具：造出一个可登录的管理员账号。
 *
 * 管理员提升只发生在验证侧：注册仍然走真实的邀请码编排，邮箱验证按现有 e2e 约定
 * 直接标记完成，最后通过 Better Auth 的内部适配器写入 role。生产请求路径没有任何
 * 「注册时可提交 role」的旁路。
 */
import { randomUUID } from 'node:crypto';

import { registerWithInvite } from '@xsu/core';
import { getDb, invites } from '@xsu/db';
import { createRegistrationPorts, ensureDotEnvLoaded, getAuth } from '@xsu/platform';

import { ADMIN } from './env';

function explainDatabaseFailure(error: unknown): Error {
  return new Error(
    `端到端管理员夹具连不上数据库：${String(error)}\n` +
      '先启动本地依赖并跑迁移：\n' +
      '  docker compose -f docker/docker-compose.yml up -d postgres redis\n' +
      '  pnpm --filter @xsu/db db:migrate\n' +
      '并确认仓库根目录的 .env 里有 DATABASE_URL 与 REDIS_URL（见 README「本地开发」）。',
  );
}

/**
 * 可重复执行：账号已存在时复用并幂等确保邮箱验证标记与 role，只有库中没有该账号时
 * 才走真实注册编排新造一个。
 *
 * 这里刻意不做「先删后建」（`seed.ts` 的普通账号那样）：管理员是 `audit_logs` 的
 * actor（M3 只有管理员动作写审计），`actor_id` 外键是 ON DELETE CASCADE——删用户
 * 会级联删审计行，被审计触发器拦截，夹具在第二轮必挂（上一轮 e2e 给该账号留过
 * `report.takedown` 审计行，重跑即复现）。复用路径口令保持不变，登录验证仍走真实
 * 凭据；updateUserByEmail 幂等，重复执行只重写相同值。
 */
export async function seedAdmin(): Promise<void> {
  ensureDotEnvLoaded();

  const db = getDb();
  const auth = getAuth();

  let existing: { id: string } | null;
  try {
    const found = await (await auth.$context).internalAdapter.findUserByEmail(ADMIN.email);
    existing = found ? { id: found.user.id } : null;
  } catch (error) {
    throw explainDatabaseFailure(error);
  }

  if (existing) {
    await (
      await auth.$context
    ).internalAdapter.updateUserByEmail(ADMIN.email, {
      emailVerified: true,
      role: 'admin',
    });
    return;
  }

  const code = `E2E-${randomUUID()}`;
  await db.insert(invites).values({ id: randomUUID(), code });

  const outcome = await registerWithInvite(createRegistrationPorts({ db, auth }), {
    name: ADMIN.name,
    email: ADMIN.email,
    password: ADMIN.password,
    inviteCode: code,
  });

  if (!outcome.ok) {
    throw new Error(
      `端到端管理员夹具注册失败：${outcome.failure.code} ${outcome.failure.message}` +
        '（这条路径与用户注册相同，失败说明注册编排或环境配置有问题。）',
    );
  }

  const context = await auth.$context;
  await context.internalAdapter.updateUserByEmail(ADMIN.email, {
    emailVerified: true,
    role: 'admin',
  });
}
