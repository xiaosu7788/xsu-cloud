/**
 * 社交模块的领域层测试。
 *
 * 分两段：
 *
 * 1. **纯规则**（`rules.ts`）——直接调，无夹具。边界值都在这里：跨日/跨月/跨年签到、
 *    非法的日期串、申请三态、展示裁剪、幂等键。
 * 2. **执行顺序**（`checkins.ts` / `messages.ts` / `notifications.ts` / `achievements.ts`）
 *    ——用假端口验证「并发防线」「事务语义」「不发重复通知」这些**顺序**上的性质，
 *    它们是本批功能最容易写错的地方。
 */
import { describe, expect, it } from 'vitest';

import {
  ACHIEVEMENTS,
  applyPoints,
  buildHistory,
  calendarDateOf,
  checkin,
  checkinDedupKey,
  computeStreak,
  countUnreadNotifications,
  daysBetween,
  decideContactReview,
  decideMessagePermission,
  formatCalendarDate,
  getCheckinStatus,
  levelFor,
  listNotifications,
  listPointTransactions,
  markNotificationsRead,
  notify,
  parseDateString,
  persistUnlocks,
  progressOf,
  readConversation,
  resolveDmPageSize,
  resolveSocialPageSize,
  reviewContactRequest,
  getSpaceSettings,
  getSpaceStats,
  recordSpaceVisit,
  saveSpaceSettings,
  sendMessage,
  shouldCountVisit,
  siteDateString,
  spaceSectionsFor,
  validateMessageInput,
  validateMotto,
  visibleSpaceSections,
  listAchievementProgress,
  type AchievementProgress,
  type AchievementStats,
  type AchievementUnlock,
  type CheckinRecord,
  type DirectMessageRecord,
  type DmContactRecord,
  type DmContactStatusValue,
  type NotificationCategory,
  type NotificationRecord,
  type PointTransactionRecord,
  type SocialPorts,
  type SpaceSettingsRecord,
} from '../src/social';

const NOW = new Date('2026-03-01T12:00:00.000Z');

/* ==========================================================================
   纯规则：日期口径
   ========================================================================== */

describe('日期口径（站点时区）', () => {
  it('同一 UTC 时刻在不同偏移下落到不同日历日', () => {
    // UTC 16:00 已经是 UTC+8 的次日 00:00。
    const instant = new Date('2026-03-01T16:00:00.000Z');
    expect(formatCalendarDate(calendarDateOf(instant, 0))).toBe('2026-03-01');
    expect(formatCalendarDate(calendarDateOf(instant, 8 * 60))).toBe('2026-03-02');
  });

  it('站点默认偏移是 UTC+8：晚上 8 点后算次日', () => {
    // 这正是参考实现踩过的坑——用 UTC 日期会把这天算成 03-01。
    expect(siteDateString(new Date('2026-03-01T15:59:00.000Z'))).toBe('2026-03-01');
    expect(siteDateString(new Date('2026-03-01T16:00:00.000Z'))).toBe('2026-03-02');
  });

  it('月与日补零', () => {
    expect(siteDateString(new Date('2026-01-05T00:00:00.000Z'))).toBe('2026-01-05');
  });

  it('daysBetween 处理跨月、跨年与闰年', () => {
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2024-02-28', '2024-02-29')).toBe(1);
    expect(daysBetween('2026-03-01', '2026-03-01')).toBe(0);
    expect(daysBetween('2026-03-05', '2026-03-01')).toBe(-4);
  });

  it('非法日期串返回 null', () => {
    expect(parseDateString('2026-2-1')).toBeNull();
    expect(parseDateString('not-a-date')).toBeNull();
    expect(parseDateString('2026-13-01')).toBeNull();
    // 2 月 30 日不存在：被 Date 归一化成 3 月 2 日，回环校验要能识别。
    expect(parseDateString('2026-02-30')).toBeNull();
    expect(daysBetween('2026-02-30', '2026-03-01')).toBeNull();
  });
});

describe('连续天数', () => {
  const today = '2026-03-10';

  it('从没签过 → 1', () => {
    expect(computeStreak({ lastDate: null, lastStreak: null, today })).toBe(1);
  });

  it('昨天签过 → 累加', () => {
    expect(computeStreak({ lastDate: '2026-03-09', lastStreak: 4, today })).toBe(5);
  });

  it('断签（前天）→ 重置为 1', () => {
    expect(computeStreak({ lastDate: '2026-03-08', lastStreak: 9, today })).toBe(1);
  });

  it('上月同一天不算连续', () => {
    expect(computeStreak({ lastDate: '2026-02-10', lastStreak: 30, today })).toBe(1);
  });

  it('跨月相邻算连续', () => {
    expect(computeStreak({ lastDate: '2026-02-28', lastStreak: 3, today: '2026-03-01' })).toBe(4);
  });

  it('历史 streak 为 null 或异常值时不返回 0', () => {
    expect(computeStreak({ lastDate: '2026-03-09', lastStreak: null, today })).toBe(2);
    expect(computeStreak({ lastDate: '2026-03-09', lastStreak: 0, today })).toBe(2);
  });
});

/* ==========================================================================
   纯规则：校验与分页
   ========================================================================== */

describe('输入校验', () => {
  it('私信正文：空、纯空白、非字符串都算没填', () => {
    for (const raw of ['', '   ', undefined, null, 42]) {
      const outcome = validateMessageInput({ body: raw });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.failure.code).toBe('SOCIAL_INPUT_INVALID');
        expect(outcome.failure.field).toBe('body');
      }
    }
  });

  it('私信正文超长按码点算（emoji 算一个）', () => {
    expect(validateMessageInput({ body: 'a'.repeat(1000) }).ok).toBe(true);
    const tooLong = validateMessageInput({ body: 'a'.repeat(1001) });
    expect(tooLong.ok).toBe(false);
    // 500 个 emoji = 500 码点，不超 1000。
    expect(validateMessageInput({ body: '😀'.repeat(500) }).ok).toBe(true);
  });

  it('签名：空串合法且归一成 null', () => {
    expect(validateMotto('')).toEqual({ ok: true, value: null });
    expect(validateMotto('   ')).toEqual({ ok: true, value: null });
    expect(validateMotto('  写点东西  ')).toEqual({ ok: true, value: '写点东西' });
    expect(validateMotto('a'.repeat(61)).ok).toBe(false);
  });

  it('页大小：非法用缺省、过大收上限、不报错', () => {
    expect(resolveSocialPageSize(undefined)).toBe(20);
    expect(resolveSocialPageSize('abc')).toBe(20);
    expect(resolveSocialPageSize(0)).toBe(20);
    expect(resolveSocialPageSize(-3)).toBe(20);
    expect(resolveSocialPageSize(999)).toBe(50);
    expect(resolveSocialPageSize('7')).toBe(7);
    expect(resolveDmPageSize(9999)).toBe(200);
    expect(resolveDmPageSize(10)).toBe(10);
  });
});

/* ==========================================================================
   纯规则：私信申请三态
   ========================================================================== */

describe('私信发送许可', () => {
  const base = { senderId: 'me', recipientId: 'you', recipientIsAdmin: false };

  it('不能给自己发', () => {
    const outcome = decideMessagePermission({
      ...base,
      senderId: 'me',
      recipientId: 'me',
      contactStatus: null,
    });
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) {
      expect(outcome.failure.code).toBe('SOCIAL_SELF_MESSAGE');
    }
  });

  it('无关系 → 允许但必须建申请', () => {
    expect(decideMessagePermission({ ...base, contactStatus: null })).toEqual({
      allowed: true,
      createsRequest: true,
    });
  });

  it('已有申请未处理 → 拒绝（只准发一条）', () => {
    const outcome = decideMessagePermission({ ...base, contactStatus: 'request' });
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) {
      expect(outcome.failure.code).toBe('SOCIAL_DM_PENDING');
    }
  });

  it('已被拒绝 → 拒绝', () => {
    const outcome = decideMessagePermission({ ...base, contactStatus: 'declined' });
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) {
      expect(outcome.failure.code).toBe('SOCIAL_DM_DECLINED');
    }
  });

  it('已同意 → 放行且不再建申请', () => {
    expect(decideMessagePermission({ ...base, contactStatus: 'accepted' })).toEqual({
      allowed: true,
      createsRequest: false,
    });
  });

  it('收件人是管理员 → 直接放行，无视关系', () => {
    for (const status of [null, 'request', 'declined'] as Array<DmContactStatusValue | null>) {
      expect(
        decideMessagePermission({ ...base, recipientIsAdmin: true, contactStatus: status }),
      ).toEqual({ allowed: true, createsRequest: false });
    }
  });
});

describe('申请处理权限', () => {
  it('只有收件人本人能处理', () => {
    const outcome = decideContactReview({
      viewerId: 'other',
      ownerId: 'me',
      currentStatus: 'request',
    });
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) {
      expect(outcome.failure.code).toBe('SOCIAL_CONVERSATION_FORBIDDEN');
    }
  });

  it('只有 request 状态可处理', () => {
    for (const status of ['accepted', 'declined', null] as Array<DmContactStatusValue | null>) {
      expect(
        decideContactReview({ viewerId: 'me', ownerId: 'me', currentStatus: status }).allowed,
      ).toBe(false);
    }
    expect(
      decideContactReview({ viewerId: 'me', ownerId: 'me', currentStatus: 'request' }).allowed,
    ).toBe(true);
  });
});

/* ==========================================================================
   纯规则：展示裁剪与访问节流
   ========================================================================== */

describe('空间展示裁剪', () => {
  const settings: SpaceSettingsRecord = {
    showStats: false,
    showPosts: false,
    showAchievements: false,
    motto: '签名',
  };

  it('看自己无视开关', () => {
    expect(spaceSectionsFor({ viewerId: 'me', ownerId: 'me', settings })).toEqual({
      stats: true,
      posts: true,
      achievements: true,
      motto: '签名',
    });
  });

  it('看他人按开关裁剪', () => {
    expect(spaceSectionsFor({ viewerId: 'other', ownerId: 'me', settings })).toEqual({
      stats: false,
      posts: false,
      achievements: false,
      motto: '签名',
    });
  });

  it('未登录按访客处理', () => {
    expect(spaceSectionsFor({ viewerId: null, ownerId: 'me', settings }).stats).toBe(false);
  });

  it('没有设置记录时用默认（全开）', () => {
    expect(visibleSpaceSections({ viewerId: 'other', ownerId: 'me', settings: null })).toEqual({
      stats: true,
      posts: true,
      achievements: true,
      motto: null,
    });
  });
});

describe('访问计数节流', () => {
  it('头一次一定计入', () => {
    expect(shouldCountVisit({ lastVisitAt: null, now: NOW })).toBe(true);
  });

  it('一小时内不重复计入', () => {
    const just = new Date(NOW.getTime() - 30 * 60 * 1000);
    expect(shouldCountVisit({ lastVisitAt: just, now: NOW })).toBe(false);
  });

  it('超过一小时计入', () => {
    const old = new Date(NOW.getTime() - 61 * 60 * 1000);
    expect(shouldCountVisit({ lastVisitAt: old, now: NOW })).toBe(true);
  });
});

/* ==========================================================================
   纯规则：幂等键
   ========================================================================== */

describe('幂等键', () => {
  it('签到键含用户与日期', () => {
    expect(checkinDedupKey('u1', '2026-03-01')).toBe('checkin:u1:2026-03-01');
    expect(checkinDedupKey('u1', '2026-03-02')).not.toBe(checkinDedupKey('u1', '2026-03-01'));
  });
});

/* ==========================================================================
   纯规则：成就
   ========================================================================== */

describe('成就等级与进度', () => {
  it('levelFor 取已达成的最高等级', () => {
    const thresholds = [1, 5, 20, 50];
    expect(levelFor(thresholds, 0)).toBe(0);
    expect(levelFor(thresholds, 1)).toBe(1);
    expect(levelFor(thresholds, 4)).toBe(1);
    expect(levelFor(thresholds, 5)).toBe(2);
    expect(levelFor(thresholds, 999)).toBe(4);
  });

  it('进度含下一级门槛，满级时 next 为 null', () => {
    const definition = {
      id: 'x',
      name: 'X',
      description: '',
      thresholds: [1, 5],
      valueOf: (s: AchievementStats) => s.postCount,
    };

    const zero = progressOf(definition, statsOf({ postCount: 0 }));
    expect(zero.level).toBe(0);
    expect(zero.nextThreshold).toBe(1);
    expect(zero.maxed).toBe(false);

    const one = progressOf(definition, statsOf({ postCount: 3 }));
    expect(one.level).toBe(1);
    expect(one.currentThreshold).toBe(1);
    expect(one.nextThreshold).toBe(5);

    const maxed = progressOf(definition, statsOf({ postCount: 5 }));
    expect(maxed.level).toBe(2);
    expect(maxed.maxed).toBe(true);
    expect(maxed.nextThreshold).toBeNull();
  });

  it('定义表的 id 唯一', () => {
    const ids = ACHIEVEMENTS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('定义表的阈值升序且非空', () => {
    for (const definition of ACHIEVEMENTS) {
      expect(definition.thresholds.length).toBeGreaterThan(0);
      const sorted = [...definition.thresholds].sort((a, b) => a - b);
      expect(definition.thresholds).toEqual(sorted);
    }
  });

  it('buildHistory 折叠出历史最高等级与首次解锁时间', () => {
    const unlocks: AchievementUnlock[] = [
      { achievementId: 'author', level: 3, unlockedAt: new Date('2026-03-03T00:00:00Z') },
      { achievementId: 'author', level: 1, unlockedAt: new Date('2026-03-01T00:00:00Z') },
      { achievementId: 'author', level: 2, unlockedAt: new Date('2026-03-02T00:00:00Z') },
    ];
    const history = buildHistory(unlocks).get('author');
    expect(history?.highestLevel).toBe(3);
    // 首次解锁取最早的（不是数组里第一条）。
    expect(history?.firstUnlockedAt).toEqual(new Date('2026-03-01T00:00:00Z'));
    expect(history?.levels.map((item) => item.level)).toEqual([1, 2, 3]);
  });
});

/* ==========================================================================
   执行顺序：假端口
   ========================================================================== */

type Store = {
  notifications: Map<string, NotificationRecord & { recipientId: string; dedupKey: string | null }>;
  balances: Map<string, number>;
  transactions: PointTransactionRecord[];
  transactionDedup: Set<string>;
  checkins: CheckinRecord[];
  contacts: Map<string, DmContactRecord>;
  messages: DirectMessageRecord[];
  spaceSettings: Map<string, SpaceSettingsRecord>;
  stats: Map<string, { visitCount: number; lastVisitAt: Date | null }>;
  unlocks: Array<{ achievementId: string; level: number; unlockedAt: Date }>;
  sequence: number;
};

function emptyStore(): Store {
  return {
    notifications: new Map(),
    balances: new Map(),
    transactions: [],
    transactionDedup: new Set(),
    checkins: [],
    contacts: new Map(),
    messages: [],
    spaceSettings: new Map(),
    stats: new Map(),
    unlocks: [],
    sequence: 0,
  };
}

/**
 * 假端口。**刻意复现真实约束**：
 * - 通知写入撞 `(recipientId, dedupKey)` 唯一索引 → 返回 false；
 * - 积分写入撞 `(userId, dedupKey)` → applied: false 且余额不动；
 * - 签到插入撞 `(userId, checkinDate)` 主键 → 返回 false；
 * - 私信申请插入撞 `(ownerId, peerId)` 主键 → 返回 false。
 *
 * 如果假端口不模拟这些冲突，测试就验不出「幂等靠约束」这条设计。
 */
function createPorts(store: Store = emptyStore()): SocialPorts & { store: Store } {
  // 时间固定为 NOW；需要推进的用例自己替换 `ports.now`（见 `advanceTo` 注释），
  // 不在这里留可变时钟，避免「改了 clock 却发现断言走的是另一条时钟」。
  const ports: SocialPorts = {
    now: () => NOW,
    newId: () => {
      store.sequence += 1;
      return `id-${store.sequence}`;
    },
    notifications: {
      create: async (input) => {
        if (input.dedupKey !== null) {
          const exists = [...store.notifications.values()].some(
            (row) => row.recipientId === input.recipientId && row.dedupKey === input.dedupKey,
          );
          if (exists) {
            return false;
          }
        }
        store.notifications.set(input.id, {
          id: input.id,
          category: input.category,
          type: input.type,
          actorId: input.actorId,
          link: input.link,
          title: input.title,
          body: input.body,
          read: false,
          createdAt: input.now,
          recipientId: input.recipientId,
          dedupKey: input.dedupKey,
        });
        return true;
      },
      listForUser: async (params) => {
        let rows = [...store.notifications.values()].filter(
          (row) => row.recipientId === params.userId,
        );
        if (params.category !== null) {
          rows = rows.filter((row) => row.category === params.category);
        }
        rows.sort((a, b) => {
          const byTime = b.createdAt.getTime() - a.createdAt.getTime();
          return byTime === 0 ? b.id.localeCompare(a.id) : byTime;
        });
        if (params.cursorCreatedAt && params.cursorId) {
          rows = rows.filter((row) => {
            const byTime = row.createdAt.getTime() - params.cursorCreatedAt!.getTime();
            return byTime < 0 || (byTime === 0 && row.id.localeCompare(params.cursorId!) < 0);
          });
        }
        return rows.slice(0, params.limit);
      },
      countUnread: async (userId) =>
        [...store.notifications.values()].filter((row) => row.recipientId === userId && !row.read)
          .length,
      markRead: async (params) => {
        let marked = 0;
        for (const row of store.notifications.values()) {
          if (row.recipientId !== params.userId || row.read) {
            continue;
          }
          if (params.ids !== null && !params.ids.includes(row.id)) {
            continue;
          }
          row.read = true;
          marked += 1;
        }
        return marked;
      },
    },
    points: {
      apply: async (input) => {
        if (input.dedupKey !== null) {
          const key = `${input.userId}:${input.dedupKey}`;
          if (store.transactionDedup.has(key)) {
            return { applied: false, balance: store.balances.get(input.userId) ?? 0 };
          }
          store.transactionDedup.add(key);
        }
        const balance = (store.balances.get(input.userId) ?? 0) + input.delta;
        store.balances.set(input.userId, balance);
        store.transactions.push({
          id: input.transactionId,
          delta: input.delta,
          balance,
          reason: input.reason,
          detail: input.detail,
          createdAt: input.now,
        });
        return { applied: true, balance };
      },
      getBalance: async (userId) => store.balances.get(userId) ?? 0,
      listTransactions: async (params) =>
        store.transactions.filter((row) => row.id !== '').slice(0, params.limit),
    },
    checkins: {
      insert: async (input) => {
        const exists = store.checkins.some((row) => row.checkinDate === input.checkinDate);
        if (exists) {
          return false;
        }
        store.checkins.push({
          checkinDate: input.checkinDate,
          points: input.points,
          streak: input.streak,
          createdAt: input.now,
        });
        return true;
      },
      findLatest: async () => {
        const sorted = [...store.checkins].sort((a, b) =>
          b.checkinDate.localeCompare(a.checkinDate),
        );
        return sorted[0] ?? null;
      },
      listRecent: async (params) =>
        [...store.checkins]
          .sort((a, b) => b.checkinDate.localeCompare(a.checkinDate))
          .slice(0, params.limit),
    },
    messages: {
      insert: async (input) => {
        store.messages.push({
          id: input.id,
          fromUserId: input.fromUserId,
          toUserId: input.toUserId,
          body: input.body,
          createdAt: input.now,
          readAt: null,
        });
      },
      listConversation: async (params) =>
        store.messages
          .filter(
            (row) =>
              (row.fromUserId === params.viewerId && row.toUserId === params.peerId) ||
              (row.fromUserId === params.peerId && row.toUserId === params.viewerId),
          )
          .slice(0, params.limit),
      markConversationRead: async (params) => {
        let marked = 0;
        for (const row of store.messages) {
          if (row.toUserId === params.viewerId && row.fromUserId === params.peerId && !row.readAt) {
            row.readAt = params.now;
            marked += 1;
          }
        }
        return marked;
      },
      countUnread: async (viewerId) =>
        store.messages.filter((row) => row.toUserId === viewerId && !row.readAt).length,
      listPendingRequests: async (viewerId) =>
        [...store.contacts.values()].filter(
          (row) => row.ownerId === viewerId && row.status === 'request',
        ),
      findContact: async (params) =>
        store.contacts.get(`${params.ownerId}:${params.peerId}`) ?? null,
      insertContact: async (input) => {
        const key = `${input.ownerId}:${input.peerId}`;
        if (store.contacts.has(key)) {
          return false;
        }
        store.contacts.set(key, {
          ownerId: input.ownerId,
          peerId: input.peerId,
          status: 'request',
          updatedAt: input.now,
        });
        return true;
      },
      updateContactStatus: async (params) => {
        const key = `${params.ownerId}:${params.peerId}`;
        const existing = store.contacts.get(key);
        if (existing) {
          store.contacts.set(key, { ...existing, status: params.status, updatedAt: params.now });
        }
      },
    },
    space: {
      findSettings: async (userId) => store.spaceSettings.get(userId) ?? null,
      upsertSettings: async (params) => {
        store.spaceSettings.set(params.userId, params.settings);
      },
      recordVisit: async (params) => {
        const current = store.stats.get(params.userId) ?? { visitCount: 0, lastVisitAt: null };
        store.stats.set(params.userId, {
          visitCount: current.visitCount + 1,
          lastVisitAt: params.now,
        });
        return true;
      },
      findStats: async (userId) => store.stats.get(userId) ?? null,
    },
    achievements: {
      insertUnlocks: async (rows) => {
        for (const row of rows) {
          const exists = store.unlocks.some(
            (item) => item.achievementId === row.achievementId && item.level === row.level,
          );
          if (!exists) {
            store.unlocks.push({
              achievementId: row.achievementId,
              level: row.level,
              unlockedAt: row.now,
            });
          }
        }
      },
      listUnlocks: async () => store.unlocks,
    },
  };

  return Object.assign(ports, { store });
}

function statsOf(overrides: Partial<AchievementStats> = {}): AchievementStats {
  return {
    postCount: 0,
    commentCount: 0,
    checkinCount: 0,
    likesReceived: 0,
    visitCount: 0,
    currentStreak: 0,
    ...overrides,
  };
}

/* ==========================================================================
   执行顺序：签到
   ========================================================================== */

describe('签到', () => {
  it('首次签到发基础积分并写流水', async () => {
    const ports = createPorts();
    const outcome = await checkin(ports, { userId: 'u1' });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.points).toBe(5);
      expect(outcome.value.streak).toBe(1);
      expect(outcome.value.balance).toBe(5);
    }
    expect(ports.store.transactions).toHaveLength(1);
    expect(ports.store.transactions[0]?.reason).toBe('checkin');
  });

  it('同一天再签 → alreadyCheckedIn，且不再发分', async () => {
    const ports = createPorts();
    await checkin(ports, { userId: 'u1' });
    const second = await checkin(ports, { userId: 'u1' });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.failure.code).toBe('SOCIAL_ALREADY_CHECKED_IN');
      expect(second.failure.status).toBe(409);
    }
    // 关键：余额没变、流水没多。
    expect(ports.store.balances.get('u1')).toBe(5);
    expect(ports.store.transactions).toHaveLength(1);
  });

  it('连续两天签到 → streak 累加到 2', async () => {
    const ports = createPorts();
    await checkin(ports, { userId: 'u1' });

    // 把假端口的时间推后一天（同一时刻 +24h）。
    const nextDay = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const mutable = ports as unknown as { now: () => Date };
    mutable.now = () => nextDay;

    const second = await checkin(ports, { userId: 'u1' });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.streak).toBe(2);
      expect(second.value.balance).toBe(10);
    }
  });

  it('断签一天后 streak 重置为 1（但余额继续累加）', async () => {
    const ports = createPorts();
    await checkin(ports, { userId: 'u1' });

    const mutable = ports as unknown as { now: () => Date };
    mutable.now = () => new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);

    const third = await checkin(ports, { userId: 'u1' });
    expect(third.ok).toBe(true);
    if (third.ok) {
      expect(third.value.streak).toBe(1);
      expect(third.value.balance).toBe(10);
    }
  });

  it('并发下第二次插入失败 → 不发分（幂等靠主键，不靠先查）', async () => {
    const ports = createPorts();
    /*
     * 模拟「两个请求都通过了 findLatest 检查」：先手工塞一行今天的签到，
     * 再调 checkin——此时 findLatest 会看到它并提前返回 alreadyCheckedIn，
     * 那验不到主键这一层。所以直接把 findLatest 换成永远返回 null。
     */
    const mutable = ports as unknown as {
      checkins: { findLatest: () => Promise<CheckinRecord | null> };
    };
    mutable.checkins.findLatest = async () => null;

    await checkin(ports, { userId: 'u1' });
    const balanceAfterFirst = ports.store.balances.get('u1');

    const second = await checkin(ports, { userId: 'u1' });
    expect(second.ok).toBe(false);
    // 即使 findLatest 骗过了检查，主键也挡下了第二次，余额没有翻倍。
    expect(ports.store.balances.get('u1')).toBe(balanceAfterFirst);
  });

  it('getCheckinStatus 反映今天与历史', async () => {
    const ports = createPorts();
    const before = await getCheckinStatus(ports, { userId: 'u1' });
    expect(before.checkedInToday).toBe(false);
    expect(before.streak).toBe(0);
    expect(before.total).toBe(0);

    await checkin(ports, { userId: 'u1' });
    const after = await getCheckinStatus(ports, { userId: 'u1' });
    expect(after.checkedInToday).toBe(true);
    expect(after.streak).toBe(1);
    expect(after.total).toBe(1);
  });
});

/* ==========================================================================
   执行顺序：积分
   ========================================================================== */

describe('积分账本', () => {
  it('发放后余额与流水一致', async () => {
    const ports = createPorts();
    const outcome = await applyPoints(ports, { userId: 'u1', delta: 10, reason: 'admin' });

    expect(outcome.applied).toBe(true);
    expect(outcome.balance).toBe(10);
    expect(await ports.points.getBalance('u1')).toBe(10);
    expect(ports.store.transactions).toHaveLength(1);
  });

  it('同 dedupKey 重复发放只生效一次', async () => {
    const ports = createPorts();
    await applyPoints(ports, { userId: 'u1', delta: 10, reason: 'admin', dedupKey: 'k1' });
    const second = await applyPoints(ports, {
      userId: 'u1',
      delta: 10,
      reason: 'admin',
      dedupKey: 'k1',
    });

    expect(second.applied).toBe(false);
    expect(second.balance).toBe(10);
    expect(ports.store.transactions).toHaveLength(1);
  });

  it('扣减可以把余额减到负数（管理员纠错时允许）', async () => {
    const ports = createPorts();
    await applyPoints(ports, { userId: 'u1', delta: 5, reason: 'admin' });
    const outcome = await applyPoints(ports, { userId: 'u1', delta: -8, reason: 'admin' });
    expect(outcome.balance).toBe(-3);
  });

  it('余额 = 所有流水 delta 之和（不变量）', async () => {
    const ports = createPorts();
    await applyPoints(ports, { userId: 'u1', delta: 5, reason: 'admin' });
    await applyPoints(ports, { userId: 'u1', delta: 3, reason: 'admin' });
    await applyPoints(ports, { userId: 'u1', delta: -2, reason: 'admin' });

    const sum = ports.store.transactions.reduce((total, row) => total + row.delta, 0);
    expect(await ports.points.getBalance('u1')).toBe(sum);
    expect(sum).toBe(6);
  });

  it('listPointTransactions 返回最近的记录', async () => {
    const ports = createPorts();
    await applyPoints(ports, { userId: 'u1', delta: 5, reason: 'admin', detail: '第一笔' });
    const rows = await listPointTransactions(ports, { userId: 'u1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toBe('第一笔');
  });
});

/* ==========================================================================
   执行顺序：私信
   ========================================================================== */

describe('私信与防骚扰', () => {
  const base = { senderId: 'me', recipientId: 'you', recipientIsAdmin: false };

  it('首条消息建申请行并通知对方', async () => {
    const ports = createPorts();
    const outcome = await sendMessage(ports, { ...base, body: '你好' });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.createdRequest).toBe(true);
    }
    expect(ports.store.contacts.get('you:me')?.status).toBe('request');
    expect(ports.store.messages).toHaveLength(1);
    // 通知给了收件人，类型是「申请」。
    const rows = [...ports.store.notifications.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('dm_request');
    expect(rows[0]?.recipientId).toBe('you');
  });

  it('未获同意时第二条被拒，不写消息', async () => {
    const ports = createPorts();
    await sendMessage(ports, { ...base, body: '第一条' });
    const second = await sendMessage(ports, { ...base, body: '第二条' });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.failure.code).toBe('SOCIAL_DM_PENDING');
    }
    expect(ports.store.messages).toHaveLength(1);
  });

  it('并发建申请：第二个请求插不进就不发消息', async () => {
    const ports = createPorts();
    // 先手工占住关系行，模拟「别人抢先建了申请」。
    await ports.messages.insertContact({ ownerId: 'you', peerId: 'me', now: NOW });
    /*
     * 同时让 findContact 假装看不到这行（模拟两个请求并发通过关系检查），
     * 这样才会走到 insertContact 并拿到 false。
     */
    const mutable = ports as unknown as {
      messages: { findContact: () => Promise<DmContactRecord | null> };
    };
    mutable.messages.findContact = async () => null;

    const outcome = await sendMessage(ports, { ...base, body: '并发' });
    expect(outcome.ok).toBe(false);
    expect(ports.store.messages).toHaveLength(0);
  });

  it('同意后可以自由互发', async () => {
    const ports = createPorts();
    await sendMessage(ports, { ...base, body: '你好' });
    const reviewed = await reviewContactRequest(ports, {
      viewerId: 'you',
      peerId: 'me',
      decision: 'accepted',
    });
    expect(reviewed.ok).toBe(true);
    expect(ports.store.contacts.get('you:me')?.status).toBe('accepted');

    const again = await sendMessage(ports, { ...base, body: '再聊' });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.value.createdRequest).toBe(false);
    }
    expect(ports.store.messages).toHaveLength(2);
  });

  it('拒绝后不能再发', async () => {
    const ports = createPorts();
    await sendMessage(ports, { ...base, body: '你好' });
    await reviewContactRequest(ports, { viewerId: 'you', peerId: 'me', decision: 'declined' });

    const outcome = await sendMessage(ports, { ...base, body: '在吗' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.code).toBe('SOCIAL_DM_DECLINED');
    }
  });

  it('同意会通知发起者（且只通知一次）', async () => {
    const ports = createPorts();
    await sendMessage(ports, { ...base, body: '你好' });
    await reviewContactRequest(ports, { viewerId: 'you', peerId: 'me', decision: 'accepted' });

    const acceptedRows = [...ports.store.notifications.values()].filter(
      (row) => row.type === 'dm_accepted',
    );
    expect(acceptedRows).toHaveLength(1);
    expect(acceptedRows[0]?.recipientId).toBe('me');

    // 再处理一次：状态已经不是 request，会被拒，且不再产生新通知。
    await reviewContactRequest(ports, { viewerId: 'you', peerId: 'me', decision: 'accepted' });
    expect(
      [...ports.store.notifications.values()].filter((row) => row.type === 'dm_accepted'),
    ).toHaveLength(1);
  });

  it('不能给自己发', async () => {
    const ports = createPorts();
    const outcome = await sendMessage(ports, {
      senderId: 'me',
      recipientId: 'me',
      recipientIsAdmin: false,
      body: '自己',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.code).toBe('SOCIAL_SELF_MESSAGE');
    }
  });

  it('收件人是管理员时无需申请', async () => {
    const ports = createPorts();
    const outcome = await sendMessage(ports, {
      senderId: 'me',
      recipientId: 'admin',
      recipientIsAdmin: true,
      body: '求助',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.createdRequest).toBe(false);
    }
    expect(ports.store.contacts.size).toBe(0);
  });

  it('读会话会把发给我的标记为已读', async () => {
    const ports = createPorts();
    await sendMessage(ports, { ...base, body: '你好' });
    expect(await ports.messages.countUnread('you')).toBe(1);

    await readConversation(ports, { viewerId: 'you', peerId: 'me' });
    expect(await ports.messages.countUnread('you')).toBe(0);
  });
});

/* ==========================================================================
   执行顺序：通知
   ========================================================================== */

describe('通知', () => {
  it('同一条去重键只留一条', async () => {
    const ports = createPorts();
    const input = {
      recipientId: 'u1',
      category: 'social' as NotificationCategory,
      type: 'post_comment',
      actorId: 'u2',
      targetId: 'post-1',
    };

    const first = await notify(ports, input);
    const second = await notify(ports, input);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(ports.store.notifications.size).toBe(1);
  });

  it('不同触发者各留一条（去重键含 actorId）', async () => {
    const ports = createPorts();
    await notify(ports, {
      recipientId: 'u1',
      category: 'social',
      type: 'post_comment',
      actorId: 'u2',
      targetId: 'post-1',
    });
    await notify(ports, {
      recipientId: 'u1',
      category: 'social',
      type: 'post_comment',
      actorId: 'u3',
      targetId: 'post-1',
    });
    expect(ports.store.notifications.size).toBe(2);
  });

  it('不给自己发通知', async () => {
    const ports = createPorts();
    const created = await notify(ports, {
      recipientId: 'u1',
      category: 'social',
      type: 'post_comment',
      actorId: 'u1',
      targetId: 'post-1',
    });
    expect(created).toBe(false);
    expect(ports.store.notifications.size).toBe(0);
  });

  it('dedupKey 显式传 null 时不去重（私信这类）', async () => {
    const ports = createPorts();
    const base = {
      recipientId: 'u1',
      category: 'social' as NotificationCategory,
      type: 'dm_message',
      actorId: 'u2',
      targetId: 'u1',
      dedupKey: null,
    };
    await notify(ports, { ...base, body: '第一条' });
    await notify(ports, { ...base, body: '第二条' });
    expect(ports.store.notifications.size).toBe(2);
  });

  it('未读数与标记已读', async () => {
    const ports = createPorts();
    await notify(ports, {
      recipientId: 'u1',
      category: 'social',
      type: 'post_comment',
      actorId: 'u2',
      targetId: 'post-1',
    });
    await notify(ports, {
      recipientId: 'u1',
      category: 'site',
      type: 'announcement',
      actorId: null,
      targetId: 'ann-1',
      dedupKey: null,
    });

    expect(await countUnreadNotifications(ports, { userId: 'u1' })).toBe(2);

    const marked = await markNotificationsRead(ports, { userId: 'u1', ids: null });
    expect(marked.marked).toBe(2);
    expect(await countUnreadNotifications(ports, { userId: 'u1' })).toBe(0);
  });

  it('标记已读只影响自己的行', async () => {
    const ports = createPorts();
    await notify(ports, {
      recipientId: 'u1',
      category: 'social',
      type: 'x',
      actorId: 'u2',
      targetId: 't',
      dedupKey: null,
    });
    await notify(ports, {
      recipientId: 'u9',
      category: 'social',
      type: 'x',
      actorId: 'u2',
      targetId: 't',
      dedupKey: null,
    });

    await markNotificationsRead(ports, { userId: 'u1', ids: null });
    expect(await countUnreadNotifications(ports, { userId: 'u9' })).toBe(1);
  });

  it('列表按分类筛选并支持游标翻页', async () => {
    const ports = createPorts();
    for (let i = 0; i < 3; i += 1) {
      await notify(ports, {
        recipientId: 'u1',
        category: 'social',
        type: 't',
        actorId: `actor-${i}`,
        targetId: `target-${i}`,
      });
    }
    await notify(ports, {
      recipientId: 'u1',
      category: 'site',
      type: 'site-only',
      actorId: null,
      targetId: 's',
      dedupKey: null,
    });

    const social = await listNotifications(ports, { userId: 'u1', category: 'social', limit: 10 });
    expect(social.ok).toBe(true);
    if (social.ok) {
      expect(social.items).toHaveLength(3);
      expect(social.nextCursor).toBeNull();
    }

    const firstPage = await listNotifications(ports, { userId: 'u1', category: null, limit: 2 });
    expect(firstPage.ok).toBe(true);
    if (firstPage.ok) {
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();
    }
  });
});

/* ==========================================================================
   执行顺序：空间与成就
   ========================================================================== */

describe('空间设置', () => {
  it('保存后能读回', async () => {
    const ports = createPorts();
    const saved = await saveSpaceSettings(ports, {
      userId: 'u1',
      showStats: false,
      showPosts: true,
      showAchievements: false,
      motto: '  你好  ',
    });
    expect(saved.ok).toBe(true);
    expect(ports.store.spaceSettings.get('u1')).toEqual({
      showStats: false,
      showPosts: true,
      showAchievements: false,
      motto: '你好',
    });
  });

  it('签名超长被拒且不落库', async () => {
    const ports = createPorts();
    const outcome = await saveSpaceSettings(ports, {
      userId: 'u1',
      showStats: true,
      showPosts: true,
      showAchievements: true,
      motto: 'a'.repeat(61),
    });
    expect(outcome.ok).toBe(false);
    expect(ports.store.spaceSettings.size).toBe(0);
  });

  it('空签名落库成 null', async () => {
    const ports = createPorts();
    await saveSpaceSettings(ports, {
      userId: 'u1',
      showStats: true,
      showPosts: true,
      showAchievements: true,
      motto: '   ',
    });
    expect(ports.store.spaceSettings.get('u1')?.motto).toBeNull();
  });
});

describe('空间读取与访问计数', () => {
  it('没设置过时读回默认（三个分区全开）', async () => {
    const ports = createPorts();
    const settings = await getSpaceSettings(ports, { userId: 'u1' });
    expect(settings).toEqual({
      showStats: true,
      showPosts: true,
      showAchievements: true,
      motto: null,
    });
  });

  it('设置过之后读回存下来的值', async () => {
    const ports = createPorts();
    await saveSpaceSettings(ports, {
      userId: 'u1',
      showStats: false,
      showPosts: false,
      showAchievements: true,
      motto: '你好',
    });
    const settings = await getSpaceSettings(ports, { userId: 'u1' });
    expect(settings.showStats).toBe(false);
    expect(settings.showAchievements).toBe(true);
    expect(settings.motto).toBe('你好');
  });

  it('头一次访问计入，一小时内再访问不重复计入', async () => {
    const ports = createPorts();
    const first = await recordSpaceVisit(ports, { userId: 'u1' });
    expect(first).toBe(true);
    expect((await getSpaceStats(ports, { userId: 'u1' })).visitCount).toBe(1);

    // 同一时刻再访问：节流窗口内，不计入。
    const second = await recordSpaceVisit(ports, { userId: 'u1' });
    expect(second).toBe(false);
    expect((await getSpaceStats(ports, { userId: 'u1' })).visitCount).toBe(1);
  });

  it('超过一小时后再访问重新计入', async () => {
    const ports = createPorts();
    await recordSpaceVisit(ports, { userId: 'u1' });

    const mutable = ports as unknown as { now: () => Date };
    mutable.now = () => new Date(NOW.getTime() + 61 * 60 * 1000);

    const again = await recordSpaceVisit(ports, { userId: 'u1' });
    expect(again).toBe(true);
    expect((await getSpaceStats(ports, { userId: 'u1' })).visitCount).toBe(2);
  });

  it('从没访问过的用户访问次数为 0', async () => {
    const ports = createPorts();
    expect((await getSpaceStats(ports, { userId: 'nobody' })).visitCount).toBe(0);
  });
});

describe('成就落库', () => {
  it('补写 1..currentLevel 的每一级，跳过已存在的', async () => {
    const ports = createPorts();
    const progress: AchievementProgress[] = [
      {
        id: 'author',
        name: '写作',
        description: '',
        value: 7,
        level: 2,
        currentThreshold: 5,
        nextThreshold: 20,
        maxLevel: 4,
        maxed: false,
      },
    ];
    const existing: AchievementUnlock[] = [
      { achievementId: 'author', level: 1, unlockedAt: new Date('2026-01-01T00:00:00Z') },
    ];
    /*
     * 先把「已存在第 1 级」这件事真的落进 store：`existing` 参数只是领域层的输入，
     * 它不代表数据库里已经有行。测试要验的是「插入时撞主键不会覆盖原解锁时间」，
     * 所以必须让假端口的存储里真的有那一行。
     */
    ports.store.unlocks.push({
      achievementId: 'author',
      level: 1,
      unlockedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const written = await persistUnlocks(ports, { userId: 'u1', progress, existing });
    // 只有第 2 级是缺的。
    expect(written).toBe(1);
    // 第 1 级保留原来的解锁时间，没有被覆盖。
    const level1 = ports.store.unlocks.find((row) => row.level === 1);
    expect(level1?.unlockedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(ports.store.unlocks).toHaveLength(2);
  });
  it('没有新等级时不写任何行', async () => {
    const ports = createPorts();
    const progress: AchievementProgress[] = [
      {
        id: 'author',
        name: '写作',
        description: '',
        value: 1,
        level: 1,
        currentThreshold: 1,
        nextThreshold: 5,
        maxLevel: 4,
        maxed: false,
      },
    ];
    const written = await persistUnlocks(ports, {
      userId: 'u1',
      progress,
      existing: [{ achievementId: 'author', level: 1, unlockedAt: NOW }],
    });
    expect(written).toBe(0);
    expect(ports.store.unlocks).toHaveLength(0);
  });

  it('重复调用不会重复写（幂等）', async () => {
    const ports = createPorts();
    const progress = listAchievementProgress(statsOf({ postCount: 3 }));
    await persistUnlocks(ports, { userId: 'u1', progress, existing: [] });
    const sizeAfterFirst = ports.store.unlocks.length;

    const existing = ports.store.unlocks.map((row) => ({
      achievementId: row.achievementId,
      level: row.level,
      unlockedAt: row.unlockedAt,
    }));
    const written = await persistUnlocks(ports, { userId: 'u1', progress, existing });
    expect(written).toBe(0);
    expect(ports.store.unlocks.length).toBe(sizeAfterFirst);
  });
});
