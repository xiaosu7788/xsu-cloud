/**
 * 帖子评论接口：`GET / POST /api/community/posts/[id]/comments`。
 *
 * `GET` 是详情页评论的「加载更多」：服务端已渲染第一页，这里按同一套游标规则（正序）
 * 翻后续页；`POST` 发表评论，要求登录（401 JSON，理由同 like 路由）。
 *
 * ## 这一层只做翻译
 *
 * 配额、长度校验、目标帖子是否还活着，全在 `@xsu/core` 的 `src/community/comments.ts`。
 * `GET` 不重复判帖子存在：调用方（详情页与它的拒绝视图）已保证走到这里时帖子可见，
 * 理由与领域层 `listPostComments` 的注释一致。
 */
import { NextResponse } from 'next/server';

import { createComment, listPostComments } from '@xsu/core';
import { createCommunityPorts } from '@xsu/platform';

import { readSessionUser } from '@/features/auth/session';

type RouteContext = { params: Promise<{ id: string }> };

function unauthorized(): Response {
  return NextResponse.json(
    { error: { code: 'UNAUTHENTICATED', message: '登录之后才能评论。' } },
    { status: 401 },
  );
}

/** `GET`：一页评论（正序），`nextCursor` 为 `null` 表示到底了。 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  const params = new URL(request.url).searchParams;

  const ports = await createCommunityPorts({});
  const outcome = await listPostComments(ports, {
    postId: id,
    cursor: params.get('cursor'),
  });
  if (!outcome.ok) {
    const { status, code, message } = outcome.failure;
    return NextResponse.json({ error: { code, message } }, { status });
  }

  return NextResponse.json({ items: outcome.items, nextCursor: outcome.nextCursor });
}

/** `POST`：发表评论。正文从 JSON body 取。 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;

  const user = await readSessionUser();
  if (!user) return unauthorized();

  const payload: unknown = await request.json().catch(() => null);
  const outcome = await createComment(await createCommunityPorts({ userId: user.id }), {
    postId: id,
    authorId: user.id,
    body: (payload as { body?: unknown } | null)?.body,
  });
  if (!outcome.ok) {
    const { status, code, message } = outcome.failure;
    return NextResponse.json({ error: { code, message } }, { status });
  }

  return NextResponse.json({ commentId: outcome.commentId }, { status: 201 });
}
