/**
 * 定期维护：删过期会话、删超出保留期的运行历史。
 *
 * ## 为什么在平台层而不是领域层
 *
 * 它是**数据卫生**，不是业务判定：删什么由事实决定（会话已经过期、运行历史早于保留期），
 * 留多久由配置给（`TOOL_RUN_RETENTION_DAYS`，见 `./env`），这里只把「现在几点」翻译成
 * 两条删除语句。没有一条规则需要「这是谁的」或「这个人能不能做」的判断，所以不属于
 * `@xsu/core`。
 *
 * ## 为什么和 `queue.ts` 分开放
 *
 * `queue.ts` 只管「怎么排队」，任务里做什么由消费者注入（见那里的文件头）。本文件就是
 * 被注入进去的那个「做什么」——消费者在 `apps/web/worker/handlers.ts`。
 *
 * ## 时间由调用方传入
 *
 * 清理窗口与调用方日志里的时间必须来自同一个「现在」：两处各取一次会出现「日志说删了
 * 30 天前的，实际删的是 30 天零几毫秒前的」。与 `@xsu/core` 的 `ToolRunPorts.now`
 * 是同一条约定。
 */
import { deleteExpiredSessions, deleteToolRunsOlderThan, getDb, type Database } from '@xsu/db';

import type { ServerEnv } from './env';

/** 一天的毫秒数。保留期以「天」配置，落库比较的是时刻。 */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 两条删除语句各自的时间界。
 *
 * 抽成纯函数是为了不连数据库就能验证它——这是本文件里唯一有分支的地方，其余部分只是
 * 两次仓储调用。
 */
export function cleanupCutoffs(params: { now: Date; retentionDays: number }): {
  sessionsBefore: Date;
  toolRunsBefore: Date;
} {
  /*
   * 保留期兜底成非负整数：负值会让 `toolRunsBefore` 落到未来，「保留 30 天」变成
   * 「删掉还没发生的记录」。配置层已经限定了范围（`./env` 的 `optionalCount`），
   * 这里再挡一次是因为这个函数是公开导出的，不该依赖调用点都先校验过。
   */
  const days = Math.max(0, Math.trunc(params.retentionDays));

  return {
    /** 会话：`expires_at < now` 即已过期，保留期为 0 天。 */
    sessionsBefore: params.now,
    toolRunsBefore: new Date(params.now.getTime() - days * MS_PER_DAY),
  };
}

/** 一次清理删掉的行数。调用方负责写日志——平台层不写日志。 */
export type CleanupResult = {
  /** 删掉的过期会话行数。 */
  sessions: number;
  /** 删掉的运行历史行数。 */
  toolRuns: number;
};

export type MaintenanceDeps = {
  env: ServerEnv;
  /** 默认取 `@xsu/db` 的共享连接；测试可传入独立的库。 */
  db?: Database;
  now?: () => Date;
};

/**
 * 执行一次清理。
 *
 * **两个删除互不影响地各跑一次**，不包在同一个事务里：它们删的是两类互不相关的行，
 * 事务只会让一次长删除拖住另一条语句。中途失败时前半段已经生效——清理是幂等的，
 * 下一次调度会接着删，所以「部分完成」在这里不是需要回滚的状态，而是正常的中间态。
 */
export async function runMaintenanceCleanup(deps: MaintenanceDeps): Promise<CleanupResult> {
  const db = deps.db ?? getDb();
  const now = deps.now?.() ?? new Date();
  const cutoffs = cleanupCutoffs({ now, retentionDays: deps.env.tools.retentionDays });

  const sessions = await deleteExpiredSessions(db, { before: cutoffs.sessionsBefore });
  const toolRuns = await deleteToolRunsOlderThan(db, { before: cutoffs.toolRunsBefore });

  return { sessions, toolRuns };
}
