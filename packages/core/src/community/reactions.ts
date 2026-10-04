/**
 * 点赞与取消点赞。
 *
 * **重复点赞不是错误**，这是本模块最容易写错的一条。并发两次点赞的坏结果有两种：第二次拿到
 * 一个「已存在」的报错（用户看到莫名其妙的失败），或者计数被加两次（缓存要等 60 秒重建才修
 * 得回来，那 60 秒里数字是错的）。所以用两道防线一起挡：
 *
 * 1. 数据层的 `ON CONFLICT DO NOTHING`（主键 `(post_id, user_id)`）把冲突变成「什么都没发生」——
 *    唯一约束就是并发点赞的防线（`SPEC-community.md` 第 3 节）；
 * 2. 它返回 `boolean` 告诉领域层这次**是否真的动了行**，只有动了行才去改计数缓存。
 *
 * 于是「点两次」的结果是 `liked: true` 且计数为 1，与 PRD 3.2 验收 2 要的幂等语义一致。
 * `liked` 是**操作完成后的状态**，不是「这次有没有改动」（`types.ts` 的 `ReactionOutcome`）。
 *
 * 自己的帖子也能点赞：M3 不做限制（SPEC 第 4 节）。
 */
import { loadVisiblePost } from './posts';
import { CONTENT_FAILURE, type CommunityPorts, type ReactionOutcome } from './types';

/** 点赞。帖子不存在或已下架 → `postNotFound`，与评论、举报同一道门。 */
export async function likePost(
  ports: CommunityPorts,
  request: { postId: string; userId: string },
): Promise<ReactionOutcome> {
  const post = await loadVisiblePost(ports, request.postId);
  if (!post) {
    return { ok: false, failure: CONTENT_FAILURE.postNotFound };
  }

  const inserted = await ports.addReaction({
    postId: post.id,
    userId: request.userId,
    now: ports.now(),
  });
  if (inserted) {
    // 只有真的插进去了才加一。重复点赞走到这里时 `inserted === false`，计数保持不动。
    await ports.reactions.increment(post.id);
  }

  return { ok: true, postId: post.id, liked: true };
}

/**
 * 取消点赞。取消一个没点过的赞**不是错误**：删除 0 行就是想要的结果，只是没有行变动，
 * 所以也不该把计数减一（否则「取消两次」会把别人的点赞数减掉）。
 */
export async function unlikePost(
  ports: CommunityPorts,
  request: { postId: string; userId: string },
): Promise<ReactionOutcome> {
  const post = await loadVisiblePost(ports, request.postId);
  if (!post) {
    return { ok: false, failure: CONTENT_FAILURE.postNotFound };
  }

  const removed = await ports.removeReaction({ postId: post.id, userId: request.userId });
  if (removed) {
    await ports.reactions.decrement(post.id);
  }

  return { ok: true, postId: post.id, liked: false };
}
