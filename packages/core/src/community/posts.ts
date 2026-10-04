/**
 * 帖子：发帖、改帖、删帖、读帖、列表与「我的帖子」。
 *
 * 每条操作的顺序是规则的一部分（`docs/spec/SPEC-community.md` 第 4 节），不能重排：
 *
 * 1. **发帖**：校验 → 配额 → 写入。配额拒绝**既不落行也不计数**，否则「被拒 → 计数 +1 →
 *    更容易被拒」会自我放大（`tools/run-tool.ts` 是同一条取舍）；
 * 2. **改帖 / 删帖**：存在 → 归属 → （改帖还有）校验 → 写入。归属先于校验，是因为不该拿
 *    别人的帖子当参数校验的试验场；
 * 3. **读帖**：不存在是 404，**存在但已删除照样返回**（带 `deletedAt`）——「这个 id 不存在」与
 *    「存在但已被删除 / 下架」是两件事，后者要渲染统一的拒绝视图（`schema/community.ts` 的
 *    `PostDetail` 注释）。
 *
 * 时间点一律取 `ports.now()`，且**一次操作只取一次**：配额窗口的「现在」与落库的 `created_at`
 * 必须是同一个时间点（`types.ts` 文件头第 2 条）。
 */
import type { PostDetail, PostListItem } from '@xsu/db/schema';

import {
  decidePostAccess,
  decodeCursor,
  isQuotaExceeded,
  normalizeQuery,
  normalizeTag,
  paginate,
  quotaWindowStart,
  resolvePageSize,
  validatePostInput,
} from './rules';
import {
  CONTENT_FAILURE,
  type CommunityCursor,
  type CommunityPorts,
  type PageOutcome,
  type PostOutcome,
  type PostReadOutcome,
} from './types';

/** 列表项的游标位置。投影里本来就带 `createdAt`，所以列表行可以直接当游标点用。 */
function cursorOf(item: PostListItem): CommunityCursor {
  return { createdAt: item.createdAt, id: item.id };
}

/**
 * 按 id 取一篇**还活着**的帖子。`null` 表示「不存在，或已被作者删除 / 被管理员下架」。
 *
 * 单条读取在数据层不过滤 `deleted_at`（那里要靠它区分 404 与拒绝视图），所以这道门必须由
 * 领域层来守：写操作（评论、点赞、举报）都先过它，否则「已下架的内容还能被点赞 / 评论 / 举报」
 * 这条路就留着。
 */
export async function loadVisiblePost(
  ports: CommunityPorts,
  postId: string,
): Promise<PostDetail | null> {
  const post = await ports.getPostById({ id: postId });
  return post && post.deletedAt === null ? post : null;
}

/** 发一篇帖子。 */
export async function createPost(
  ports: CommunityPorts,
  request: { authorId: string; title: unknown; body: unknown; tags: unknown },
): Promise<PostOutcome> {
  const now = ports.now();

  const input = validatePostInput(request);
  if (!input.ok) {
    return { ok: false, failure: input.failure };
  }

  const recent = await ports.countPostsSince({
    authorId: request.authorId,
    since: quotaWindowStart(now),
  });
  if (isQuotaExceeded({ recentCount: recent, quotaPerHour: ports.postQuotaPerHour })) {
    return { ok: false, failure: CONTENT_FAILURE.quotaExceeded };
  }

  const postId = ports.newId();
  await ports.insertPost({
    id: postId,
    authorId: request.authorId,
    title: input.value.title,
    body: input.value.body,
    tags: input.value.tags,
    createdAt: now,
    updatedAt: now,
  });

  return { ok: true, postId };
}

/** 作者改自己的帖子。`updated_at` 跟着走，`created_at` 不动（列表按创建时间排）。 */
export async function updatePost(
  ports: CommunityPorts,
  request: { postId: string; authorId: string; title: unknown; body: unknown; tags: unknown },
): Promise<PostOutcome> {
  const post = await loadVisiblePost(ports, request.postId);
  if (!post) {
    return { ok: false, failure: CONTENT_FAILURE.postNotFound };
  }

  const access = decidePostAccess({ viewerId: request.authorId, authorId: post.authorId });
  if (!access.allowed) {
    return { ok: false, failure: access.failure };
  }

  const input = validatePostInput(request);
  if (!input.ok) {
    return { ok: false, failure: input.failure };
  }

  await ports.updatePost({
    id: post.id,
    title: input.value.title,
    body: input.value.body,
    tags: input.value.tags,
    now: ports.now(),
  });

  return { ok: true, postId: post.id };
}

/**
 * 作者删自己的帖子：**只写 `deleted_at`，不删行**（软删除）。
 *
 * 顺带把点赞计数缓存丢掉：那个键是按帖子 id 建的，内容都没了还留着计数只会在帖子 id 被
 * 复用时给出错误数字。端口契约要求实现自己做 best-effort（`types.ts`），所以这里不吞异常。
 */
export async function deletePost(
  ports: CommunityPorts,
  request: { postId: string; authorId: string },
): Promise<PostOutcome> {
  const post = await loadVisiblePost(ports, request.postId);
  if (!post) {
    return { ok: false, failure: CONTENT_FAILURE.postNotFound };
  }

  const access = decidePostAccess({ viewerId: request.authorId, authorId: post.authorId });
  if (!access.allowed) {
    return { ok: false, failure: access.failure };
  }

  await ports.softDeletePost({ id: post.id, now: ports.now() });
  await ports.reactions.drop(post.id);

  return { ok: true, postId: post.id };
}

/**
 * 单篇帖子。已删除 / 已下架的帖子也返回（带 `deletedAt`），由表现层渲染统一的拒绝视图；
 * 只有 id 确实不存在才是 `postNotFound`。
 */
export async function readPost(
  ports: CommunityPorts,
  request: { postId: string },
): Promise<PostReadOutcome> {
  const post = await ports.getPostById({ id: request.postId });
  if (!post) {
    return { ok: false, failure: CONTENT_FAILURE.postNotFound };
  }
  return { ok: true, post };
}

/**
 * 公开列表 / 按标签浏览 / 搜索共用的一次取页。
 *
 * `tag` 与 `query` 同时给出时是「标签 + 关键词」，数据层两个条件都会加上（`listPosts`）。
 * 都在归一化后为空时就是完整时间线。
 */
export async function listFeed(
  ports: CommunityPorts,
  request: { limit?: unknown; cursor?: unknown; tag?: unknown; query?: unknown } = {},
): Promise<PageOutcome<PostListItem>> {
  const decoded = decodeCursor(request.cursor);
  if (!decoded.ok) {
    return { ok: false, failure: decoded.failure };
  }

  const limit = resolvePageSize(request.limit);
  const rows = await ports.listPosts({
    // 多取一行：它唯一的作用是回答「有没有下一页」（`rules.ts` 的 `paginate`）。
    limit: limit + 1,
    cursor: decoded.cursor,
    tag: normalizeTag(request.tag),
    query: normalizeQuery(request.query),
  });

  return { ok: true, ...paginate({ rows, limit, cursorOf }) };
}

/**
 * 「我的帖子」。**不含已删除的**：列表要的就是「现在还在的内容」，删除后从列表消失正是
 * 要验证的行为（数据层与本函数的取舍见 `countPostsSince` 的注释——配额口径相反，是有意的）。
 */
export async function listMyPosts(
  ports: CommunityPorts,
  request: { authorId: string; limit?: unknown },
): Promise<PageOutcome<PostListItem>> {
  const items = await ports.listPostsByAuthor({
    authorId: request.authorId,
    limit: resolvePageSize(request.limit),
  });

  // M3 的「我的帖子」不翻页（筛选与分页留给 M5，见 SPEC 已知债务），所以没有下一页游标；
  // 需要翻页时把这里换成与 `listFeed` 同一套 `paginate` 即可，游标格式不用改。
  return { ok: true, items, nextCursor: null };
}
