/**
 * 工具箱仓储：运行历史（`tool_runs`）与收藏（`tool_favorites`）。
 *
 * 只做数据访问：SQL、并发正确性、字段投影。**判定与规则不在这里** ——
 * 「这次执行该不该放行、算不算超配额、摘要怎么截断脱敏」都在 `@xsu/core` 的
 * `src/tools/`，这里只负责把事实取回来、把结果落下去。
 *
 * 三条贯穿本文件的约定：
 *
 * 1. **时间点由调用方传入**（`now` / `since`），不用 SQL 的 `now()`。领域层的配额判定
 *    与落库的 `created_at` 必须是同一个时间点，否则「算的时候没超、写下去就超了」。
 * 2. **所有按用户收窄的查询都带 `user_id` 条件**，即使领域层已经判定过归属。
 *    这是纵深防御：SQL 里少一个条件，下次有人绕过领域层直连仓储就会漏数据。
 * 3. **计数与清理用一条 CTE 语句完成**，不「先查再删」。
 * 4. **比较时间必须走列的类型映射**，不能把裸 `Date` 直接插进 `sql` 模板。驱动是
 *    `postgres.js`，它在 Bind 阶段会对参数做 `Buffer.byteLength`，拿到 `Date` 直接抛
 *    `ERR_INVALID_ARG_TYPE`。写成 `lt(列, 日期)` 就会带上该列的类型转换，到驱动手上已经是
 *    ISO 字符串。
 * 5. **裸 `sql` 模板里的括号没人替你检查。** 这两条语句曾在真实库上失败过，而且是**两个
 *    缺陷叠在一起**：Bind 阶段的类型错误先抛，把紧随其后的 `syntax error`（`with ... as (`
 *    少了闭合括号）挡住了，于是「只修类型映射仍然失败」。裸模板躲得过编译器，只能靠对着
 *    真实库实跑来发现——M2 现场验证就是这么抓到的，回归步骤见 `docs/TESTING.md`。
 */
import { and, count, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { session } from '../schema/auth';
import {
  type ToolRunDetail,
  type ToolRunListItem,
  type ToolRunStatus,
  toolFavorites,
  toolRunDetailColumns,
  toolRunListColumns,
  toolRuns,
} from '../schema/tools';

/** 落一行运行历史所需的全部字段。由应用层把领域层结果翻译成这个形状。 */
export type NewToolRun = {
  id: string;
  userId: string;
  toolSlug: string;
  status: ToolRunStatus;
  errorCode: string | null;
  inputBytes: number;
  outputBytes: number | null;
  durationMs: number;
  inputSummary: string | null;
  outputSummary: string | null;
  createdAt: Date;
};

/** 运行历史一页最多取多少条。分页上限写在这里，避免调用方随手传个大数。 */
export const TOOL_RUN_PAGE_SIZE_MAX = 100;

/**
 * 该用户在 `since`（含）之后执行了多少次。
 *
 * 配额判定用的是这个数，所以它**必须走 `tool_runs_user_created_idx`**：
 * `WHERE user_id = ? AND created_at >= ?` 正是该索引的前缀。
 */
export async function countToolRunsSince(
  db: Database,
  params: { userId: string; since: Date },
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(toolRuns)
    .where(and(eq(toolRuns.userId, params.userId), gte(toolRuns.createdAt, params.since)));

  return rows[0]?.value ?? 0;
}

/** 落一行运行历史。**成功与失败都落**，失败行带 `errorCode`。 */
export async function insertToolRun(db: Database, run: NewToolRun): Promise<void> {
  await db.insert(toolRuns).values(run);
}

/**
 * 某个用户的运行历史，按时间倒序取一页。
 *
 * 排序里带上 `id` 做第二排序键：`created_at` 相同时（同一毫秒内的连续调用）顺序才稳定，
 * 否则翻页会看到重复或漏掉的记录。
 */
export async function listToolRuns(
  db: Database,
  params: { userId: string; limit: number },
): Promise<ToolRunListItem[]> {
  const limit = Math.min(Math.max(Math.trunc(params.limit), 1), TOOL_RUN_PAGE_SIZE_MAX);

  return db
    .select(toolRunListColumns)
    .from(toolRuns)
    .where(eq(toolRuns.userId, params.userId))
    .orderBy(desc(toolRuns.createdAt), desc(toolRuns.id))
    .limit(limit);
}

/**
 * 单条运行记录。**按 id + user_id 一起查。**
 *
 * 不属于该用户时返回 null，而不是「先查出来再让领域层拒绝」：能少取一份他人数据就少取一份。
 * 领域层的归属判定仍然要做（`decideToolRunAccess`），它负责给出统一拒绝响应。
 */
export async function getToolRunById(
  db: Database,
  params: { id: string; userId: string },
): Promise<ToolRunDetail | null> {
  const rows = await db
    .select(toolRunDetailColumns)
    .from(toolRuns)
    .where(and(eq(toolRuns.id, params.id), eq(toolRuns.userId, params.userId)))
    .limit(1);

  return rows[0] ?? null;
}

/** 该用户收藏了哪些工具。顺序固定（slug 升序），页面渲染才稳定。 */
export async function listToolFavoriteSlugs(
  db: Database,
  params: { userId: string },
): Promise<string[]> {
  const rows = await db
    .select({ toolSlug: toolFavorites.toolSlug })
    .from(toolFavorites)
    .where(eq(toolFavorites.userId, params.userId))
    .orderBy(toolFavorites.toolSlug);

  return rows.map((row) => row.toolSlug);
}

/**
 * 收藏一个工具。**重复收藏不算失败**：唯一索引挡下冲突后什么也不做。
 *
 * 用 `ON CONFLICT DO NOTHING` 而不是「先查再插」——双击收藏按钮会并发两次请求，
 * 后者会让第二次请求拿到一个「已存在」的报错并弹给用户，而这本来是无意义的。
 */
export async function addToolFavorite(
  db: Database,
  params: { id: string; userId: string; toolSlug: string; now: Date },
): Promise<void> {
  await db
    .insert(toolFavorites)
    .values({
      id: params.id,
      userId: params.userId,
      toolSlug: params.toolSlug,
      createdAt: params.now,
    })
    .onConflictDoNothing({ target: [toolFavorites.userId, toolFavorites.toolSlug] });
}

/** 取消收藏。**取消一个没收藏的工具不算失败**，删除 0 行就是想要的结果。 */
export async function removeToolFavorite(
  db: Database,
  params: { userId: string; toolSlug: string },
): Promise<void> {
  await db
    .delete(toolFavorites)
    .where(
      and(eq(toolFavorites.userId, params.userId), eq(toolFavorites.toolSlug, params.toolSlug)),
    );
}

/**
 * 删除 `before` 之前的运行历史，返回删除条数（worker 的 `maintenance.cleanup` 用）。
 *
 * 先删后数用一条 CTE：`DELETE ... RETURNING` 的结果集可能很大，全取回进程只为了 `length`
 * 是浪费；`count(*)` 在数据库侧算完只回一行。清理任务会写日志，条数是它唯一有意义的产出。
 */
export async function deleteToolRunsOlderThan(
  db: Database,
  params: { before: Date },
): Promise<number> {
  const rows = await db.execute<{ deleted: number }>(sql`
    with removed as (
      delete from ${toolRuns} where ${lt(toolRuns.createdAt, params.before)} returning 1
    )
    select count(*)::int as deleted from removed
  `);

  return rows[0]?.deleted ?? 0;
}

/**
 * 删除 `before` 之前过期的会话，返回删除条数（worker 的 `maintenance.cleanup` 用）。
 *
 * 过期会话本来在校验时就通不过，这里删的是**存储**：不清理的话 `session` 表会一直长。
 */
export async function deleteExpiredSessions(
  db: Database,
  params: { before: Date },
): Promise<number> {
  const rows = await db.execute<{ deleted: number }>(sql`
    with removed as (
      delete from ${session} where ${lt(session.expiresAt, params.before)} returning 1
    )
    select count(*)::int as deleted from removed
  `);

  return rows[0]?.deleted ?? 0;
}

/** `listToolRuns` 的默认条数：页面不给参数时用。上限见 `TOOL_RUN_PAGE_SIZE_MAX`。 */
export const TOOL_RUN_PAGE_SIZE_DEFAULT = 50;
