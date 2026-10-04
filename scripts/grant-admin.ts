/**
 * 把指定邮箱提升为 `admin` —— 首个管理员的唯一来源。
 *
 * 提升为管理员「只能由管理员在后台操作，且必须写审计日志」（红线 8）在 M5 才有界面；
 * 在那之前世界上第一个 admin 从哪来？只能直接改库。本脚本就是这条受控通道：
 * 它连库、不经过应用，每次执行都留在操作者自己的终端历史里
 * （[`docs/DATA-MODEL.md`](../docs/DATA-MODEL.md) 第 5.3 节）。
 *
 * **不写 `audit_logs`**：该表的 `target_type` 只覆盖 `post | comment`
 * （`packages/db/src/schema/community.ts`），用户不是合法目标；给账号提权写审计属于
 * M5 后台的职责，到时候连本脚本一起退役。
 *
 * 用法：
 *   pnpm exec tsx scripts/grant-admin.ts <email>
 *
 * 幂等：用户不存在 → 报错退出码 1；已经是 `admin` → 提示后退出码 0，可以放心重跑。
 * `.env` 由 `ensureDotEnvLoaded()` 载入（`packages/platform/src/env.ts` 规则 2），
 * `DATABASE_URL` 的解释权在 `@xsu/db`（`packages/db/src/client.ts`）。
 *
 * 走 `@xsu` 各包的**源文件**而不是包名：仓库根不装依赖，包名从 `scripts/` 解析不到
 * （同 `scripts/enqueue-manual-jobs.ts` 的写法）。也因此不直接 import `drizzle-orm`——
 * 它从 `scripts/` 向上解析不到；原生 SQL 走 `createDbClient` 返回的 postgres.js 客户端，
 * 连接参数与池上限沿用 `@xsu/db` 的既有决定。
 */
import { ADMIN_ROLE, ROLES } from '../packages/core/src/index';
import { createDbClient } from '../packages/db/src/index';
import { ensureDotEnvLoaded } from '../packages/platform/src/index';

async function main(): Promise<void> {
  ensureDotEnvLoaded();

  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error('[grant-admin] 用法：pnpm exec tsx scripts/grant-admin.ts <email>');
    process.exit(1);
  }

  /* max: 1：一次性任务，避免连接数抖动（client.ts 对这一档的既有注释）。 */
  const { client } = createDbClient({ max: 1 });
  try {
    /* `"user"` 要加引号：不带引号会被当成关键字。 */
    const [found] = await client`
      select id, role from "user" where email = ${email} limit 1
    `;
    if (!found) {
      // 用户不存在不静默：把「邮箱敲错」当成「提权成功」比失败严重得多。
      console.error(`[grant-admin] 用户不存在：${email}`);
      process.exitCode = 1;
      return;
    }
    if (found.role === ADMIN_ROLE) {
      console.log(`[grant-admin] ${email} 已经是 ${ADMIN_ROLE}，无需变更`);
      return;
    }

    await client`
      update "user" set role = ${ADMIN_ROLE} where id = ${found.id}
    `;
    console.log(`[grant-admin] ${email}: ${found.role} → ${ADMIN_ROLE}（id=${found.id}）`);
    console.log(
      `[grant-admin] 合法取值：${ROLES.join(' / ')}；该操作已记录在你的终端历史里（非审计日志）`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

await main();
