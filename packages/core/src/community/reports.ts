/**
 * 举报与审核（**管理员确认路径**）。
 *
 * 两条必须分开看的路径：
 *
 * 1. **举报 `createReport`**：① 目标存在且还活着 → ② 同一个人对同一目标已有未处理举报就
 *    幂等返回既有那条 → ③ 写入。**它不改任何内容状态**——举报后内容照旧可见，这是
 *    PRD 3.2 验收 4 的原话：「举报不会自动下架，必须有管理员确认路径」；
 * 2. **审核 `confirmTakedown` / `dismissReport`**：① 要求管理员 → ② 举报必须处于 `open` →
 *    ③④⑤ 内容软删（仅确认下架）+ 举报置终态 + 写审计行，**三步同事务**（红线 8）。
 *    不允许出现「内容已下架、审计没落」。
 *
 * 两个入口只差一个 `status`，所以走同一个内部函数；它们与 `listPendingReports` /
 * `listAuditLogs` 共用同一句管理员判定（`decideModerationAccess`），不各写一遍。
 */
import type { AuditLogListItem, ReportListItem } from '@xsu/db/schema';

import { loadVisibleComment } from './comments';
import { loadVisiblePost } from './posts';
import {
  auditActionFor,
  buildAuditDetail,
  decideModerationAccess,
  validateReportInput,
} from './rules';
import {
  ADMIN_LIST_LIMIT_DEFAULT,
  CONTENT_FAILURE,
  type CommunityPorts,
  type ModerationOutcome,
  type PageOutcome,
  type ReportOutcome,
  type ReportTerminalStatus,
} from './types';

/**
 * 提交举报。**不动被举报的内容**，只落一行举报等管理员处理。
 *
 * 幂等与并发各有一个机制，缺一不可：先按 `(举报人, 目标类型, 目标 id, status = 'open')` 回读
 * 是常见路径的幂等；部分唯一索引 `reports_open_unique_idx` 是并发下的兜底。撞上兜底之后的
 * 收敛流程（回读 → 重试 → 才报冲突）写在下面，理由见 `CONTENT_FAILURE.writeConflict`。
 */
export async function createReport(
  ports: CommunityPorts,
  request: { reporterId: string; targetType: unknown; targetId: unknown; reason: unknown },
): Promise<ReportOutcome> {
  const input = validateReportInput(request);
  if (!input.ok) {
    return { ok: false, failure: input.failure };
  }
  const { targetType, targetId, reason } = input.value;

  // ① 目标必须存在且还活着。目标 id 没有外键（多态，`schema/community.ts`），所以这件事
  // 只能由领域层来判。举报稿子里的目标类型决定了去查哪张表，也决定了 404 用哪个码。
  const targetExists =
    targetType === 'post'
      ? (await loadVisiblePost(ports, targetId)) !== null
      : (await loadVisibleComment(ports, targetId)) !== null;
  if (!targetExists) {
    return {
      ok: false,
      failure:
        targetType === 'post' ? CONTENT_FAILURE.postNotFound : CONTENT_FAILURE.commentNotFound,
    };
  }

  const now = ports.now();
  const identity = { reporterId: request.reporterId, targetType, targetId };

  // ② 已经有未处理的举报 → 幂等返回既有那条，不写第二行。
  const existing = await ports.findOpenReport(identity);
  if (existing) {
    return { ok: true, reportId: existing.id, alreadyReported: true };
  }

  // ③ 写入。撞上唯一约束时返回 `null`。
  const created = await ports.insertReport({
    id: ports.newId(),
    ...identity,
    reason,
    createdAt: now,
  });
  if (created) {
    return { ok: true, reportId: created.id, alreadyReported: false };
  }

  // 撞了。两种可能：并发下的另一条同样的举报刚插进去（回读就能拿到），或者既有那条
  // 恰好在这两次查询之间被管理员处理掉了（回读为空，此时索引已经让开，重试一次即可）。
  const raced = await ports.findOpenReport(identity);
  if (raced) {
    return { ok: true, reportId: raced.id, alreadyReported: true };
  }

  const retried = await ports.insertReport({
    id: ports.newId(),
    ...identity,
    reason,
    createdAt: now,
  });
  if (retried) {
    return { ok: true, reportId: retried.id, alreadyReported: false };
  }

  // 重试仍然撞车：这不是「用户做错了」，让他重试一次就能过。
  return { ok: false, failure: CONTENT_FAILURE.writeConflict };
}

/**
 * 两个审核入口的共同流程。顺序是规则的一部分（第 4 节）：管理员 → 举报仍可处理 → 三件事同事务。
 *
 * 「举报仍可处理」在领域层预检一次、在数据层再由 `where status = 'open'` 兜一次：预检让绝大多数
 * 重复点击得到明确的 `reportAlreadyHandled` 文案，条件更新保证两个管理员**同时**点击时只有一个
 * 能真的改动内容，另一个拿到 `null`（不会出现两次软删或两行审计）。
 */
async function resolveModeration(
  ports: CommunityPorts,
  request: {
    reportId: string;
    actorId: string;
    actorRole: unknown;
    status: ReportTerminalStatus;
  },
): Promise<ModerationOutcome> {
  const access = decideModerationAccess(request.actorRole);
  if (!access.allowed) {
    return { ok: false, failure: access.failure };
  }

  const report = await ports.getReportById({ id: request.reportId });
  if (!report) {
    return { ok: false, failure: CONTENT_FAILURE.reportNotFound };
  }
  if (report.status !== 'open') {
    return { ok: false, failure: CONTENT_FAILURE.reportAlreadyHandled };
  }

  const handledAt = ports.now();
  const resolved = await ports.resolveReport({
    reportId: report.id,
    status: request.status,
    handledBy: request.actorId,
    handledAt,
    audit: {
      id: ports.newId(),
      actorId: request.actorId,
      action: auditActionFor(request.status),
      // 审计指向**被处置的内容**，不是举报行：审计要回答「哪条内容因为哪次举报被处置」，
      // 举报 id 写在 `detail` 里（`types.ts` 的 `AuditLogRecord`）。
      targetType: report.targetType,
      targetId: report.targetId,
      detail: buildAuditDetail({
        reportId: report.id,
        targetType: report.targetType,
        targetId: report.targetId,
      }),
      createdAt: handledAt,
    },
  });

  if (!resolved) {
    return { ok: false, failure: CONTENT_FAILURE.reportAlreadyHandled };
  }

  return {
    ok: true,
    reportId: resolved.id,
    targetType: resolved.targetType,
    targetId: resolved.targetId,
  };
}

/** 确认下架：举报成立，内容被软删除（+ 审计）。 */
export async function confirmTakedown(
  ports: CommunityPorts,
  request: { reportId: string; actorId: string; actorRole: unknown },
): Promise<ModerationOutcome> {
  return resolveModeration(ports, {
    reportId: request.reportId,
    actorId: request.actorId,
    actorRole: request.actorRole,
    status: 'takedown',
  });
}

/** 驳回举报：举报置终态，**内容保持可见**。同样要写审计行。 */
export async function dismissReport(
  ports: CommunityPorts,
  request: { reportId: string; actorId: string; actorRole: unknown },
): Promise<ModerationOutcome> {
  return resolveModeration(ports, {
    reportId: request.reportId,
    actorId: request.actorId,
    actorRole: request.actorRole,
    status: 'dismissed',
  });
}

/**
 * 待处理举报队列（`/admin/reports`）。M3 不分页，取一页固定条数（SPEC 已知债务）。
 */
export async function listPendingReports(
  ports: CommunityPorts,
  request: { actorRole: unknown; limit?: number },
): Promise<PageOutcome<ReportListItem>> {
  const access = decideModerationAccess(request.actorRole);
  if (!access.allowed) {
    return { ok: false, failure: access.failure };
  }

  const items = await ports.listPendingReports({
    limit: request.limit ?? ADMIN_LIST_LIMIT_DEFAULT,
  });
  return { ok: true, items, nextCursor: null };
}

/**
 * 审计日志（时间倒序）。**只有管理员能看**——这张表记着谁处置了谁的内容（第 4.1 节）。
 * M3 只在后台展示，没有筛选与分页（留给 M5）。
 */
export async function listAuditLogs(
  ports: CommunityPorts,
  request: { actorRole: unknown; limit?: number },
): Promise<PageOutcome<AuditLogListItem>> {
  const access = decideModerationAccess(request.actorRole);
  if (!access.allowed) {
    return { ok: false, failure: access.failure };
  }

  const items = await ports.listAuditLogs({ limit: request.limit ?? ADMIN_LIST_LIMIT_DEFAULT });
  return { ok: true, items, nextCursor: null };
}
