/**
 * 批量点赞状态接口：`GET /api/community/posts/likes?ids=a,b,c`。
 *
 * 给列表页挂载后的状态同步用：一页卡片各自发一个单帖请求会把 N 张卡片放大成 N 个请求，
 * 这里一次返回整页的计数与「我有没有点过」。
 *
 * - `ids` 以逗号分隔，去重后查询；空串 / 全空返回空对象而不是 400（幂等读，无收益）；
 * - 未登录照常返回：`counts` 是公开事实，`likedIds` 恒为空数组，与列表页首屏的匿名渲染一致。
 *
 * 「计数是 Redis 缓存、行为如何 best-effort」在 `@xsu/platform/src/cache.ts`；本层只做翻译。
 */
import { NextResponse } from 'next/server';

import { createCommunityPorts } from '@xsu/platform';

import { readSessionUser } from '@/features/auth/session';

/** 每次最多同步多少个 id。超过部分直接丢弃：一页卡片远到不了这个数，防的是滥用。 */
const IDS_LIMIT = 100;

export async function GET(request: Request): Promise<Response> {
  const raw = new URL(request.url).searchParams.get('ids') ?? '';
  const ids = [...new Set(raw.split(','))].filter((id) => id.length > 0).slice(0, IDS_LIMIT);

  const user = await readSessionUser();
  const ports = await createCommunityPorts(user ? { userId: user.id } : {});

  const [counts, likedIds] = await Promise.all([
    ports.reactionCounts(ids),
    ports.likedPostIds(ids),
  ]);

  return NextResponse.json({
    counts: Object.fromEntries(counts),
    likedIds,
  });
}
