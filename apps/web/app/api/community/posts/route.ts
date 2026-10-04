/**
 * 帖子列表接口：`GET /api/community/posts`。
 *
 * ## 为什么列表接口在公开页之外还要存在
 *
 * `/community` 与 `/community/tags/[tag]` 是 ISR 页面，首屏由服务端渲染；但「加载更多」的
 * 追加翻页发生在浏览器里，它需要一条能带 `cursor` / `tag` / `q` 参数的读接口。首屏与追加
 * 共用同一条数据链路（同一套归一化、分页与失败码），列表页客户端只多拼一个查询串。
 *
 * ## 这一层只做翻译
 *
 * 归一化、分页、游标编解码、配额、归属全在 `@xsu/core` 的 `src/community/`（`listFeed`）。
 * 这里只把查询参数摊成一次调用、把结果摊成 JSON；应用层薄壳，无业务规则
 * （`docs/ARCHITECTURE.md` 2.1）。数据访问经 `@xsu/platform` 的 `createCommunityPorts`，
 * 不 import `@xsu/db`。
 *
 * ## 响应里带富化数据
 *
 * 与首屏服务端渲染同一套富化：作者摘要（缺 id → null，调用方显示「作者已注销」）与点赞计数
 * （缓存只是加速，见 `@xsu/platform/src/cache.ts`）。`likedIds` 只在登录后非空——匿名访客
 * 没有点赞标记，空数组是「真话」而不是伪成功（`packages/platform/src/community.ts` 文件头）。
 */
import { NextResponse } from 'next/server';

import { listFeed } from '@xsu/core';
import { createCommunityPorts } from '@xsu/platform';

import { readSessionUser } from '@/features/auth/session';
import { toPostCardModels } from '@/features/community/view';

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  const user = await readSessionUser();
  const ports = await createCommunityPorts(user ? { userId: user.id } : {});

  const outcome = await listFeed(ports, {
    cursor: url.searchParams.get('cursor') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
    query: url.searchParams.get('q') ?? undefined,
  });

  if (!outcome.ok) {
    const { status, code, message } = outcome.failure;
    return NextResponse.json({ error: { code, message } }, { status });
  }

  /*
   * 富化与列表页服务端渲染同一套：作者摘要与计数由网关的页面读取给出，卡片模型由
   * `toPostCardModels` 组装。失败码表没有第三种形状，失败与成功在此分流后不再合并。
   */
  const items = outcome.items;
  const authors = await ports.authorSummaries(items.map((item) => item.authorId));
  const counts = await ports.reactionCounts(items.map((item) => item.id));
  const likedIds = await ports.likedPostIds(items.map((item) => item.id));

  return NextResponse.json({
    items: toPostCardModels(items, authors, counts),
    nextCursor: outcome.nextCursor,
    likedIds,
  });
}
