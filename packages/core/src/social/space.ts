/**
 * 个人空间：展示设置与访问计数。
 *
 * ## 空间页是「数据驱动」的
 *
 * 帖子、积分、成就全部由各自的模块实时算出来，本文件**不聚合它们**——那是页面装配的事
 * （`apps/web` 的职责）。这里只负责两件数据库里有、别处推不出来的事：
 *
 * 1. **展示设置**（三个分区开关 + 一句话签名）——用户的选择，不是派生值；
 * 2. **访问计数**——累计量，没有别的表能算出来。
 *
 * 不做「把空间页要的数据都查好返回」的大函数：那会让领域层知道帖子的形状、积分的形状、
 * 成就的形状，等于把四个模块的契约塞进一个文件。页面自己按需调各自的读取函数。
 */
import { shouldCountVisit, validateMotto, visibleSpaceSections } from './rules';
import {
  DEFAULT_SPACE_SETTINGS,
  SOCIAL_FAILURE,
  type SocialPorts,
  type SpaceSettingsRecord,
} from './types';

/** 读展示设置。没设置过时返回默认（三个分区全开），不返回 null 给调用方去判空。 */
export async function getSpaceSettings(
  ports: SocialPorts,
  request: { userId: string },
): Promise<SpaceSettingsRecord> {
  const found = await ports.space.findSettings(request.userId);
  return found ?? DEFAULT_SPACE_SETTINGS;
}

/**
 * 保存展示设置。
 *
 * 三个开关由调用方传入（复选框的勾选状态）。**motto 走校验**：空串是合法的，
 * 表示「不显示签名」并落库成 null。
 */
export async function saveSpaceSettings(
  ports: SocialPorts,
  request: {
    userId: string;
    showStats: boolean;
    showPosts: boolean;
    showAchievements: boolean;
    motto: unknown;
  },
): Promise<{ ok: true } | { ok: false; failure: import('./types').SocialFailure }> {
  const motto = validateMotto(request.motto);
  if (!motto.ok) {
    return motto;
  }

  await ports.space.upsertSettings({
    userId: request.userId,
    settings: {
      showStats: request.showStats,
      showPosts: request.showPosts,
      showAchievements: request.showAchievements,
      motto: motto.value,
    },
    now: ports.now(),
  });

  return { ok: true };
}

/**
 * 记一次空间访问。
 *
 * 节流在 `rules.shouldCountVisit` 里判定：一小时内只计一次。**先判再写**——
 * 不判会让每次渲染都 +1，计数就成了「页面浏览量」而不是「访问人次」。
 *
 * 返回是否计入，让调用方（页面）不必再查一次。
 */
export async function recordSpaceVisit(
  ports: SocialPorts,
  request: { userId: string },
): Promise<boolean> {
  const now = ports.now();
  const stats = await ports.space.findStats(request.userId);
  if (!shouldCountVisit({ lastVisitAt: stats?.lastVisitAt ?? null, now })) {
    return false;
  }
  return ports.space.recordVisit({ userId: request.userId, now });
}

/** 空间页要展示的分区。`viewerId` 为 null 表示未登录（按访客处理）。 */
export function spaceSectionsFor(params: {
  viewerId: string | null;
  ownerId: string;
  settings: SpaceSettingsRecord | null;
}): { stats: boolean; posts: boolean; achievements: boolean; motto: string | null } {
  return visibleSpaceSections(params);
}

/** 读访问统计（累计访问次数）。 */
export async function getSpaceStats(
  ports: SocialPorts,
  request: { userId: string },
): Promise<{ visitCount: number }> {
  const stats = await ports.space.findStats(request.userId);
  return { visitCount: stats?.visitCount ?? 0 };
}

export { SOCIAL_FAILURE };
