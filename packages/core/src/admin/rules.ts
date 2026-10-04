/**
 * 后台的纯规则：输入归一化、防自锁前置判定、审计文案、分页参数。**没有 I/O，不碰端口。**
 *
 * 与 `../community/rules.ts` 同一套分工：每个函数都是「进 → 出」，执行顺序在
 * users / content / config 等操作文件里。长度口径（按码点、先 trim 再判空）直接复用
 * 社区模块的实现——「同一件事不写两套算法」。
 */
import type { AuditTargetType } from '@xsu/db/schema';

import { ADMIN_ROLE, isAdmin, isRole, type Role } from '../access';
import { asText, charLength, normalizeQuery } from '../community/rules';
import {
  ADMIN_FAILURE,
  ADMIN_PAGE_SIZE_DEFAULT,
  ADMIN_PAGE_SIZE_MAX,
  BAN_REASON_MAX_CHARS,
  SITE_CONFIG_QUOTA_MAX,
  type AdminAuditAction,
  type AdminFailure,
} from './types';

/**
 * 审计行的目标类型常量。取值就是 `AUDIT_TARGET_TYPES` 的成员，这里给它们起领域名字，
 * 操作文件里不写字符串字面量。
 */
export const ADMIN_AUDIT_TARGET = {
  user: 'user',
  post: 'post',
  comment: 'comment',
  siteConfig: 'site_config',
} as const satisfies Record<string, AuditTargetType>;

/**
 * 后台所有入口（含只读）的第一步。这里用 `ADMIN_FAILURE.notAdmin`，不用
 * `ACCESS_DENIED.forbidden`：后者回答「能不能进 `(admin)` 分区」（页面守卫的职责），
 * 这里回答「这次领域操作要不要管理员」——与社区模块 `decideModerationAccess` 的取舍一致。
 */
export function requireAdminActor(
  role: unknown,
): { ok: true; role: Role } | { ok: false; failure: AdminFailure } {
  return isAdmin(role)
    ? { ok: true, role: ADMIN_ROLE }
    : { ok: false, failure: ADMIN_FAILURE.notAdmin };
}

/** 角色输入必须是数据层 `ROLES` 的成员，不接受任意字符串。 */
export function normalizeRoleInput(raw: unknown): Role | null {
  return isRole(raw) ? raw : null;
}

/** trim 后非空白才有内容；全空白的封禁理由等于「无理由」（`null`）。 */
export function normalizeOptionalText(raw: unknown): string | null {
  const text = asText(raw).trim();
  return text === '' ? null : text;
}

/** 用户搜索关键词：只有空白 → `null`（不加筛选）。复用社区的口径（不转小写，ILIKE 自带）。 */
export function normalizeAdminQuery(raw: unknown): string | null {
  return normalizeQuery(raw);
}

/** 校验封禁理由：可选，填了就不得超过 `BAN_REASON_MAX_CHARS`。 */
export function validateBanReason(
  raw: unknown,
): { ok: true; reason: string | null } | { ok: false; failure: AdminFailure } {
  const reason = normalizeOptionalText(raw);
  if (reason && charLength(reason) > BAN_REASON_MAX_CHARS) {
    return { ok: false, failure: { ...ADMIN_FAILURE.inputInvalid, field: 'reason' } };
  }
  return { ok: true, reason };
}

/**
 * 校验一个配额覆盖值。语义与 `site_config` 列的 CHECK 一致（事实来源在数据层）：
 * `null` / `undefined` / 空串 = 不覆盖；其余必须是 0 到 `SITE_CONFIG_QUOTA_MAX` 的整数，
 * 0 表示关闭该动作。小数、负数、超上限、非数字都是 `inputInvalid`。
 */
export function normalizeQuotaOverride(
  raw: unknown,
  field: string,
): { ok: true; value: number | null } | { ok: false; failure: AdminFailure } {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, value: null };
  }
  const parsed =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > SITE_CONFIG_QUOTA_MAX) {
    return { ok: false, failure: { ...ADMIN_FAILURE.inputInvalid, field } };
  }
  return { ok: true, value: parsed };
}

/**
 * 后台列表的分页参数（偏移制）。`page` 来自 `?page=` 这类不可信输入：
 * 解不出数字或小于 1 一律按第一页，pageSize 收进 `ADMIN_PAGE_SIZE_MAX`——
 * 翻页是幂等的读操作，写错的页码让整页 400 没有收益（与社区 `resolvePageSize` 同一口径）。
 */
export function adminPageParams(params: { page?: unknown; pageSize?: number }): {
  limit: number;
  offset: number;
} {
  const limit = Math.min(params.pageSize ?? ADMIN_PAGE_SIZE_DEFAULT, ADMIN_PAGE_SIZE_MAX);
  const parsed = typeof params.page === 'number' ? params.page : Number(asText(params.page));
  const page = Number.isFinite(parsed) && Math.trunc(parsed) >= 1 ? Math.trunc(parsed) : 1;
  return { limit, offset: (page - 1) * limit };
}

/*
 * 审计 detail 文案。审计行是操作记录：写「谁把什么改成了什么」，不抄用户提交的内容
 * （封禁理由是管理员自己写的，属于操作的一部分，保留）。
 */

/** 角色变更：`from` 必须是改之前的值，所以只能在领域层拿到目标用户之后构造。 */
export function roleChangeDetail(params: { from: string; to: Role }): string {
  return `角色 ${params.from} → ${params.to}`;
}

/** 封禁：有理由才写 detail；解封不写（动作本身就完整）。 */
export function banDetail(reason: string | null): string | null {
  return reason === null ? null : `封禁理由：${reason}`;
}

/** 配额覆盖：`null` 显示为「默认」，与表单里「留空 = 跟随默认」的语义对应。 */
export function siteConfigDetail(values: {
  postQuotaPerHour: number | null;
  commentQuotaPerHour: number | null;
  toolQuotaPerHour: number | null;
}): string {
  const format = (value: number | null) => (value === null ? '默认' : String(value));
  return `每小时配额覆盖：发帖 ${format(values.postQuotaPerHour)} / 评论 ${format(values.commentQuotaPerHour)} / 工具 ${format(values.toolQuotaPerHour)}`;
}

/** 组一条审计动作名。唯一作用是让操作文件不用 import 整个常量表再挑字段。 */
export function adminAuditAction(action: AdminAuditAction): AdminAuditAction {
  return action;
}
