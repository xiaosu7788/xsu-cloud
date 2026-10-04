/**
 * 后台概览（`/admin`）：五个计数的聚合。
 *
 * 全部是行数（COUNT），不做任何耗时统计——概览页要求在普通 Postgres 上毫秒级返回，
 * 成本看板之类的重聚合属于后续里程碑（`SPEC-admin.md` §1 占位说明）。
 */
import { requireAdminActor } from './rules';
import { type AdminOutcome, type AdminOverview, type AdminPorts } from './types';

/** 概览计数。只读入口同样要求管理员（后台的「看」也是能力）。 */
export async function getAdminOverview(
  ports: AdminPorts,
  request: { actorRole: unknown },
): Promise<AdminOutcome<AdminOverview>> {
  const access = requireAdminActor(request.actorRole);
  if (!access.ok) {
    return access;
  }
  return { ok: true, value: await ports.getAdminOverview() };
}
