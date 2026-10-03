/**
 * 工具箱的平台适配：把领域层的执行端口接到数据库与配置上，并提供页面要的历史/收藏读写。
 *
 * 与 `./registration` 同一条分层理由：`docs/ARCHITECTURE.md` 2.1 把 `packages/platform`
 * 列为「可被应用层使用」，数据层不在其列。因此应用层只 import 本模块，不 import `@xsu/db`；
 * 「怎么装配依赖」也只有这一处。
 *
 * ## 用户是构造参数，不是每次调用的参数
 *
 * 本模块的每一次读写都以 `userId` 为界，所以 `userId` 在建端口时就绑定，而不是让每个方法
 * 各自接收一次。这不是省参数：`tool_runs` / `tool_favorites` 的查询里少一个 `user_id`
 * 条件就是跨用户泄漏（`packages/db/src/repositories/tools.ts` 的纵深防御），绑定之后
 * **调用方没有机会漏传**——它压根拿不到那个参数。
 *
 * ## 这里没有业务规则
 *
 * 「slug 在不在注册表里」「这次执行算不算超配额」「摘要怎么脱敏」全在 `@xsu/core`
 * （`packages/core/src/tools/`）。本文件只做两件事：把端口转成仓储调用，把仓储结果原样交出。
 * `countRunsSince` 是唯一的例外形状——领域层的端口签名要求 `userId`，那是 `runTool` 的
 * 契约，这里照抄它的 `request.userId`，与绑定值同源。
 */
import { randomUUID } from 'node:crypto';

import type { ToolRunPorts } from '@xsu/core';
import {
  addToolFavorite,
  countToolRunsSince,
  getDb,
  getToolRunById,
  insertToolRun,
  listToolFavoriteSlugs,
  listToolRuns,
  removeToolFavorite,
  TOOL_RUN_PAGE_SIZE_DEFAULT,
  type Database,
  type ToolRunDetail,
  type ToolRunListItem,
} from '@xsu/db';

import { getServerEnv, type ServerEnv } from './env';

export type ToolPortsDeps = {
  /** 当前用户。所有读写都以它为界，见文件头。 */
  userId: string;
  /** 默认取 `@xsu/db` 的共享连接；测试可传入独立的库。 */
  db?: Database;
  /** 默认取 `@xsu/platform` 的共享配置（配额上限来自它）。 */
  env?: ServerEnv;
};

/**
 * 工具箱的端口集合。
 *
 * 前五项是 `@xsu/core` 的 `ToolRunPorts`——`runTool` 只认识这些；后四项是页面要的读与写，
 * 领域层不参与（收藏是「记一笔」，历史列表是「取一页」，都没有需要判定的规则）。
 */
export type ToolPorts = ToolRunPorts & {
  /** 当前用户的运行历史，按时间倒序一页。 */
  listRuns: (params?: { limit?: number }) => Promise<ToolRunListItem[]>;
  /** 单条运行记录；不属于当前用户时返回 `null`（仓储已按 `user_id` 收窄）。 */
  getRun: (id: string) => Promise<ToolRunDetail | null>;
  /** 当前用户收藏的 slug，slug 升序。可能含已下架工具的 slug，调用方自行过滤。 */
  listFavoriteSlugs: () => Promise<string[]>;
  /** 收藏一个工具。重复收藏不是错误（唯一索引挡下后什么也不做）。 */
  addFavorite: (slug: string) => Promise<void>;
  /** 取消收藏一个工具。没收藏过也不是错误。 */
  removeFavorite: (slug: string) => Promise<void>;
};

/**
 * 建一个工具箱端口集合。每次请求都新建即可——它自己不持有连接，也不缓存数据。
 *
 * **校验 slug 是调用方的责任**（领域层的 `isRegisteredToolSlug`）：收藏表与运行历史表都
 * 没有指向目录的外键（`docs/spec/SPEC-tools.md` 第 2 节），这里不做判断正是为了不让
 * 「判断」有两份实现。
 */
export function createToolPorts(deps: ToolPortsDeps): ToolPorts {
  const db = deps.db ?? getDb();
  const env = deps.env ?? getServerEnv();
  const userId = deps.userId;

  return {
    /*
     * 时间与 id 由端口提供，而端口是唯一来源：配额窗口的判定、落库的 `created_at`
     * 与页面显示的耗时因此共用同一个时间点（见 `@xsu/core` 的 `ToolRunPorts`）。
     */
    now() {
      return new Date();
    },

    newRunId() {
      return randomUUID();
    },

    countRunsSince(params) {
      return countToolRunsSince(db, params);
    },

    recordRun(run) {
      return insertToolRun(db, run);
    },

    quotaPerHour: env.tools.quotaPerHour,

    listRuns(params = {}) {
      return listToolRuns(db, { userId, limit: params.limit ?? TOOL_RUN_PAGE_SIZE_DEFAULT });
    },

    getRun(id) {
      return getToolRunById(db, { id, userId });
    },

    listFavoriteSlugs() {
      return listToolFavoriteSlugs(db, { userId });
    },

    addFavorite(slug) {
      return addToolFavorite(db, { id: randomUUID(), userId, toolSlug: slug, now: new Date() });
    },

    removeFavorite(slug) {
      return removeToolFavorite(db, { userId, toolSlug: slug });
    },
  };
}
