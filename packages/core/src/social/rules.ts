/**
 * 社交模块的纯规则：日期口径、输入校验、连续天数、申请三态判定、展示裁剪、幂等键。
 *
 * **没有 I/O，不碰端口。** 每个函数都是「进 → 出」，所以边界值（跨日签到、跨月连续、
 * 重复申请、关掉的展示分区、超长 body）能用最少夹具直接测到，不需要假仓储。
 * 执行顺序在五个操作文件里，契约与失败码在 `./types.ts`。
 *
 * ## 三条口径
 *
 * 1. **日期按站点时区的日历日**。`calendarDateOf` 是唯一换算入口，不要在别处拼日期串。
 * 2. **长度按码点算**（`[...text].length`），与 `community/rules.ts` 同一口径——
 *    emoji 只算一个字符。这里**不 import community 的实现**：领域层模块之间不横向依赖，
 *    重复三行代码比引入一条模块间的隐式耦合更便宜（`charLength` 的实现不到一行）。
 * 3. **先 trim 再判空**：只有空白的输入等于没填。
 */
import {
  CHECKIN_BASE_POINTS,
  DM_BODY_MAX_CHARS,
  MOTTO_MAX_CHARS,
  SITE_UTC_OFFSET_MINUTES,
  SOCIAL_FAILURE,
  SOCIAL_PAGE_SIZE_DEFAULT,
  SOCIAL_PAGE_SIZE_MAX,
  DM_PAGE_SIZE_DEFAULT,
  DM_PAGE_SIZE_MAX,
  DEFAULT_SPACE_SETTINGS,
  VISIT_THROTTLE_MS,
  type DmContactStatusValue,
  type SocialFailure,
  type SpaceSettingsRecord,
} from './types';

/** 按码点数。长度口径与 `community/rules.ts` 一致。
 * **不导出**：它是本模块的内部助手，导出会与社区的同名函数在 `@xsu/core` 根入口碰撞（TS2308）。 */
function charLength(text: string): number {
  return [...text].length;
}

/** 非字符串一律当空串：未提交、传了数字、传了 null 在这里之后没有区别。同样是内部助手。 */
function asText(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}

function isBlank(value: string): boolean {
  return value.trim() === '';
}

/* ==========================================================================
   日期口径
   ========================================================================== */

/** 站点时区下的「年月日」。 */
export type CalendarDate = { year: number; month: number; day: number };

/**
 * 把一个时间点换算成**站点时区的日历日**。
 *
 * 做法是先把时间点整体平移偏移量，再取 UTC 字段——这样就不依赖运行时是否带 tzdata
 * （容器里常常只有 UTC，`toLocaleDateString` 会静默给出错的日期）。
 *
 * 为什么不能直接用 UTC 日期：偏移 +8 时，UTC 的 16:00 已经是当地的次日 00:00。
 * 用 UTC 日期会让中国用户晚上 8 点之后的签到被算成「第二天」（参考实现踩过这个坑）。
 */
export function calendarDateOf(
  instant: Date,
  offsetMinutes = SITE_UTC_OFFSET_MINUTES,
): CalendarDate {
  const shifted = new Date(instant.getTime() + offsetMinutes * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** 日历日 → `YYYY-MM-DD`（数据库 `date` 列的字面量形式）。 */
export function formatCalendarDate(date: CalendarDate): string {
  const mm = String(date.month).padStart(2, '0');
  const dd = String(date.day).padStart(2, '0');
  return `${date.year}-${mm}-${dd}`;
}

/** 时间点 → 站点时区的 `YYYY-MM-DD`。签到与连续天数都用它。 */
export function siteDateString(instant: Date, offsetMinutes = SITE_UTC_OFFSET_MINUTES): string {
  return formatCalendarDate(calendarDateOf(instant, offsetMinutes));
}

/**
 * 两个 `YYYY-MM-DD` 之间相差几天（后者减前者）。
 *
 * 用 `Date.UTC` 把日历日还原成时间点再相减：这样跨月、跨年、闰年都由日期库的规则处理，
 * 不需要手写每个月天数。返回 `null` 表示入参不是合法日期串（调用方据此判定「断签」）。
 */
export function daysBetween(fromDate: string, toDate: string): number | null {
  const from = parseDateString(fromDate);
  const to = parseDateString(toDate);
  if (!from || !to) {
    return null;
  }
  const ms =
    Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day);
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

/** 解析 `YYYY-MM-DD`。形状不对、月份越界、以及「2 月 30 日」这类不存在的日期都返回 null。 */
export function parseDateString(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  // 回环校验：2 月 30 日会被 Date 归一化成 3 月 2 日，比对回来就能识别。
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/**
 * 算出这次签到之后的连续天数。
 *
 * 规则：与**昨天**签到相邻则 `上次 streak + 1`，否则重置为 1。`lastDate` 为 null
 * （从没签过）也重置为 1。
 *
 * **`lastDate` 传的是「上一次签到的日期」**——调用方负责先判断「上次是不是今天」
 * （那是幂等的事，见 `checkin`），走到这里就说明今天还没签过。
 *
 * `lastStreak` 为 null 或非正数时按 1 起算：数据异常不该让连续天数显示成 0。
 */
export function computeStreak(params: {
  lastDate: string | null;
  lastStreak: number | null;
  today: string;
}): number {
  if (!params.lastDate) {
    return 1;
  }
  const gap = daysBetween(params.lastDate, params.today);
  if (gap !== 1) {
    // 断签（gap > 1）或数据异常（gap <= 0）都从 1 重新开始。
    return 1;
  }
  const previous = params.lastStreak ?? 0;
  return Math.max(1, previous) + 1;
}

/** 本次签到应发放的积分。本批没有里程碑梯度，`bonus` 恒为 0。 */
export function checkinPoints(): { base: number; bonus: number; total: number } {
  const base = CHECKIN_BASE_POINTS;
  const bonus = 0;
  return { base, bonus, total: base + bonus };
}

/* ==========================================================================
   分页大小
   ========================================================================== */

/** 消息箱页大小：非法用缺省、过大收到上限。**不报错**（与 community 同一取舍）。 */
export function resolveSocialPageSize(raw: unknown): number {
  return resolvePageSize(raw, SOCIAL_PAGE_SIZE_DEFAULT, SOCIAL_PAGE_SIZE_MAX);
}

/** 私信会话页大小。 */
export function resolveDmPageSize(raw: unknown): number {
  return resolvePageSize(raw, DM_PAGE_SIZE_DEFAULT, DM_PAGE_SIZE_MAX);
}

function resolvePageSize(raw: unknown, fallback: number, max: number): number {
  const parsed =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(parsed) || Math.trunc(parsed) < 1) {
    return fallback;
  }
  return Math.min(Math.trunc(parsed), max);
}

/* ==========================================================================
   输入校验
   ========================================================================== */

/** 校验一条私信。只有正文，顺序没有歧义。 */
export function validateMessageInput(raw: {
  body: unknown;
}): { ok: true; value: { body: string } } | { ok: false; failure: SocialFailure } {
  const body = asText(raw.body).trim();
  if (isBlank(body)) {
    return { ok: false, failure: { ...SOCIAL_FAILURE.inputInvalid, field: 'body' } };
  }
  if (charLength(body) > DM_BODY_MAX_CHARS) {
    return { ok: false, failure: { ...SOCIAL_FAILURE.inputTooLarge, field: 'body' } };
  }
  return { ok: true, value: { body } };
}

/**
 * 校验一句话签名。
 *
 * **空串是合法的**（等于「不显示签名」），所以空值不报错——这与私信正文不同。
 */
export function validateMotto(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; failure: SocialFailure } {
  const motto = asText(raw).trim();
  if (motto === '') {
    return { ok: true, value: null };
  }
  if (charLength(motto) > MOTTO_MAX_CHARS) {
    return { ok: false, failure: { ...SOCIAL_FAILURE.inputTooLarge, field: 'motto' } };
  }
  return { ok: true, value: motto };
}

/* ==========================================================================
   私信申请三态
   ========================================================================== */

/**
 * 私信发送许可判定。**这是本模块最重要的一条规则**，它把「防骚扰」落在一处。
 *
 * 入参是「**收件人视角**的关系状态」与两个豁免标志：
 *
 * | 情形 | 结果 |
 * | --- | --- |
 * | 收件人是自己 | 直接拒绝（`selfMessage`） |
 * | 收件人是管理员 | 放行（不受「先申请」限制） |
 * | 已有 `accepted` 关系 | 放行 |
 * | 已有 `request` 关系 | 拒绝（`dmPendingRequest`）——只允许那一条申请 |
 * | 已有 `declined` 关系 | 拒绝（`dmDeclined`） |
 * | 无关系 | 放行**但标记 `createsRequest`**：调用方必须同时建申请行 |
 *
 * **`createsRequest` 是关键**：无关系时放行不等于「随便发」，而是「只准发这一条，并建申请」。
 * 第二个请求会因为申请行已存在而落到 `dmPendingRequest`。原子性由
 * `dm_contacts` 的主键保证（`insertContact` 返回 `false`）。
 */
export type MessagePermission =
  { allowed: true; createsRequest: boolean } | { allowed: false; failure: SocialFailure };

export function decideMessagePermission(params: {
  senderId: string;
  recipientId: string;
  recipientIsAdmin: boolean;
  contactStatus: DmContactStatusValue | null;
}): MessagePermission {
  if (params.senderId === params.recipientId) {
    return { allowed: false, failure: SOCIAL_FAILURE.selfMessage };
  }
  if (params.recipientIsAdmin) {
    return { allowed: true, createsRequest: false };
  }
  switch (params.contactStatus) {
    case 'accepted':
      return { allowed: true, createsRequest: false };
    case 'request':
      return { allowed: false, failure: SOCIAL_FAILURE.dmPendingRequest };
    case 'declined':
      return { allowed: false, failure: SOCIAL_FAILURE.dmDeclined };
    default:
      // 无关系：允许这第一条，并要求调用方建申请行。
      return { allowed: true, createsRequest: true };
  }
}

/** 申请的处理动作。只有收件人能做，且只有 `request` 状态可处理。 */
export function decideContactReview(params: {
  viewerId: string;
  ownerId: string;
  currentStatus: DmContactStatusValue | null;
}): { allowed: true } | { allowed: false; failure: SocialFailure } {
  if (params.viewerId !== params.ownerId) {
    // 不是收件人本人 → 与「读别人的会话」同一个失败码，不额外造一个。
    return { allowed: false, failure: SOCIAL_FAILURE.conversationForbidden };
  }
  if (params.currentStatus !== 'request') {
    // 没有待处理申请（已同意 / 已拒绝 / 不存在）→ 幂等：不报错，但也不产生状态变化。
    return { allowed: false, failure: { ...SOCIAL_FAILURE.inputInvalid, field: 'status' } };
  }
  return { allowed: true };
}

/* ==========================================================================
   展示裁剪
   ========================================================================== */
/**
 * 空间页要展示哪些分区。
 *
 * **看自己无视开关**：开关是给别人看的隐私设置，主人自己应该看到全部。
 * 这也是「关掉的分区不下发数据」的前提——裁剪在领域层做，不是 CSS 隐藏。
 */
export function visibleSpaceSections(params: {
  viewerId: string | null;
  ownerId: string;
  settings: SpaceSettingsRecord | null;
}): { stats: boolean; posts: boolean; achievements: boolean; motto: string | null } {
  const settings = params.settings ?? DEFAULT_SPACE_SETTINGS;
  if (params.viewerId === params.ownerId) {
    return {
      stats: true,
      posts: true,
      achievements: true,
      motto: settings.motto,
    };
  }
  return {
    stats: settings.showStats,
    posts: settings.showPosts,
    achievements: settings.showAchievements,
    motto: settings.motto,
  };
}

/**
 * 访问计数是否该 +1。
 *
 * 节流：距离上次计入不足 `VISIT_THROTTLE_MS` 就不算。`lastVisitAt` 为 null（头一次）算。
 * 少了这层，每次请求都会 +1，计数会变成「请求数」而不是「访问次数」。
 */
export function shouldCountVisit(params: { lastVisitAt: Date | null; now: Date }): boolean {
  if (!params.lastVisitAt) {
    return true;
  }
  return params.now.getTime() - params.lastVisitAt.getTime() >= VISIT_THROTTLE_MS;
}

/* ==========================================================================
   幂等键
   ========================================================================== */

/**
 * 通知的幂等键。
 *
 * 用「动作 + 目标 + 触发者」拼：这样「同一个人对同一个帖子评论两次」会在收件人那里
 * 只留一条通知，而「两个人分别评论」各有一条。**去掉触发者就会把后者的通知吞掉**。
 */
export function notificationDedupKey(params: {
  type: string;
  targetId: string;
  actorId: string;
}): string {
  return `${params.type}:${params.targetId}:${params.actorId}`;
}

/** 签到的积分幂等键。一人一天只发一次，跨天自然会不同。 */
export function checkinDedupKey(userId: string, date: string): string {
  return `checkin:${userId}:${date}`;
}
