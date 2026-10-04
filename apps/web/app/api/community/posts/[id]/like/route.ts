/**
 * 单帖点赞接口：`GET / POST / DELETE /api/community/posts/[id]/like`。
 *
 * ## 方法映射
 *
 * `GET` 读本帖的点赞状态（计数 + 我有没有点过），给详情页挂载后的状态同步用；
 * `POST` 点赞、`DELETE` 取消——三个动词对应领域层的读 / likePost / unlikePost。
 * 写方法要求登录（401 JSON，不是重定向：API 的调用方是 fetch，重定向只会让它拿到 HTML）。
 *
 * ## 这一层只做翻译
 *
 * 「重复点赞幂等」「已下架内容不可点赞」全在 `@xsu/core` 的 `src/community/reactions.ts`。
 * 这里只把路径参数摊成一次调用，失败码表直接给出 status / code / message。
 */
import { NextResponse } from 'next/server';

import { likePost, readPost, unlikePost } from '@xsu/core';
import { createCommunityPorts } from '@xsu/platform';

import { readSessionUser } from '@/features/auth/session';

type RouteContext = { params: Promise<{ id: string }> };

/** 401 响应的统一形状，与失败码表一致（这里没有领域层条目可复用）。 */
function unauthorized(): Response {
  return NextResponse.json(
    { error: { code: 'UNAUTHENTICATED', message: '登录之后才能点赞。' } },
    { status: 401 },
  );
}

/** `GET`：本帖的计数与「我有没有点过」。未登录照常返回（liked 恒为 false）。 */
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;

  const user = await readSessionUser();
  const ports = await createCommunityPorts(user ? { userId: user.id } : {});

  /*
   * 用 `readPost` 而不是 `loadVisiblePost`：下架帖子的计数对详情页的拒绝视图没有意义，
   * 但对 API 的语义「读这个 id 的点赞状态」来说，404 与 200 的分界应该与页面一致——
   * 都用「不存在才是 404」。计数 0 对已删除的帖子也是真话（点赞行随软删保留）。
   */
  const outcome = await readPost(ports, { postId: id });
  if (!outcome.ok) {
    const { status, code, message } = outcome.failure;
    return NextResponse.json({ error: { code, message } }, { status });
  }

  const [counts, likedIds] = await Promise.all([
    ports.reactionCounts([id]),
    ports.likedPostIds([id]),
  ]);

  return NextResponse.json({
    count: counts.get(id) ?? 0,
    liked: likedIds.includes(id),
  });
}

/** `POST`：点赞。未登录 401。 */
export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;

  const user = await readSessionUser();
  if (!user) return unauthorized();

  const outcome = await likePost(await createCommunityPorts({ userId: user.id }), {
    postId: id,
    userId: user.id,
  });
  if (!outcome.ok) {
    const { status, code, message } = outcome.failure;
    return NextResponse.json({ error: { code, message } }, { status });
  }

  return NextResponse.json({ postId: outcome.postId, liked: outcome.liked });
}

/** `DELETE`：取消点赞。未登录 401。 */
export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;

  const user = await readSessionUser();
  if (!user) return unauthorized();

  const outcome = await unlikePost(await createCommunityPorts({ userId: user.id }), {
    postId: id,
    userId: user.id,
  });
  if (!outcome.ok) {
    const { status, code, message } = outcome.failure;
    return NextResponse.json({ error: { code, message } }, { status });
  }

  return NextResponse.json({ postId: outcome.postId, liked: outcome.liked });
}
