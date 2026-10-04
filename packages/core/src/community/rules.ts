/**
 * 社区的纯规则：归一化、输入校验、游标编解码、分页切片、归属与审核判定。
 *
 * **没有 I/O，不碰端口。** 这里每个函数都是「进 → 出」，所以边界值（空串、超长、坏游标、
 * 越界页大小、取消一个没点过的赞）能用最少的夹具直接测到，不需要假仓储。执行顺序在四个操作
 * 文件里，契约与失败码在 `./types.ts`；这个分工的理由见 `types.ts` 文件头。
 *
 * 三条口径（与 `tools/run-tool.ts` 一致，同一件事不写两套算法）：
 *
 * 1. **长度按码点算**（`[...text].length`），不按 UTF-16 码元——否则 emoji 会被算成两个字符；
 * 2. **先 trim 再判空**：只有空白的输入等于没填；
 * 3. **页大小越界不报错，游标解不出来必须报错**（见 `resolvePageSize` / `decodeCursor`）。
 *    翻页是幂等的读操作，为一个写错的 `limit` 让整页 400 没有收益；但坏游标静默回落到第一页
 *    会让「翻页不重不漏」这条验收无法证伪（`docs/spec/SPEC-community.md` 第 6 节）。
 */
import { REPORT_TARGET_TYPES, type ReportTargetType } from '@xsu/db/schema';

import { isAdmin } from '../access';
import {
  AUDIT_ACTION,
  COMMENT_BODY_MAX_CHARS,
  COMMUNITY_PAGE_SIZE_DEFAULT,
  COMMUNITY_PAGE_SIZE_MAX,
  COMMUNITY_QUOTA_WINDOW_MS,
  CONTENT_FAILURE,
  POST_BODY_MAX_CHARS,
  POST_TAG_MAX_CHARS,
  POST_TAG_MAX_COUNT,
  POST_TITLE_MAX_CHARS,
  REPORT_REASON_MAX_CHARS,
  type AuditAction,
  type CommunityCursor,
  type CommunityFailure,
  type CommunityPage,
  type ReportTerminalStatus,
} from './types';

/** 按码点数（`[...text].length`），不按 UTF-16 码元。长度口径全站唯一。 */
export function charLength(text: string): number {
  return [...text].length;
}

/** 非字符串一律当成空串：未提交、传了数字、传了 null 在这里之后就没有区别。 */
export function asText(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}

/** trim 之后仍然为空 = 没填。 */
function isBlank(value: string): boolean {
  return value.trim() === '';
}

/** 长度上限判定。`field` 让表单能指出是哪个字段，`message` 复用失败码表里的文案。 */
function checkLength(params: {
  value: string;
  max: number;
  field: string;
  failure: CommunityFailure;
}): CommunityFailure | null {
  return charLength(params.value) > params.max ? { ...params.failure, field: params.field } : null;
}

/*
 * 输入归一化与校验
 */

/** 归一化后的发帖输入。入库的就是这三个字段，没有别的形态。 */
export type NormalizedPostInput = { title: string; body: string; tags: string[] };

/** 归一化后的评论输入。 */
export type NormalizedCommentInput = { body: string };

/** 归一化后的举报输入。 */
export type NormalizedReportInput = {
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
};

/**
 * 标签归一化：切分 → trim → 转小写 → 去重，**顺序固定**。
 *
 * 去重放在最后一步，所以 `TypeScript` / ` typescript ` / `TYPESCRIPT` 会收敛成一个标签——
 * 这也是「标签个数上限按归一化去重之后算」的前提（`types.ts`）。
 * 切分符包含中英文逗号、顿号与空白：表单是一个输入框，用户会用其中的任何一种。
 * 归一化后为空的片段直接丢掉（`a,,b` 是两个标签，不是一个空标签）。
 */
export function normalizeTags(raw: unknown): string[] {
  const segments = Array.isArray(raw)
    ? raw.map((item) => asText(item))
    : asText(raw).split(/[,，、\s]+/);

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const segment of segments) {
    const tag = segment.trim().toLowerCase();
    if (tag === '' || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

/** 单个标签的归一化（按标签浏览路由用）。只有空白 → `null`，表示「不加这个筛选」。 */
export function normalizeTag(raw: unknown): string | null {
  const tag = asText(raw).trim().toLowerCase();
  return tag === '' ? null : tag;
}

/** 搜索关键词归一化。只有空白 → `null`（不加筛选）。**不转小写**：`ILIKE` 本来就不区分大小写。 */
export function normalizeQuery(raw: unknown): string | null {
  const query = asText(raw).trim();
  return query === '' ? null : query;
}

/**
 * 校验一篇文章的输入。
 *
 * 检查顺序：标题空 → 标题长 → 正文空 → 正文长 → 单个标签长 → 标签个数。
 * **标签个数用单独一码**（`tagLimitExceeded`），因为它跟「某个字段写长了」不是同一件事：
 * 表单要能指出「删掉多余的标签」而不是「精简内容」。
 */
export function validatePostInput(raw: {
  title: unknown;
  body: unknown;
  tags: unknown;
}): { ok: true; value: NormalizedPostInput } | { ok: false; failure: CommunityFailure } {
  const title = asText(raw.title).trim();
  if (isBlank(title)) {
    return { ok: false, failure: { ...CONTENT_FAILURE.inputInvalid, field: 'title' } };
  }
  const titleTooLong = checkLength({
    value: title,
    max: POST_TITLE_MAX_CHARS,
    field: 'title',
    failure: CONTENT_FAILURE.inputTooLarge,
  });
  if (titleTooLong) {
    return { ok: false, failure: titleTooLong };
  }

  const body = asText(raw.body).trim();
  if (isBlank(body)) {
    return { ok: false, failure: { ...CONTENT_FAILURE.inputInvalid, field: 'body' } };
  }
  const bodyTooLong = checkLength({
    value: body,
    max: POST_BODY_MAX_CHARS,
    field: 'body',
    failure: CONTENT_FAILURE.inputTooLarge,
  });
  if (bodyTooLong) {
    return { ok: false, failure: bodyTooLong };
  }

  const tags = normalizeTags(raw.tags);
  for (const tag of tags) {
    const tagTooLong = checkLength({
      value: tag,
      max: POST_TAG_MAX_CHARS,
      field: 'tags',
      failure: CONTENT_FAILURE.inputTooLarge,
    });
    if (tagTooLong) {
      return { ok: false, failure: tagTooLong };
    }
  }
  if (tags.length > POST_TAG_MAX_COUNT) {
    return { ok: false, failure: { ...CONTENT_FAILURE.tagLimitExceeded, field: 'tags' } };
  }

  return { ok: true, value: { title, body, tags } };
}

/** 校验一条评论。只有正文一个字段，所以顺序没有歧义。 */
export function validateCommentInput(raw: {
  body: unknown;
}): { ok: true; value: NormalizedCommentInput } | { ok: false; failure: CommunityFailure } {
  const body = asText(raw.body).trim();
  if (isBlank(body)) {
    return { ok: false, failure: { ...CONTENT_FAILURE.inputInvalid, field: 'body' } };
  }
  const tooLong = checkLength({
    value: body,
    max: COMMENT_BODY_MAX_CHARS,
    field: 'body',
    failure: CONTENT_FAILURE.inputTooLarge,
  });
  return tooLong ? { ok: false, failure: tooLong } : { ok: true, value: { body } };
}

/** 目标类型必须来自数据层的联合，不接受任意字符串。 */
export function normalizeReportTargetType(raw: unknown): ReportTargetType | null {
  return typeof raw === 'string' && (REPORT_TARGET_TYPES as readonly string[]).includes(raw)
    ? (raw as ReportTargetType)
    : null;
}

/**
 * 校验一次举报。目标类型非法与目标 id 为空都是 `inputInvalid`——两者都是「客户端传错了」，
 * 不是内容层面的问题。
 */
export function validateReportInput(raw: {
  targetType: unknown;
  targetId: unknown;
  reason: unknown;
}): { ok: true; value: NormalizedReportInput } | { ok: false; failure: CommunityFailure } {
  const targetType = normalizeReportTargetType(raw.targetType);
  if (!targetType) {
    return { ok: false, failure: { ...CONTENT_FAILURE.inputInvalid, field: 'targetType' } };
  }
  const targetId = asText(raw.targetId).trim();
  if (targetId === '') {
    return { ok: false, failure: { ...CONTENT_FAILURE.inputInvalid, field: 'targetId' } };
  }
  const reason = asText(raw.reason).trim();
  if (isBlank(reason)) {
    return { ok: false, failure: { ...CONTENT_FAILURE.inputInvalid, field: 'reason' } };
  }
  const tooLong = checkLength({
    value: reason,
    max: REPORT_REASON_MAX_CHARS,
    field: 'reason',
    failure: CONTENT_FAILURE.inputTooLarge,
  });
  return tooLong
    ? { ok: false, failure: tooLong }
    : { ok: true, value: { targetType, targetId, reason } };
}

/*
 * 游标分页
 */

/**
 * 游标 = `base64url(JSON.stringify({ t, i }))`，`t` 是 `created_at` 的 ISO 串、`i` 是 id。
 *
 * 用 `Buffer` 而不是 `btoa`：`btoa` 只吃 Latin-1，字符串里混进任何非 ASCII 就抛异常；
 * `Buffer.from(text, 'utf8')` 没有这个坑（`tools/builtin.ts` 里的 base64 工具同样取舍）。
 * `base64url` 不用补 `=`，也不含 `+` / `/`，放进查询串不需要转义。
 */
export function encodeCursor(point: CommunityCursor): string {
  return Buffer.from(
    JSON.stringify({ t: point.createdAt.toISOString(), i: point.id }),
    'utf8',
  ).toString('base64url');
}

/**
 * 解游标。`null` / `undefined` / 空串表示第一页；**其余解不出来的一律 `inputInvalid`**，
 * 不静默回落到第一页（第 6 节：静默回落会让「不重不漏」无法证伪）。
 *
 * `Buffer.from(raw, 'base64url')` 对畸形输入不抛异常（它会丢掉不认识的字符），所以真正的
 * 校验点是后面的 `JSON.parse` 与形状检查：`t` 必须是能解析出合法日期的字符串，`i` 必须非空。
 */
export function decodeCursor(
  raw: unknown,
): { ok: true; cursor: CommunityCursor | null } | { ok: false; failure: CommunityFailure } {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, cursor: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, failure: { ...CONTENT_FAILURE.inputInvalid, field: 'cursor' } };
  }

  const invalid = (): { ok: false; failure: CommunityFailure } => ({
    ok: false,
    failure: { ...CONTENT_FAILURE.inputInvalid, field: 'cursor' },
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return invalid();
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return invalid();
  }
  const { t, i } = parsed as { t?: unknown; i?: unknown };
  if (typeof t !== 'string' || typeof i !== 'string' || i === '') {
    return invalid();
  }
  const createdAt = new Date(t);
  if (Number.isNaN(createdAt.getTime())) {
    return invalid();
  }

  return { ok: true, cursor: { createdAt, id: i } };
}

/**
 * 页大小：非法（未给 / 非数字 / 小于 1）用缺省值，合法但过大的收进上限。
 * **不报错**，理由见文件头第 3 条。
 */
export function resolvePageSize(raw: unknown): number {
  const parsed =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : Number.NaN;

  if (!Number.isFinite(parsed) || Math.trunc(parsed) < 1) {
    return COMMUNITY_PAGE_SIZE_DEFAULT;
  }
  return Math.min(Math.trunc(parsed), COMMUNITY_PAGE_SIZE_MAX);
}

/**
 * 把「多取一行」的结果切成页。
 *
 * 调用方必须按 `limit + 1` 取行：多出来的那一行唯一的作用是回答「有没有下一页」，
 * 它本身不进结果。用行值比较（`(created_at, id) < ...`）而不是 `OFFSET`，理由见第 6 节。
 */
export function paginate<Item>(params: {
  rows: Item[];
  limit: number;
  cursorOf: (item: Item) => CommunityCursor;
}): CommunityPage<Item> {
  const hasNext = params.rows.length > params.limit;
  const items = hasNext ? params.rows.slice(0, params.limit) : params.rows;
  const last = items[items.length - 1];

  return {
    items,
    nextCursor: hasNext && last ? encodeCursor(params.cursorOf(last)) : null,
  };
}

/*
 * 配额
 */

/** 配额窗口的起点。与 `ports.now()` 是同一个时间点，否则「算的时候没超、写下去就超了」。 */
export function quotaWindowStart(now: Date): Date {
  return new Date(now.getTime() - COMMUNITY_QUOTA_WINDOW_MS);
}

/**
 * 已经用满配额了吗。**`quotaPerHour` 为 0 表示关闭这个动作**（不是「不限」）：
 * 于是 `count >= 0` 恒真，所有请求都被拒——与 `run-tool.ts` 的取舍一致。
 */
export function isQuotaExceeded(params: { recentCount: number; quotaPerHour: number }): boolean {
  return params.recentCount >= Math.max(0, Math.trunc(params.quotaPerHour));
}

/*
 * 归属与审核判定
 */

export type AccessOutcome = { allowed: true } | { allowed: false; failure: CommunityFailure };

/**
 * 这个账号能不能改 / 删这篇帖子。
 *
 * **只有作者放行，管理员不放行**：管理员只有审核（`confirmTakedown`）这一条路径，它带审计日志。
 * 在这里给管理员放行会把「作者删除」与「管理员下架」合并成同一条路径，而下架必须留痕
 * （第 4.1 节）。数据层的查询也按 `author_id` 收窄，两处是有意的重复（纵深防御）。
 */
export function decidePostAccess(params: { viewerId: string; authorId: string }): AccessOutcome {
  return params.viewerId === params.authorId
    ? { allowed: true }
    : { allowed: false, failure: CONTENT_FAILURE.postForbidden };
}

/** 同上，评论版本。 */
export function decideCommentAccess(params: { viewerId: string; authorId: string }): AccessOutcome {
  return params.viewerId === params.authorId
    ? { allowed: true }
    : { allowed: false, failure: CONTENT_FAILURE.commentForbidden };
}

/**
 * 审核动作要求管理员。**这里用 `isAdmin`，不用 `ACCESS_DENIED.forbidden`**：后者回答的是
 * 「能不能进 `(admin)` 分区」（由路由守卫生成），这里回答的是「这次内容操作要不要管理员」。
 * 两件事的文案与出现位置都不同（`types.ts` 的 `CONTENT_FAILURE.notAdmin` 说明了取舍）。
 */
export function decideModerationAccess(role: unknown): AccessOutcome {
  return isAdmin(role) ? { allowed: true } : { allowed: false, failure: CONTENT_FAILURE.notAdmin };
}

/** 终态 → 审计动作。映射只有一处，避免两个入口各写一遍、其中一个漏写。 */
export function auditActionFor(status: ReportTerminalStatus): AuditAction {
  return status === 'takedown' ? AUDIT_ACTION.reportTakedown : AUDIT_ACTION.reportDismiss;
}

/**
 * 审计行的 `detail`。
 *
 * 审计要回答的是「哪条内容因为哪次举报被处置」，所以三个事实都写进去。**不写举报理由**：
 * 那是用户提交的内容，审计日志是操作记录，不是内容归档；把用户文本抄进只追加的表只会让
 * 将来「删掉这条内容就能删干净」变得不可能。
 */
export function buildAuditDetail(params: {
  reportId: string;
  targetType: ReportTargetType;
  targetId: string;
}): string {
  return `举报 ${params.reportId} → ${params.targetType}:${params.targetId}`;
}
