/**
 * 端到端夹具：造出一条**别人的**运行记录。
 *
 * ## 为什么非要一条别人的记录
 *
 * `docs/PRD.md` 3.3 验收 4 是「用户只能看到自己的运行历史」，`docs/ROADMAP.md` M2 退出标准 2
 * 要求它「有测试覆盖」。领域层那一半在 `packages/core/tests/tools.test.ts`（代入两个 userId
 * 判 `decideToolRunAccess`）；端到端这一半要验的是另一件事：**真库里的他人数据不会经由页面
 * 泄漏**。库里没有一条真实存在的他人记录时，这条用例只能断言「随便一个 id 打不开」——那验的
 * 是「这条 id 不存在」（`getToolRunById` 查不到），不是「别人的记录打不开」。
 *
 * ## 这条记录的 slug 故意取一个不在注册表里的值
 *
 * 运行历史列表只渲染工具名（`features/tools/format.ts` 的 `toolDisplayName`），真实工具跑出来
 * 的记录在列表里与本人记录长得一模一样：都是「文本统计 · 成功 · 1 ms · 11 B」。要让「列表按人
 * 收窄」这件事可断言，就需要一个**看得见的标识**。已下架工具的 slug 正好提供它——`toolDisplayName`
 * 取不到时原样返回 slug，于是这条记录一旦泄漏进列表，slug 原文就会出现在页面上；同时「下架工具
 * 的旧记录仍能打开、只是没有执行入口」这条分支在端到端里本来没有别的办法造出来，一并覆盖。
 *
 * ## 因此它直接写仓储，不走 `runTool`
 *
 * 上面那条决定了它不能走 `runTool`：领域层会拒掉未注册的 slug（`TOOL_FAILURE.toolNotFound`），
 * 而那条规则本身是我们要保住的。所以这里直接调 `@xsu/db` 的 `insertToolRun`——与 `./seed.ts`
 * 直接 import `@xsu/db` 是同一条理由：本文件是构建/验证侧脚本，不在任何请求路径上，也没有生产
 * 代码 import 它。
 *
 * 账号仍然走真实的注册编排：`tool_runs.user_id` 是指向 `user.id` 的外键，硬编码一个不存在的 id
 * 只会得到外键错误。这个账号**从不登录**，因此不需要 `emailVerified`——`./seed.ts` 文件头里那条
 * 「验证链接取不到」的例外在这里不存在。
 *
 * ## 记录里的内容也是唯一的
 *
 * `marker` 既当输入摘要又当断言的靶子：它出现在拒绝对应视图上就等于内容泄漏。用随机后缀而不是
 * 固定字符串，是为了让「上一次跑留下的记录还没被删」这种情形不会把断言变成假绿。
 */
import { randomUUID } from 'node:crypto';

import { registerWithInvite } from '@xsu/core';
import { deleteUserById, getDb, insertToolRun, invites } from '@xsu/db';
import { createRegistrationPorts, ensureDotEnvLoaded, getAuth } from '@xsu/platform';

import { OTHER_USER } from './env';

/** 不在注册表里的 slug。存在的意义就是「一眼可辨」，理由见文件头。 */
export const FOREIGN_TOOL_SLUG = 'e2e-retired-tool';

/** 造出来的那条他人记录。 */
export type ForeignToolRun = {
  /** 运行记录 id。用例要拿它拼详情页地址。 */
  runId: string;
  /** 记录归属的账号。用例不断言它，留着是为了排查时能直接去库里查这条记录。 */
  userId: string;
  /** 那条记录的 slug，也就是「一旦泄漏就会出现在列表里」的那个字符串。 */
  toolSlug: string;
  /** 输入摘要里的唯一标记，用来断言详情页没有把内容吐出来。 */
  marker: string;
};

/**
 * 数据层或队列不可达是环境问题，报错要能把人引到正确的下一步。
 *
 * 与 `./seed.ts` 那份不同的地方是多提了 Redis：`registerWithInvite` 的邮件通过队列投递
 * （`packages/platform/src/queue.ts`），注册链路因此对 Redis 有硬依赖。
 */
function explainEnvironmentFailure(error: unknown): Error {
  return new Error(
    `端到端夹具连不上数据库：${String(error)}\n` +
      '先启动本地依赖并跑迁移：\n' +
      '  docker compose -f docker/docker-compose.yml up -d postgres redis\n' +
      '  pnpm --filter @xsu/db db:migrate\n' +
      '并确认仓库根目录的 .env 里有 DATABASE_URL 与 REDIS_URL（见 README「本地开发」）。',
  );
}

/**
 * 准备好「他人账号」并造出一条归属它的运行记录。可重复执行。
 *
 * 幂等靠「先删后建」而不是「存在就跳过」，与 `./seed.ts` 同一条理由：口令散列与邀请码消费都
 * 应该真实发生一次。删用户会连带删掉它的 `tool_runs` 行（schema 里是 `ON DELETE CASCADE`），
 * 所以上一轮留下的那条记录不会积在库里；`invites.used_by` 是 `ON DELETE SET NULL`，删用户不会
 * 连累邀请码行，也不会阻塞删除。
 */
export async function seedForeignToolRun(): Promise<ForeignToolRun> {
  /* `.env` 的载入点只有 `@xsu/platform` 一处；夹具在 Next 之外运行，显式调一次。 */
  ensureDotEnvLoaded();

  const db = getDb();
  const auth = getAuth();

  let existing: { id: string } | null;
  try {
    const found = await (await auth.$context).internalAdapter.findUserByEmail(OTHER_USER.email);
    existing = found ? { id: found.user.id } : null;
  } catch (error) {
    throw explainEnvironmentFailure(error);
  }

  if (existing) {
    await deleteUserById(db, existing.id);
  }

  /** 每个码只用一次，所以每轮都新建一个（固定码在第二次运行时会判定为「已使用」）。 */
  const code = `E2E-${randomUUID()}`;
  await db.insert(invites).values({ id: randomUUID(), code });

  const outcome = await registerWithInvite(createRegistrationPorts({ db, auth }), {
    name: OTHER_USER.name,
    email: OTHER_USER.email,
    password: OTHER_USER.password,
    inviteCode: code,
  });

  if (!outcome.ok) {
    throw new Error(
      `端到端夹具注册「他人账号」失败：${outcome.failure.code} ${outcome.failure.message}` +
        '（这条路径与用户注册相同，失败说明注册编排或环境配置有问题，不是夹具的问题。）',
    );
  }

  const marker = `xsu-foreign-${randomUUID().slice(0, 8)}`;
  const runId = randomUUID();

  await insertToolRun(db, {
    id: runId,
    userId: outcome.userId,
    toolSlug: FOREIGN_TOOL_SLUG,
    status: 'succeeded',
    errorCode: null,
    inputBytes: new TextEncoder().encode(marker).length,
    outputBytes: null,
    durationMs: 0,
    inputSummary: marker,
    outputSummary: null,
    createdAt: new Date(),
  });

  return { runId, userId: outcome.userId, toolSlug: FOREIGN_TOOL_SLUG, marker };
}
