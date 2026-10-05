/**
 * 成就：定义表 + 纯计算。
 *
 * ## 成就是「算出来」的，不是「存出来」的
 *
 * 进度每次按当前数据实时算，**不落库**。数据库里的 `user_achievements` 只记一件事：
 * 「首次达成某成就某等级的时间」——那个时间点推不出来，必须存。
 *
 * 这样做的好处是「进度永远和数据一致」：删了一篇帖子，帖子数成就的进度立刻跟着降，
 * 不需要任何补偿逻辑。代价是每次看成就页都要重算一遍（数据量小，可接受）。
 *
 * ## 等级回落不删历史
 *
 * 资源被删导致等级下降时，`user_achievements` 的历史行**保留**。页面展示
 * 「历史最高等级」与首次解锁时间，当前等级以实时计算为准。这两者同时存在不矛盾：
 * 「曾经到过」是一个事实，不会因为现在没到而消失。
 *
 * ## 加一个成就要做的事
 *
 * 1. 在 `ACHIEVEMENTS` 里加一项（id、名称、描述、等级阈值、取值函数）；
 * 2. **不需要改迁移**：`achievement_id` 无外键，定义在代码里。
 *
 * 这也是为什么 `achievement_id` 没有外键——见 `schema/social.ts` 的注释。
 */
import type { SocialPorts } from './types';

/**
 * 成就的进度来源。
 *
 * 每个成都要一个数字（帖子数、签到天数、收到的赞……）。这些数字**不由本模块查询**：
 * 调用方（页面装配）算好一个 `AchievementStats` 传进来。理由与 `space.ts` 相同——
 * 领域层不该知道帖子和点赞表的形状。
 */
export type AchievementStats = {
  /** 发过的帖子数。 */
  postCount: number;
  /** 发过的评论数。 */
  commentCount: number;
  /** 累计签到天数。 */
  checkinCount: number;
  /** 收到的点赞总数。 */
  likesReceived: number;
  /** 站点访问累计次数（`user_stats`）。 */
  visitCount: number;
  /** 当前连续签到天数。 */
  currentStreak: number;
};

/** 成就定义。`thresholds` 是各等级的达标线，升序。 */
export type AchievementDefinition = {
  id: string;
  name: string;
  description: string;
  /** 各等级阈值，升序。`thresholds[i]` 是第 `i+1` 级的达标线。 */
  thresholds: readonly number[];
  /** 从统计数据里取这个成就的进度值。 */
  valueOf: (stats: AchievementStats) => number;
};

/**
 * 成就定义表。
 *
 * 阈值只到 3–4 级：等级再多，达成曲线会拉得很长而中段毫无反馈。参考实现的等级更多，
 * 但那些等级绑定的是它自己的资源体系（域名、存储、AI 额度），本站没有。
 */
export const ACHIEVEMENTS: readonly AchievementDefinition[] = [
  {
    id: 'author',
    name: '写作',
    description: '在社区里发布帖子。',
    thresholds: [1, 5, 20, 50],
    valueOf: (stats) => stats.postCount,
  },
  {
    id: 'discussion',
    name: '讨论',
    description: '参与评论。',
    thresholds: [1, 10, 50, 200],
    valueOf: (stats) => stats.commentCount,
  },
  {
    id: 'checkin',
    name: '坚持',
    description: '累计签到天数。',
    thresholds: [1, 7, 30, 100],
    valueOf: (stats) => stats.checkinCount,
  },
  {
    id: 'streak',
    name: '连签',
    description: '连续签到的天数。',
    thresholds: [3, 7, 30],
    valueOf: (stats) => stats.currentStreak,
  },
  {
    id: 'popular',
    name: '受欢迎',
    description: '你的内容收到的点赞总数。',
    thresholds: [1, 10, 50, 200],
    valueOf: (stats) => stats.likesReceived,
  },
  {
    id: 'visitor',
    name: '常来',
    description: '访问站点的累计次数。',
    thresholds: [1, 10, 50, 200],
    valueOf: (stats) => stats.visitCount,
  },
];

/** 单个成就的实时进度。 */
export type AchievementProgress = {
  id: string;
  name: string;
  description: string;
  /** 当前进度值。 */
  value: number;
  /** 实时算出的当前等级。0 = 还没达成任何等级。 */
  level: number;
  /** 当前等级的门槛（已满级时为最高阈值），用于算「还差多少」。 */
  currentThreshold: number;
  /** 下一级的门槛。已满级为 null。 */
  nextThreshold: number | null;
  /** 最高等级。 */
  maxLevel: number;
  /** 是否已满级。 */
  maxed: boolean;
};

/**
 * 由进度值算等级：**返回「已达成的最高等级」**，0 表示一级都没到。
 *
 * 从高往低找第一个达标线，找不到就是 0。用倒序是因为阈值升序且等级数很少（≤4），
 * 正序累加也可以，倒序更直白。
 */
export function levelFor(thresholds: readonly number[], value: number): number {
  for (let i = thresholds.length - 1; i >= 0; i -= 1) {
    if (value >= thresholds[i]!) {
      return i + 1;
    }
  }
  return 0;
}

/** 算一个成就的实时进度。纯函数，可直接测。 */
export function progressOf(
  definition: AchievementDefinition,
  stats: AchievementStats,
): AchievementProgress {
  const value = definition.valueOf(stats);
  const level = levelFor(definition.thresholds, value);
  const maxLevel = definition.thresholds.length;
  const maxed = level >= maxLevel;

  /*
   * 当前等级的门槛：level 为 0 时用 0（还没到任何一档，进度条从 0 起）。
   * 已满级时 currentThreshold 与 nextThreshold 都指向最高阈值 / null。
   */
  const currentThreshold = level === 0 ? 0 : definition.thresholds[level - 1]!;
  const nextThreshold = maxed ? null : definition.thresholds[level]!;

  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    value,
    level,
    currentThreshold,
    nextThreshold,
    maxLevel,
    maxed,
  };
}

/** 全部成就的实时进度。顺序与定义表一致（页面按这个顺序渲染）。 */
export function listAchievementProgress(stats: AchievementStats): AchievementProgress[] {
  return ACHIEVEMENTS.map((definition) => progressOf(definition, stats));
}

/** 已解锁记录（从数据库读出来的）。 */
export type AchievementUnlock = {
  achievementId: string;
  level: number;
  unlockedAt: Date;
};

/** 每个成就的「历史最高等级」与首次解锁时间。 */
export type AchievementHistory = {
  achievementId: string;
  /** 历史最高等级（含当前已回落的）。 */
  highestLevel: number;
  /** 首次解锁任一等级的时间。 */
  firstUnlockedAt: Date;
  /** 各级的解锁时间，按等级升序。 */
  levels: Array<{ level: number; unlockedAt: Date }>;
};

/**
 * 把解锁行折叠成「每个成一条历史」。
 *
 * 这是纯计算，输入是 `user_achievements` 的行。折叠而不是让页面自己分组：
 * 「历史最高等级」的判定只有一处，页面不需要知道「等级可能回落」这件事。
 */
export function buildHistory(unlocks: AchievementUnlock[]): Map<string, AchievementHistory> {
  const byId = new Map<string, AchievementHistory>();
  for (const unlock of unlocks) {
    const existing = byId.get(unlock.achievementId);
    if (!existing) {
      byId.set(unlock.achievementId, {
        achievementId: unlock.achievementId,
        highestLevel: unlock.level,
        firstUnlockedAt: unlock.unlockedAt,
        levels: [{ level: unlock.level, unlockedAt: unlock.unlockedAt }],
      });
      continue;
    }
    existing.highestLevel = Math.max(existing.highestLevel, unlock.level);
    if (unlock.unlockedAt < existing.firstUnlockedAt) {
      existing.firstUnlockedAt = unlock.unlockedAt;
    }
    existing.levels.push({ level: unlock.level, unlockedAt: unlock.unlockedAt });
  }
  for (const history of byId.values()) {
    history.levels.sort((a, b) => a.level - b.level);
  }
  return byId;
}

/**
 * 把「实时等级」里新达成的等级写进解锁表。
 *
 * **写入是幂等的**：`user_achievements` 的主键是 `(user_id, achievement_id, level)`，
 * 仓储用 `ON CONFLICT DO NOTHING`，重复调用不会重复写。
 *
 * 只补「当前等级及以下还没有记录的等级」：这样回落过的成就不会因为再次达成而
 * 覆盖掉原来的解锁时间（主键冲突直接跳过，保留了最早的那次）。
 */
export async function persistUnlocks(
  ports: SocialPorts,
  request: { userId: string; progress: AchievementProgress[]; existing: AchievementUnlock[] },
): Promise<number> {
  const already = new Set(
    request.existing.map((unlock) => `${unlock.achievementId}:${unlock.level}`),
  );
  const now = ports.now();

  const rows: Array<{ userId: string; achievementId: string; level: number; now: Date }> = [];
  for (const item of request.progress) {
    // 补 1..currentLevel 里缺的每一级（不只是最高级）：中间等级也要留解锁时间，
    // 否则详情里「第 2 级什么时候到的」会是空的。
    for (let level = 1; level <= item.level; level += 1) {
      if (already.has(`${item.id}:${level}`)) {
        continue;
      }
      rows.push({ userId: request.userId, achievementId: item.id, level, now });
    }
  }

  if (rows.length === 0) {
    return 0;
  }
  await ports.achievements.insertUnlocks(rows);
  return rows.length;
}

/** 读某个用户的解锁记录。 */
export async function listUnlocks(
  ports: SocialPorts,
  request: { userId: string },
): Promise<AchievementUnlock[]> {
  const rows = await ports.achievements.listUnlocks(request.userId);
  return rows.map((row) => ({
    achievementId: row.achievementId,
    level: row.level,
    unlockedAt: row.unlockedAt,
  }));
}
