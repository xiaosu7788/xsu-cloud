/**
 * `core/admin` 的单元测试：用内存 fake 实现整套 `AdminPorts`，覆盖入口顺序
 * （管理员 → 目标存在 → 输入合法 → 防自锁 → 幂等 → 条件写）与审计写入约定。
 *
 * 端口返回 `false` 的语义按领域层的映射断言：用户类 → `lastAdmin`；内容类 →
 * `changed:false`（并发处置与幂等同义）；解封 → 幂等成功。
 */
import { describe, expect, it } from 'vitest';

import type { AuditLogListItem } from '@xsu/db/schema';

import {
  ADMIN_AUDIT_ACTION,
  ADMIN_FAILURE,
  type AdminAuditLogRecord,
  type AdminCommentRow,
  type AdminOutcome,
  type AdminPage,
  type AdminPorts,
  type AdminPostRow,
  type AdminToolRunStats,
  type AdminUserView,
  banUser,
  getAdminOverview,
  getAdminTaskBoard,
  getSiteConfigForAdmin,
  listAuditLogsForAdmin,
  listCommentsForAdmin,
  listPostsForAdmin,
  listUsersForAdmin,
  restoreComment,
  restorePost,
  takedownComment,
  takedownPost,
  unbanUser,
  updateUserRole,
  updateSiteConfig,
} from '../src/admin';
import type { SiteConfigDetail } from '@xsu/db/schema';

const NOW = new Date('2026-04-01T00:00:00.000Z');

function makeUser(id: string, overrides: Partial<AdminUserView> = {}): AdminUserView {
  return {
    id,
    name: `用户 ${id}`,
    email: `${id}@example.com`,
    role: 'user',
    bannedAt: null,
    banReason: null,
    createdAt: NOW,
    ...overrides,
  };
}

function makePost(id: string, overrides: Partial<AdminPostRow> = {}): AdminPostRow {
  return {
    id,
    authorId: 'u-author',
    title: `帖子 ${id}`,
    tags: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeComment(
  id: string,
  postId: string,
  overrides: Partial<AdminCommentRow> = {},
): AdminCommentRow {
  return {
    id,
    postId,
    authorId: 'u-commenter',
    body: `评论 ${id}`,
    createdAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

type AdminStore = {
  users: Map<string, AdminUserView>;
  posts: Map<string, AdminPostRow>;
  comments: Map<string, AdminCommentRow>;
  auditLogs: AdminAuditLogRecord[];
  /** 指定端口在「条件写」阶段返回 false，模拟 0 行（lastAdmin / 竞态）。 */
  failOnce: {
    updateUserRole: boolean;
    banUser: boolean;
    unbanUser: boolean;
    takedownPost: boolean;
    restorePost: boolean;
    takedownComment: boolean;
    restoreComment: boolean;
  };
  siteConfig: SiteConfigDetail | null;
  page: AdminPage<AdminUserView>;
  postPage: AdminPage<AdminPostRow>;
  commentPage: AdminPage<AdminCommentRow>;
  auditPage: AdminPage<AuditLogListItem>;
  overview: {
    userCount: number;
    postCount: number;
    commentCount: number;
    openReportCount: number;
    toolRunCount: number;
  };
  taskStats: AdminToolRunStats;
  taskRuns: {
    id: string;
    toolSlug: string;
    status: string;
    userId: string;
    userEmail: string | null;
    errorCode: string | null;
    createdAt: Date;
    durationMs: number | null;
  }[];
  /** 记录「审计行 + 条件写」是否被成对调用（红线 8：同事务形状）。 */
  calls: { port: string; audit?: AdminAuditLogRecord }[];
};

function createStore(seed?: Partial<AdminStore>): AdminStore {
  return {
    users: new Map(),
    posts: new Map(),
    comments: new Map(),
    auditLogs: [],
    failOnce: {
      updateUserRole: false,
      banUser: false,
      unbanUser: false,
      takedownPost: false,
      restorePost: false,
      takedownComment: false,
      restoreComment: false,
    },
    siteConfig: null,
    page: { items: [], total: 0 },
    postPage: { items: [], total: 0 },
    commentPage: { items: [], total: 0 },
    auditPage: { items: [], total: 0 },
    overview: { userCount: 0, postCount: 0, commentCount: 0, openReportCount: 0, toolRunCount: 0 },
    taskStats: { total: 0, succeeded: 0, failed: 0, byTool: [] },
    taskRuns: [],
    calls: [],
    ...seed,
  };
}

/** 三名常驻用户：管理员、普通用户、备用普通用户（从不登录，封禁首选）。 */
function requiredBase(store: AdminStore): void {
  store.users.set('u-admin', makeUser('u-admin', { role: 'admin' }));
  store.users.set('u-target', makeUser('u-target'));
  store.users.set('u-other', makeUser('u-other'));
}

function createPorts(store: AdminStore): AdminPorts {
  return {
    now: () => NOW,
    newId: () => `audit-${store.auditLogs.length + 1}`,
    getAdminUserById: async ({ id }) => store.users.get(id) ?? null,
    updateUserRole: async (params) => {
      store.calls.push({ port: 'updateUserRole', audit: params.audit });
      if (store.failOnce.updateUserRole) return false;
      const target = store.users.get(params.userId);
      if (!target || target.role === params.role) return false;
      target.role = params.role;
      store.auditLogs.push(params.audit);
      return true;
    },
    banUser: async (params) => {
      store.calls.push({ port: 'banUser', audit: params.audit });
      if (store.failOnce.banUser) return false;
      const target = store.users.get(params.userId);
      if (!target || target.role === 'admin' || target.bannedAt !== null) return false;
      target.bannedAt = params.audit.createdAt;
      target.banReason = params.reason;
      store.auditLogs.push(params.audit);
      return true;
    },
    unbanUser: async (params) => {
      store.calls.push({ port: 'unbanUser', audit: params.audit });
      if (store.failOnce.unbanUser) return false;
      const target = store.users.get(params.userId);
      if (!target || target.bannedAt === null) return false;
      target.bannedAt = null;
      target.banReason = null;
      store.auditLogs.push(params.audit);
      return true;
    },
    getAdminPostById: async ({ id }) => store.posts.get(id) ?? null,
    getAdminCommentById: async ({ id }) => store.comments.get(id) ?? null,
    adminTakedownPost: async (params) => {
      store.calls.push({ port: 'adminTakedownPost', audit: params.audit });
      if (store.failOnce.takedownPost) return false;
      const target = store.posts.get(params.postId);
      if (!target || target.deletedAt !== null) return false;
      target.deletedAt = params.now;
      store.auditLogs.push(params.audit);
      return true;
    },
    adminRestorePost: async (params) => {
      store.calls.push({ port: 'adminRestorePost', audit: params.audit });
      if (store.failOnce.restorePost) return false;
      const target = store.posts.get(params.postId);
      if (!target || target.deletedAt === null) return false;
      target.deletedAt = null;
      store.auditLogs.push(params.audit);
      return true;
    },
    adminTakedownComment: async (params) => {
      store.calls.push({ port: 'adminTakedownComment', audit: params.audit });
      if (store.failOnce.takedownComment) return false;
      const target = store.comments.get(params.commentId);
      if (!target || target.deletedAt !== null) return false;
      target.deletedAt = params.now;
      store.auditLogs.push(params.audit);
      return true;
    },
    adminRestoreComment: async (params) => {
      store.calls.push({ port: 'adminRestoreComment', audit: params.audit });
      if (store.failOnce.restoreComment) return false;
      const target = store.comments.get(params.commentId);
      if (!target || target.deletedAt === null) return false;
      const parent = store.posts.get(target.postId);
      if (!parent || parent.deletedAt !== null) return false;
      target.deletedAt = null;
      store.auditLogs.push(params.audit);
      return true;
    },
    getSiteConfig: async () => store.siteConfig,
    updateSiteConfig: async (params) => {
      store.calls.push({ port: 'updateSiteConfig', audit: params.audit });
      store.siteConfig = {
        id: 1,
        postQuotaPerHour: params.postQuotaPerHour,
        commentQuotaPerHour: params.commentQuotaPerHour,
        toolQuotaPerHour: params.toolQuotaPerHour,
        updatedBy: params.updatedBy,
        updatedAt: params.now,
      };
      store.auditLogs.push(params.audit);
    },
    listUsersForAdmin: async (params) => {
      store.calls.push({
        port: `listUsersForAdmin:${params.query}:${params.limit}:${params.offset}`,
      });
      return store.page;
    },
    listPostsForAdmin: async (params) => {
      store.calls.push({ port: `listPostsForAdmin:${params.limit}:${params.offset}` });
      return store.postPage;
    },
    listCommentsForAdmin: async (params) => {
      store.calls.push({ port: `listCommentsForAdmin:${params.limit}:${params.offset}` });
      return store.commentPage;
    },
    getAdminOverview: async () => store.overview,
    listAuditLogsForAdmin: async (params) => {
      store.calls.push({ port: `listAuditLogsForAdmin:${params.limit}:${params.offset}` });
      return store.auditPage;
    },
    listToolRunStats: async () => store.taskStats,
    listToolRunsForAdmin: async (params) => {
      store.calls.push({ port: `listToolRunsForAdmin:${params.limit}` });
      return store.taskRuns.slice(0, params.limit);
    },
  };
}

const ADMIN_ROLE = 'admin';
const USER_ROLE = 'user';

function baseWrite(actorId = 'u-admin'): { actorId: string; actorRole: string } {
  return { actorId, actorRole: ADMIN_ROLE };
}

function codeOf(outcome: AdminOutcome<unknown>): string {
  if (outcome.ok) {
    throw new Error('expected failure outcome');
  }
  return outcome.failure.code;
}

function lastAudit(store: AdminStore): AdminAuditLogRecord {
  expect(store.auditLogs.length).toBeGreaterThan(0);
  return store.auditLogs[store.auditLogs.length - 1] as AdminAuditLogRecord;
}

describe('admin access gate', () => {
  it('所有入口对非管理员返回 notAdmin 且不产生任何调用', async () => {
    const store = createStore();
    requiredBase(store);
    const ports = createPorts(store);
    const nonAdmin = { actorId: 'u-target', actorRole: USER_ROLE };

    const results = [
      await listUsersForAdmin(ports, { actorRole: USER_ROLE, query: '' }),
      await listPostsForAdmin(ports, { actorRole: USER_ROLE }),
      await listCommentsForAdmin(ports, { actorRole: USER_ROLE }),
      await listAuditLogsForAdmin(ports, { actorRole: USER_ROLE }),
      await getAdminOverview(ports, { actorRole: USER_ROLE }),
      await getAdminTaskBoard(ports, { actorRole: USER_ROLE }),
      await getSiteConfigForAdmin(ports, { actorRole: USER_ROLE }),
      await updateUserRole(ports, { ...nonAdmin, userId: 'u-other', role: 'admin' }),
      await banUser(ports, { ...nonAdmin, userId: 'u-other', reason: 'spam' }),
      await unbanUser(ports, { ...nonAdmin, userId: 'u-other' }),
      await takedownPost(ports, { ...nonAdmin, postId: 'p-1' }),
      await restorePost(ports, { ...nonAdmin, postId: 'p-1' }),
      await takedownComment(ports, { ...nonAdmin, commentId: 'c-1' }),
      await restoreComment(ports, { ...nonAdmin, commentId: 'c-1' }),
      await updateSiteConfig(ports, {
        ...nonAdmin,
        postQuotaPerHour: 1,
        commentQuotaPerHour: 1,
        toolQuotaPerHour: 1,
      }),
    ];

    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe(ADMIN_FAILURE.notAdmin.code);
        expect(result.failure.status).toBe(403);
      }
    }
    expect(store.calls).toEqual([]);
    expect(store.auditLogs).toEqual([]);
  });
});

describe('admin user management', () => {
  it('listUsersForAdmin 归一化关键词并用页码计算偏移', async () => {
    const store = createStore();
    requiredBase(store);
    const ports = createPorts(store);

    const ok = await listUsersForAdmin(ports, {
      actorRole: ADMIN_ROLE,
      query: '  alice  ',
      page: '3',
    });
    expect(ok).toEqual({ ok: true, value: store.page });
    expect(store.calls[0]?.port).toBe('listUsersForAdmin:alice:20:40');

    const blank = await listUsersForAdmin(ports, { actorRole: ADMIN_ROLE, query: '   ' });
    expect(blank.ok).toBe(true);
    expect(store.calls[1]?.port).toBe('listUsersForAdmin::20:0');
  });

  it('updateUserRole：改角色写审计，detail 记录 from → to', async () => {
    const store = createStore();
    requiredBase(store);
    const ports = createPorts(store);

    const result = await updateUserRole(ports, {
      ...baseWrite(),
      userId: 'u-target',
      role: 'admin',
    });
    expect(result).toEqual({
      ok: true,
      value: { userId: 'u-target', role: 'admin', changed: true },
    });
    expect(store.users.get('u-target')?.role).toBe('admin');
    const audit = lastAudit(store);
    expect(audit.action).toBe(ADMIN_AUDIT_ACTION.userRoleUpdate);
    expect(audit.targetType).toBe('user');
    expect(audit.targetId).toBe('u-target');
    expect(audit.actorId).toBe('u-admin');
    expect(audit.detail).toBe('角色 user → admin');
  });

  it('updateUserRole：目标不存在 / 自改 / 角色非法 / 幂等不写审计', async () => {
    const store = createStore();
    requiredBase(store);
    const ports = createPorts(store);

    expect(
      codeOf(await updateUserRole(ports, { ...baseWrite(), userId: 'missing', role: 'admin' })),
    ).toBe(ADMIN_FAILURE.userNotFound.code);
    expect(
      codeOf(await updateUserRole(ports, { ...baseWrite(), userId: 'u-admin', role: 'user' })),
    ).toBe(ADMIN_FAILURE.selfRoleChange.code);
    expect(
      codeOf(await updateUserRole(ports, { ...baseWrite(), userId: 'u-target', role: 'owner' })),
    ).toBe(ADMIN_FAILURE.inputInvalid.code);
    expect(
      (await updateUserRole(ports, { ...baseWrite(), userId: 'u-target', role: 'owner' })).ok,
    ).toBe(false);

    const idempotent = await updateUserRole(ports, {
      ...baseWrite(),
      userId: 'u-target',
      role: 'user',
    });
    expect(idempotent).toEqual({
      ok: true,
      value: { userId: 'u-target', role: 'user', changed: false },
    });
    expect(store.auditLogs).toEqual([]);
    expect(store.calls).toEqual([]);
  });

  it('updateUserRole：端口 0 行归为 lastAdmin（最后一名管理员 / 竞态）', async () => {
    const store = createStore();
    requiredBase(store);
    store.failOnce.updateUserRole = true;
    const ports = createPorts(store);

    const result = await updateUserRole(ports, {
      ...baseWrite(),
      userId: 'u-target',
      role: 'admin',
    });
    expect(codeOf(result)).toBe(ADMIN_FAILURE.lastAdmin.code);
    expect(store.calls.length).toBe(1);
    // 事务里审计与写是成对的：0 行时审计行没有落库（fake 不 push），领域层不重复写。
    expect(store.auditLogs).toEqual([]);
  });

  it('banUser：写封禁字段、删会话由端口负责、detail 带理由', async () => {
    const store = createStore();
    requiredBase(store);
    const ports = createPorts(store);

    const result = await banUser(ports, { ...baseWrite(), userId: 'u-other', reason: '  刷屏  ' });
    expect(result).toEqual({ ok: true, value: { userId: 'u-other', changed: true } });
    expect(store.users.get('u-other')?.bannedAt).toEqual(NOW);
    expect(store.users.get('u-other')?.banReason).toBe('刷屏');
    expect(lastAudit(store).detail).toBe('封禁理由：刷屏');
    expect(lastAudit(store).action).toBe(ADMIN_AUDIT_ACTION.userBan);
  });

  it('banUser：空理由允许且 detail 为 null；超长理由被拒', async () => {
    const store = createStore();
    requiredBase(store);
    const ports = createPorts(store);

    const noReason = await banUser(ports, { ...baseWrite(), userId: 'u-other', reason: '   ' });
    expect(noReason).toEqual({ ok: true, value: { userId: 'u-other', changed: true } });
    expect(lastAudit(store).detail).toBeNull();

    const store2 = createStore();
    requiredBase(store2);
    const long = 'x'.repeat(201);
    expect(
      codeOf(
        await banUser(createPorts(store2), { ...baseWrite(), userId: 'u-other', reason: long }),
      ),
    ).toBe(ADMIN_FAILURE.inputInvalid.code);
    expect(store2.calls).toEqual([]);
  });

  it('banUser：目标不存在 / 封自己 / 已封禁幂等（不写审计）/ 端口 0 行 → lastAdmin（含封管理员）', async () => {
    const store = createStore();
    requiredBase(store);
    store.users.get('u-target')!.bannedAt = NOW;
    const ports = createPorts(store);

    expect(codeOf(await banUser(ports, { ...baseWrite(), userId: 'missing', reason: 'x' }))).toBe(
      ADMIN_FAILURE.userNotFound.code,
    );
    expect(codeOf(await banUser(ports, { ...baseWrite(), userId: 'u-admin', reason: 'x' }))).toBe(
      ADMIN_FAILURE.selfBan.code,
    );
    const idempotent = await banUser(ports, { ...baseWrite(), userId: 'u-target', reason: 'x' });
    expect(idempotent).toEqual({ ok: true, value: { userId: 'u-target', changed: false } });
    expect(store.auditLogs).toEqual([]);

    const store2 = createStore();
    requiredBase(store2);
    store2.failOnce.banUser = true;
    const ports2 = createPorts(store2);
    const raced = await banUser(ports2, { ...baseWrite(), userId: 'u-other', reason: null });
    expect(codeOf(raced)).toBe(ADMIN_FAILURE.lastAdmin.code);

    // 封其他管理员：领域层不拦，条件 UPDATE 只放行非管理员 → 0 行 → lastAdmin。
    const store3 = createStore();
    requiredBase(store3);
    store3.users.set('u-admin2', makeUser('u-admin2', { role: 'admin' }));
    store3.failOnce.banUser = true;
    expect(
      codeOf(
        await banUser(createPorts(store3), { ...baseWrite(), userId: 'u-admin2', reason: null }),
      ),
    ).toBe(ADMIN_FAILURE.lastAdmin.code);
  });

  it('unbanUser：解封成功 changed:true；未封禁幂等；端口 0 行仍是成功', async () => {
    const store = createStore();
    requiredBase(store);
    store.users.set('u-banned', makeUser('u-banned', { bannedAt: NOW, banReason: 'spam' }));
    const ports = createPorts(store);

    const applied = await unbanUser(ports, { ...baseWrite(), userId: 'u-banned' });
    expect(applied).toEqual({ ok: true, value: { userId: 'u-banned', changed: true } });
    expect(store.users.get('u-banned')?.bannedAt).toBeNull();
    expect(store.users.get('u-banned')?.banReason).toBeNull();
    expect(lastAudit(store).action).toBe(ADMIN_AUDIT_ACTION.userUnban);
    expect(lastAudit(store).detail).toBeNull();

    const idempotent = await unbanUser(ports, { ...baseWrite(), userId: 'u-banned' });
    expect(idempotent).toEqual({ ok: true, value: { userId: 'u-banned', changed: false } });

    const stillFine = await unbanUser(ports, { ...baseWrite(), userId: 'u-target' });
    expect(stillFine).toEqual({ ok: true, value: { userId: 'u-target', changed: false } });
    expect(codeOf(await unbanUser(ports, { ...baseWrite(), userId: 'missing' }))).toBe(
      ADMIN_FAILURE.userNotFound.code,
    );

    const store2 = createStore();
    requiredBase(store2);
    store2.users.set('u-banned', makeUser('u-banned', { bannedAt: NOW }));
    store2.failOnce.unbanUser = true;
    const raced = await unbanUser(createPorts(store2), { ...baseWrite(), userId: 'u-banned' });
    expect(raced).toEqual({ ok: true, value: { userId: 'u-banned', changed: false } });
  });
});
describe('admin content management', () => {
  it('takedownPost / restorePost：条件写成功 changed:true，审计 detail 为 null', async () => {
    const store = createStore();
    requiredBase(store);
    store.posts.set('p-1', makePost('p-1'));
    const ports = createPorts(store);

    const down = await takedownPost(ports, { ...baseWrite(), postId: 'p-1' });
    expect(down).toEqual({ ok: true, value: { postId: 'p-1', changed: true } });
    expect(store.posts.get('p-1')?.deletedAt).toEqual(NOW);
    const downAudit = lastAudit(store);
    expect(downAudit.action).toBe(ADMIN_AUDIT_ACTION.postTakedown);
    expect(downAudit.targetType).toBe('post');
    expect(downAudit.detail).toBeNull();

    const up = await restorePost(ports, { ...baseWrite(), postId: 'p-1' });
    expect(up).toEqual({ ok: true, value: { postId: 'p-1', changed: true } });
    expect(store.posts.get('p-1')?.deletedAt).toBeNull();
    expect(lastAudit(store).action).toBe(ADMIN_AUDIT_ACTION.postRestore);
  });

  it('takedownPost / restorePost：幂等短路不写审计；端口 0 行归 changed:false', async () => {
    const store = createStore();
    requiredBase(store);
    store.posts.set('p-live', makePost('p-live'));
    store.posts.set('p-down', makePost('p-down', { deletedAt: NOW }));
    const ports = createPorts(store);

    expect(await takedownPost(ports, { ...baseWrite(), postId: 'p-down' })).toEqual({
      ok: true,
      value: { postId: 'p-down', changed: false },
    });
    expect(await restorePost(ports, { ...baseWrite(), postId: 'p-live' })).toEqual({
      ok: true,
      value: { postId: 'p-live', changed: false },
    });
    expect(store.calls).toEqual([]);
    expect(store.auditLogs).toEqual([]);

    store.failOnce.takedownPost = true;
    expect(await takedownPost(ports, { ...baseWrite(), postId: 'p-live' })).toEqual({
      ok: true,
      value: { postId: 'p-live', changed: false },
    });
    expect(store.auditLogs).toEqual([]);

    store.failOnce.restorePost = true;
    expect(await restorePost(ports, { ...baseWrite(), postId: 'p-down' })).toEqual({
      ok: true,
      value: { postId: 'p-down', changed: false },
    });
    expect(store.auditLogs).toEqual([]);
  });

  it('takedownPost / restorePost：帖子不存在 → postNotFound，无调用', async () => {
    const store = createStore();
    requiredBase(store);
    const ports = createPorts(store);

    expect(codeOf(await takedownPost(ports, { ...baseWrite(), postId: 'missing' }))).toBe(
      ADMIN_FAILURE.postNotFound.code,
    );
    expect(codeOf(await restorePost(ports, { ...baseWrite(), postId: 'missing' }))).toBe(
      ADMIN_FAILURE.postNotFound.code,
    );
    expect(store.calls).toEqual([]);
  });

  it('restoreComment：父帖已删 → parentPostDeleted（不写审计）；父帖不存在 → postNotFound', async () => {
    const store = createStore();
    requiredBase(store);
    store.posts.set('p-dead', makePost('p-dead', { deletedAt: NOW }));
    store.comments.set('c-1', makeComment('c-1', 'p-dead', { deletedAt: NOW }));
    const ports = createPorts(store);

    expect(codeOf(await restoreComment(ports, { ...baseWrite(), commentId: 'c-1' }))).toBe(
      ADMIN_FAILURE.parentPostDeleted.code,
    );
    expect(store.calls).toEqual([]);
    expect(store.auditLogs).toEqual([]);

    store.comments.set('c-ghost', makeComment('c-ghost', 'p-ghost', { deletedAt: NOW }));
    expect(codeOf(await restoreComment(ports, { ...baseWrite(), commentId: 'c-ghost' }))).toBe(
      ADMIN_FAILURE.postNotFound.code,
    );
  });

  it('restoreComment：父帖在 → 恢复成功写审计；已上线幂等；端口 0 行归 changed:false', async () => {
    const store = createStore();
    requiredBase(store);
    store.posts.set('p-1', makePost('p-1'));
    store.comments.set('c-1', makeComment('c-1', 'p-1', { deletedAt: NOW }));
    const ports = createPorts(store);

    const ok = await restoreComment(ports, { ...baseWrite(), commentId: 'c-1' });
    expect(ok).toEqual({ ok: true, value: { commentId: 'c-1', changed: true } });
    expect(store.comments.get('c-1')?.deletedAt).toBeNull();
    expect(lastAudit(store).action).toBe(ADMIN_AUDIT_ACTION.commentRestore);

    expect(await restoreComment(ports, { ...baseWrite(), commentId: 'c-1' })).toEqual({
      ok: true,
      value: { commentId: 'c-1', changed: false },
    });

    store.comments.set('c-2', makeComment('c-2', 'p-1', { deletedAt: NOW }));
    store.failOnce.restoreComment = true;
    expect(await restoreComment(ports, { ...baseWrite(), commentId: 'c-2' })).toEqual({
      ok: true,
      value: { commentId: 'c-2', changed: false },
    });
    expect(store.auditLogs.length).toBe(1);
  });

  it('takedownComment：成功 / 已下架幂等 / 不存在', async () => {
    const store = createStore();
    requiredBase(store);
    store.posts.set('p-1', makePost('p-1'));
    store.comments.set('c-1', makeComment('c-1', 'p-1'));
    const ports = createPorts(store);

    expect(await takedownComment(ports, { ...baseWrite(), commentId: 'c-1' })).toEqual({
      ok: true,
      value: { commentId: 'c-1', changed: true },
    });
    expect(lastAudit(store).action).toBe(ADMIN_AUDIT_ACTION.commentTakedown);
    expect(await takedownComment(ports, { ...baseWrite(), commentId: 'c-1' })).toEqual({
      ok: true,
      value: { commentId: 'c-1', changed: false },
    });
    expect(codeOf(await takedownComment(ports, { ...baseWrite(), commentId: 'missing' }))).toBe(
      ADMIN_FAILURE.commentNotFound.code,
    );
  });

  it('后台三个列表把页码换成偏移后透传端口', async () => {
    const store = createStore();
    requiredBase(store);
    const ports = createPorts(store);

    await listPostsForAdmin(ports, { actorRole: ADMIN_ROLE, page: '2' });
    await listCommentsForAdmin(ports, { actorRole: ADMIN_ROLE, page: 'abc' });
    await listAuditLogsForAdmin(ports, { actorRole: ADMIN_ROLE, page: '9' });
    expect(store.calls.map((call) => call.port)).toEqual([
      'listPostsForAdmin:20:20',
      'listCommentsForAdmin:20:0',
      'listAuditLogsForAdmin:20:160',
    ]);
  });
});

describe('admin site config', () => {
  it('getSiteConfigForAdmin：无行 → null，有行 → 行', async () => {
    const store = createStore();
    requiredBase(store);
    const ports = createPorts(store);

    expect(await getSiteConfigForAdmin(ports, { actorRole: ADMIN_ROLE })).toEqual({
      ok: true,
      value: null,
    });
    const row: SiteConfigDetail = {
      id: 1,
      postQuotaPerHour: 5,
      commentQuotaPerHour: null,
      toolQuotaPerHour: 0,
      updatedBy: 'u-admin',
      updatedAt: NOW,
    };
    store.siteConfig = row;
    expect(await getSiteConfigForAdmin(ports, { actorRole: ADMIN_ROLE })).toEqual({
      ok: true,
      value: row,
    });
  });

  it('updateSiteConfig：混合覆盖值 upsert 成功，审计 detail 描述三态', async () => {
    const store = createStore();
    requiredBase(store);
    const ports = createPorts(store);

    const result = await updateSiteConfig(ports, {
      ...baseWrite(),
      postQuotaPerHour: '5',
      commentQuotaPerHour: '',
      toolQuotaPerHour: 0,
    });
    expect(result).toEqual({
      ok: true,
      value: { postQuotaPerHour: 5, commentQuotaPerHour: null, toolQuotaPerHour: 0 },
    });
    expect(store.calls.length).toBe(1);
    const audit = lastAudit(store);
    expect(audit.action).toBe(ADMIN_AUDIT_ACTION.siteConfigUpdate);
    expect(audit.targetType).toBe('site_config');
    expect(audit.targetId).toBe('site_config');
    expect(audit.detail).toBe('每小时配额覆盖：发帖 5 / 评论 默认 / 工具 0');
    expect(store.siteConfig?.updatedBy).toBe('u-admin');
  });

  it('updateSiteConfig：非法值逐字段拒绝且 field 正确、不产生端口调用', async () => {
    const store = createStore();
    requiredBase(store);
    const ports = createPorts(store);

    const cases: [unknown, unknown, unknown, string][] = [
      ['1.5', null, null, 'postQuotaPerHour'],
      [-1, null, null, 'postQuotaPerHour'],
      [1_000_001, null, null, 'postQuotaPerHour'],
      ['abc', null, null, 'postQuotaPerHour'],
      [null, '2.5', null, 'commentQuotaPerHour'],
      [null, null, 1_000_001, 'toolQuotaPerHour'],
    ];
    for (const [post, comment, tool, field] of cases) {
      const outcome = await updateSiteConfig(ports, {
        ...baseWrite(),
        postQuotaPerHour: post,
        commentQuotaPerHour: comment,
        toolQuotaPerHour: tool,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.failure.code).toBe(ADMIN_FAILURE.inputInvalid.code);
        expect(outcome.failure.field).toBe(field);
      }
    }
    expect(store.calls).toEqual([]);
    expect(store.auditLogs).toEqual([]);
  });
});

describe('admin tasks & overview', () => {
  it('getAdminTaskBoard：runsLimit 收进 [1, 50]，缺省 10', async () => {
    const store = createStore();
    requiredBase(store);
    const ports = createPorts(store);

    await getAdminTaskBoard(ports, { actorRole: ADMIN_ROLE });
    expect(store.calls[0]?.port).toBe('listToolRunsForAdmin:10');
    await getAdminTaskBoard(ports, { actorRole: ADMIN_ROLE, runsLimit: 0 });
    expect(store.calls[1]?.port).toBe('listToolRunsForAdmin:1');
    await getAdminTaskBoard(ports, { actorRole: ADMIN_ROLE, runsLimit: 100 });
    expect(store.calls[2]?.port).toBe('listToolRunsForAdmin:50');

    store.taskStats = {
      total: 3,
      succeeded: 2,
      failed: 1,
      byTool: [{ toolSlug: 'echo', runs: 3, failed: 1 }],
    };
    store.taskRuns = [
      {
        id: 'run-1',
        toolSlug: 'echo',
        status: 'failed',
        userId: 'u-target',
        userEmail: 'u-target@example.com',
        errorCode: 'TOOL_FAILED',
        createdAt: NOW,
        durationMs: 120,
      },
    ];
    const board = await getAdminTaskBoard(ports, { actorRole: ADMIN_ROLE });
    expect(board).toEqual({
      ok: true,
      value: { stats: store.taskStats, recent: store.taskRuns },
    });
  });

  it('getAdminOverview：透传计数聚合', async () => {
    const store = createStore();
    requiredBase(store);
    const ports = createPorts(store);
    store.overview = {
      userCount: 3,
      postCount: 1,
      commentCount: 2,
      openReportCount: 0,
      toolRunCount: 5,
    };

    const outcome = await getAdminOverview(ports, { actorRole: ADMIN_ROLE });
    expect(outcome).toEqual({ ok: true, value: store.overview });
  });
});
