/**
 * 社区的平台适配：把领域层的端口接到数据库与计数缓存上，并提供页面要的读取。
 *
 * 与 `./tools` 同一条分层理由：`docs/ARCHITECTURE.md` 2.1 把 `packages/platform` 列为「可被
 * 应用层使用」，数据层不在其列。应用层只 import 本模块，不 import `@xsu/db`；「怎么装配依赖」
 * 只有这一处。本文件不做任何判定——输入校验、配额、归属、审核流转全在 `@xsu/core` 的
 * `src/community/`，这里只是「把端口转成仓储调用，把仓储结果原样交出」。
 *
 * ## 与 `./tools` 的两点差异
 *
 * 1. **`userId` 不是必填。** 工具箱的每次读写都以用户为界，所以 `userId` 在建端口时绑定；社区的
 *    大部分读写不是——公开 Feed 匿名可看，写操作的作者由领域层的请求参数给定（页面从会话里取，
 *    传给 `createPost`）。唯一的例外是 `likedPostIds`：它回答「我赞过哪些」，没有用户就没有答案，
 *    没传 `userId` 时它返回空数组——这不是伪成功，是「匿名访客没有任何点赞标记」的真话。
 *    绑定而不是每次传参，仍然是同一个动机：调用方没有机会把别人的 id 传进来。
 * 2. **多出一组页面读取**（`reactionCounts` / `likedPostIds` / `authorSummaries`）。领域层不认识
 *    「列表页要显示作者名」这种展示需求，它们只属于本文件。
 *
 * ## 类型名为什么不是 `CommunityPorts`
 *
 * 那个名字已经被 `@xsu/core` 的端口契约占用了（本文件 import 它，但不转发）。这里的装配物多出
 * 三个页面读取，所以另起 `CommunityGateway`：语义是「领域端口 + 页面读取」的合体。
 */
import { randomUUID } from 'node:crypto';

import type { CommunityPorts } from '@xsu/core';
import {
  addReaction,
  countCommentsSince,
  countPostsSince,
  countReactionsByPosts,
  findOpenReport,
  getCommentById,
  getDb,
  getPostById,
  getReportById,
  insertComment,
  insertPost,
  insertReport,
  listAuditLogs,
  listAuthorSummaries,
  listComments,
  listFeedTags,
  listLikedPostIds,
  listPendingReports,
  listPosts,
  listPostsByAuthor,
  removeReaction,
  resolveReport,
  softDeleteComment,
  softDeletePost,
  updatePost,
  type AuthorSummary,
  type Database,
} from '@xsu/db';

import { getReactionCountCache, type ReactionCountCache } from './cache';
import { getServerEnv, type ServerEnv } from './env';
import { resolveQuotaOverrides } from './quota';

export type CommunityGatewayDeps = {
  /** 当前登录用户。只有 `likedPostIds` 用它；匿名（未登录）时不传。 */
  userId?: string;
  /** 默认取 `@xsu/db` 的共享连接；测试可传入独立的库。 */
  db?: Database;
  /** 默认取 `@xsu/platform` 的共享配置（配额上限来自它）。 */
  env?: ServerEnv;
  /** 默认取进程内共享的计数缓存；测试可传入独立实例。 */
  cache?: ReactionCountCache;
};

/** 领域端口 + 页面读取。方法一一转发，本文件里没有任何一条 if 是业务规则。 */
export type CommunityGateway = CommunityPorts & {
  /**
   * 一批帖子的点赞数。**数据库是事实来源，缓存只是加速**：未命中的键当场从数据库算出并在同一
   * 次调用里回填，下一批请求就命中；缓存读失败时整批回落数据库，结果照常返回。
   */
  reactionCounts: (postIds: string[]) => Promise<Map<string, number>>;
  /** 当前用户在给定帖子里点过赞的 id（无序）。没登录时恒为空数组。 */
  likedPostIds: (postIds: string[]) => Promise<string[]>;
  /** 一批用户 id → 作者摘要。缺的 id 不在返回值里，调用方自行决定兜底展示。 */
  authorSummaries: (userIds: string[]) => Promise<Map<string, AuthorSummary>>;
  /**
   * 构建期要预渲染的帖子 id 清单（详情页 `generateStaticParams` 的数据源）。**尽力而为**：
   * 读取失败一律返回空清单——预渲染问题不能阻塞构建，运行期 ISR 照常回源数据库。
   */
  listRecentPostIds: () => Promise<string[]>;
  /** 构建期要预渲染的标签清单（标签页 `generateStaticParams` 的数据源）。尽力而为，同上。 */
  listFeedTags: () => Promise<string[]>;
};

/** 详情页构建期预渲染清单的上限：只挑最近的若干条，完整覆盖交给 ISR 按需生成。 */
const STATIC_PARAMS_POST_LIMIT = 20;
/**
 * 建一个社区网关。每次请求新建即可——它自己不持有数据库连接；计数缓存是进程内共享的
 * （`./cache` 的 `getReactionCountCache`），不会因为重复建网关而多出连接。三项每小时
 * 配额在构造时现读 `site_config` 的站点级覆盖（`./quota`，SPEC-admin 第 4 节），
 * 本函数因此是异步的；调用方 `await`。
 */
export async function createCommunityPorts(deps: CommunityGatewayDeps): Promise<CommunityGateway> {
  const db = deps.db ?? getDb();
  const env = deps.env ?? getServerEnv();
  const cache = deps.cache ?? getReactionCountCache(env);
  const userId = deps.userId;
  const quotas = await resolveQuotaOverrides(db, env);

  return {
    /*
     * 时间与 id 由端口提供：配额窗口的判定、落库的 `created_at` 与审计行的 `created_at`
     * 共用同一个时间点（`@xsu/core` 的 `types.ts` 文件头第 2 条）。
     */
    now() {
      return new Date();
    },

    newId() {
      return randomUUID();
    },

    postQuotaPerHour: quotas.postQuotaPerHour,
    commentQuotaPerHour: quotas.commentQuotaPerHour,

    countPostsSince(params) {
      return countPostsSince(db, params);
    },

    countCommentsSince(params) {
      return countCommentsSince(db, params);
    },

    insertPost(post) {
      return insertPost(db, post);
    },

    getPostById(params) {
      return getPostById(db, params);
    },

    updatePost(params) {
      return updatePost(db, params);
    },

    softDeletePost(params) {
      return softDeletePost(db, params);
    },

    listPosts(params) {
      return listPosts(db, params);
    },

    listPostsByAuthor(params) {
      return listPostsByAuthor(db, params);
    },

    insertComment(comment) {
      return insertComment(db, comment);
    },

    getCommentById(params) {
      return getCommentById(db, params);
    },

    softDeleteComment(params) {
      return softDeleteComment(db, params);
    },

    listComments(params) {
      return listComments(db, params);
    },

    addReaction(params) {
      return addReaction(db, params);
    },

    removeReaction(params) {
      return removeReaction(db, params);
    },

    /*
     * 计数缓存整块接进端口。它的 best-effort 语义在 `./cache` 里实现并说明：
     * 缓存失败不让已经落库的点赞变成失败响应。
     */
    reactions: cache,

    findOpenReport(params) {
      return findOpenReport(db, params);
    },

    insertReport(report) {
      return insertReport(db, report);
    },

    getReportById(params) {
      return getReportById(db, params);
    },

    resolveReport(params) {
      return resolveReport(db, params);
    },

    listPendingReports(params) {
      return listPendingReports(db, params);
    },

    listAuditLogs(params) {
      return listAuditLogs(db, params);
    },

    async reactionCounts(postIds) {
      if (postIds.length === 0) return new Map();

      const cached = await cache.getMany(postIds);
      const missing = postIds.filter((postId) => !cached.has(postId));
      if (missing.length === 0) return cached;

      const fromDb = await countReactionsByPosts(db, { postIds: missing });
      /*
       * 数据库里没有点赞行的帖子不会出现在 `fromDb` 里，但 0 也要写进缓存：不写的话这批帖子
       * 永远不命中，每个列表页都要为「没人赞过的帖子」多查一次库——而它们恰恰最常见。
       */
      const filled = new Map(fromDb);
      for (const postId of missing) {
        if (!filled.has(postId)) filled.set(postId, 0);
      }

      await cache.setMany(filled);

      // 两张键集不相交（`missing` 就是「`cached` 里没有的」），合并顺序不影响结果。
      return new Map([...filled, ...cached]);
    },

    async likedPostIds(postIds) {
      if (postIds.length === 0 || userId === undefined) return [];
      return listLikedPostIds(db, { userId, postIds });
    },

    authorSummaries(userIds) {
      return listAuthorSummaries(db, { userIds });
    },

    /*
     * 构建期预渲染清单（两个 `generateStaticParams` 的数据源）。尽力而为的语义在这里兑现：
     * 任何读取失败都回落空清单而不是把构建炸掉——ISR 会在运行期按需生成真实页面。
     */
    async listRecentPostIds() {
      try {
        const rows = await listPosts(db, { limit: STATIC_PARAMS_POST_LIMIT, cursor: null });
        return rows.map((row) => row.id);
      } catch {
        return [];
      }
    },

    async listFeedTags() {
      try {
        return await listFeedTags(db);
      } catch {
        return [];
      }
    },
  };
}
