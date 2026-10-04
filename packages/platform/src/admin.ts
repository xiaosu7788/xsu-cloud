/**
 * 后台管理（M5）的平台适配：把领域层的端口接到数据库仓储上。
 *
 * 与 `./community` 同一条分层理由：`docs/ARCHITECTURE.md` 2.1 把 `packages/platform` 列为
 * 「可被应用层使用」，数据层不在其列。应用层（`(admin)` 页面）只 import 本模块，不 import
 * `@xsu/db`；「怎么装配依赖」只有这一处。本文件不做任何判定——谁能进后台、封禁理由合不合法、
 * 防自锁，全在 `@xsu/core` 的 `src/admin/`，这里只是「把端口转成仓储调用，把仓储结果原样交出」。
 *
 * ## 与 `./community` 的差异
 *
 * 1. **没有页面读取**。后台五页的读侧（列表/概览/审计）全部走领域层的只读入口
 *    （`listUsersForAdmin` 等，入口第一步就是 `requireAdminActor`），页面拿到的
 *    `AdminGateway` 直接当端口用即可，不需要 `reactionCounts` 那类展示型读取。
 * 2. **不依赖 `ServerEnv`**。后台没有任何取自环境变量的配置；每小时的配额覆盖属于
 *    站点配置（`site_config` 表），由 `./quota` 在建社区/工具端口时读取。
 *
 * ## 类型名
 *
 * `AdminPorts` 已被 `@xsu/core` 的端口契约占用，这里沿用 community 的取舍：
 * 装配物类型另起 `AdminGateway`（当前与 `AdminPorts` 同形，语义是「领域端口的实例化」）。
 */
import { randomUUID } from 'node:crypto';

import type { AdminPorts } from '@xsu/core';
import {
  adminRestoreComment,
  adminRestorePost,
  adminTakedownComment,
  adminTakedownPost,
  banUser,
  getAdminCommentById,
  getAdminOverview,
  getAdminPostById,
  getAdminToolRunStats,
  getAdminUserById,
  getDb,
  getSiteConfig,
  listAdminAuditLogs,
  listAdminComments,
  listAdminPosts,
  listAdminToolRuns,
  listAdminUsers,
  unbanUser,
  updateSiteConfig,
  updateUserRole,
  type Database,
} from '@xsu/db';

export type AdminGatewayDeps = {
  /** 默认取 `@xsu/db` 的共享连接；测试可传入独立的库。 */
  db?: Database;
};

/** 领域端口的实例化。方法一一转发，本文件里没有任何一条 if 是业务规则。 */
export type AdminGateway = AdminPorts;

/**
 * 建一个后台管理网关。每次请求新建即可——它自己不持有数据库连接；
 * 审计行与业务写同事务的约定由仓储兑现（红线 8），装配层没有事务可破坏。
 */
export function createAdminGateway(deps: AdminGatewayDeps = {}): AdminGateway {
  const db = deps.db ?? getDb();

  return {
    /*
     * 时间与 id 由端口提供：领域层生成审计记录时用它，审计行的 `created_at` 与
     * 业务写的 `updated_at` / `banned_at` 共用同一个时间点（仓储不自己取时间）。
     */
    now() {
      return new Date();
    },

    newId() {
      return randomUUID();
    },

    /* ---- 用户管理 ---- */

    getAdminUserById(params) {
      return getAdminUserById(db, params);
    },

    updateUserRole(params) {
      return updateUserRole(db, params);
    },

    banUser(params) {
      return banUser(db, params);
    },

    unbanUser(params) {
      return unbanUser(db, params);
    },

    /* ---- 内容管理 ---- */

    adminTakedownPost(params) {
      return adminTakedownPost(db, params);
    },

    adminRestorePost(params) {
      return adminRestorePost(db, params);
    },

    adminTakedownComment(params) {
      return adminTakedownComment(db, params);
    },

    adminRestoreComment(params) {
      return adminRestoreComment(db, params);
    },

    /* ---- 站点配置 ---- */

    getSiteConfig() {
      return getSiteConfig(db);
    },

    updateSiteConfig(params) {
      return updateSiteConfig(db, params);
    },

    /* ---- 读侧（列表与概览） ---- */

    getAdminPostById(params) {
      return getAdminPostById(db, params);
    },

    getAdminCommentById(params) {
      return getAdminCommentById(db, params);
    },

    listUsersForAdmin(params) {
      return listAdminUsers(db, params);
    },

    listPostsForAdmin(params) {
      return listAdminPosts(db, params);
    },

    listCommentsForAdmin(params) {
      return listAdminComments(db, params);
    },

    getAdminOverview() {
      return getAdminOverview(db);
    },

    listAuditLogsForAdmin(params) {
      return listAdminAuditLogs(db, params);
    },

    /* ---- 任务管理（只读） ---- */

    listToolRunStats() {
      return getAdminToolRunStats(db);
    },

    listToolRunsForAdmin(params) {
      return listAdminToolRuns(db, params);
    },
  };
}
