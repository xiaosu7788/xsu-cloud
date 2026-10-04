/**
 * 任务管理（只读）：`tool_runs` 的统计与最近运行列表。
 *
 * M5 不做任务重试与队列操作（`SPEC-admin.md` §1 不做清单，重试在 M6 跟随队列管理落地），
 * 这里只把已有数据读出来：顶部按状态聚合计数，底部按工具维度聚合失败率，再给最近一批
 * 运行的明细行（带作者邮箱，页面直接展示）。
 */
import { requireAdminActor } from './rules';
import {
  type AdminOutcome,
  type AdminPorts,
  type AdminToolRunRow,
  type AdminToolRunStats,
} from './types';

/** 任务统计 + 最近运行列表，一次取全（页面只有一个区块）。 */
export async function getAdminTaskBoard(
  ports: AdminPorts,
  request: { actorRole: unknown; runsLimit?: number },
): Promise<AdminOutcome<{ stats: AdminToolRunStats; recent: AdminToolRunRow[] }>> {
  const access = requireAdminActor(request.actorRole);
  if (!access.ok) {
    return access;
  }
  const [stats, recent] = await Promise.all([
    ports.listToolRunStats(),
    ports.listToolRunsForAdmin({ limit: Math.min(Math.max(request.runsLimit ?? 10, 1), 50) }),
  ]);
  return { ok: true, value: { stats, recent } };
}
