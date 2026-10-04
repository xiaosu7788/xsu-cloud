import { describe, expect, it } from 'vitest';

import type {
  AuditLogListItem,
  CommentDetail,
  CommentListItem,
  PostDetail,
  PostListItem,
  ReportListItem,
} from '@xsu/db/schema';

import {
  asText,
  auditActionFor,
  buildAuditDetail,
  charLength,
  confirmTakedown,
  createComment,
  createPost,
  createReport,
  decodeCursor,
  decideCommentAccess,
  decideModerationAccess,
  decidePostAccess,
  deleteComment,
  deletePost,
  dismissReport,
  encodeCursor,
  isQuotaExceeded,
  likePost,
  listAuditLogs,
  listFeed,
  listMyPosts,
  listPendingReports,
  listPostComments,
  loadVisibleComment,
  loadVisiblePost,
  normalizeQuery,
  normalizeReportTargetType,
  normalizeTag,
  normalizeTags,
  paginate,
  quotaWindowStart,
  readPost,
  resolvePageSize,
  type CommunityPorts,
  unlikePost,
  updatePost,
  validateCommentInput,
  validatePostInput,
  validateReportInput,
} from '../src/community';

const NOW = new Date('2026-03-01T00:00:00.000Z');

type CommunityStore = {
  posts: Map<string, PostDetail>;
  comments: Map<string, CommentDetail>;
  reactions: Set<string>;
  reactionCounts: Map<string, number>;
  reactionIncrements: Map<string, number>;
  reports: Map<string, ReportListItem>;
  auditLogs: AuditLogListItem[];
  sequence: number;
};

function makePost(
  id: string,
  createdAt: Date,
  overrides: Partial<Pick<PostDetail, 'authorId' | 'title' | 'body' | 'tags'>> = {},
): PostDetail {
  return {
    id,
    authorId: overrides.authorId ?? 'author-1',
    title: overrides.title ?? `标题 ${id}`,
    body: overrides.body ?? `正文 ${id}`,
    tags: overrides.tags ?? [],
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
}

function makeComment(
  id: string,
  postId: string,
  createdAt: Date,
  overrides: Partial<Pick<CommentDetail, 'authorId' | 'body'>> = {},
): CommentDetail {
  return {
    id,
    postId,
    authorId: overrides.authorId ?? 'comment-author-1',
    body: overrides.body ?? `评论 ${id}`,
    createdAt,
    deletedAt: null,
  };
}

function makeReport(
  id: string,
  targetId: string,
  createdAt: Date,
  status: ReportListItem['status'] = 'open',
): ReportListItem {
  return {
    id,
    reporterId: 'reporter-1',
    targetType: 'post',
    targetId,
    reason: `理由 ${id}`,
    status,
    createdAt,
    handledBy: status === 'open' ? null : 'admin-1',
    handledAt: status === 'open' ? null : createdAt,
  };
}

function toPostListItem(post: PostDetail): PostListItem {
  return {
    id: post.id,
    authorId: post.authorId,
    title: post.title,
    tags: post.tags,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}

function toCommentListItem(comment: CommentDetail): CommentListItem {
  return {
    id: comment.id,
    postId: comment.postId,
    authorId: comment.authorId,
    body: comment.body,
    createdAt: comment.createdAt,
  };
}

function sortPostsDescending(left: PostDetail, right: PostDetail): number {
  const byTime = right.createdAt.getTime() - left.createdAt.getTime();
  return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
}

function isAfterPostCursor(post: PostDetail, cursor: { createdAt: Date; id: string }): boolean {
  const byTime = post.createdAt.getTime() - cursor.createdAt.getTime();
  return byTime < 0 || (byTime === 0 && post.id.localeCompare(cursor.id) < 0);
}

function createPorts(seedPosts: PostDetail[] = []): {
  ports: CommunityPorts;
  store: CommunityStore;
} {
  const store: CommunityStore = {
    posts: new Map(seedPosts.map((post) => [post.id, post])),
    comments: new Map(),
    reactions: new Set(),
    reactionCounts: new Map(),
    reactionIncrements: new Map(),
    reports: new Map(),
    auditLogs: [],
    sequence: 0,
  };

  const ports: CommunityPorts = {
    now: () => new Date(NOW),
    newId: () => `generated-${++store.sequence}`,
    postQuotaPerHour: 100,
    commentQuotaPerHour: 100,

    countPostsSince: async ({ authorId, since }) =>
      [...store.posts.values()].filter(
        (post) => post.authorId === authorId && post.createdAt >= since,
      ).length,
    countCommentsSince: async ({ authorId, since }) =>
      [...store.comments.values()].filter(
        (comment) => comment.authorId === authorId && comment.createdAt >= since,
      ).length,

    insertPost: async (post) => {
      store.posts.set(post.id, {
        ...post,
        deletedAt: null,
      });
    },
    getPostById: async ({ id }) => store.posts.get(id) ?? null,
    updatePost: async ({ id, title, body, tags, now }) => {
      const post = store.posts.get(id);
      if (!post) return;
      Object.assign(post, { title, body, tags, updatedAt: now });
    },
    softDeletePost: async ({ id, now }) => {
      const post = store.posts.get(id);
      if (post) post.deletedAt = now;
    },
    listPosts: async ({ limit, cursor, tag, query }) => {
      const normalizedQuery = query?.toLowerCase() ?? null;
      return [...store.posts.values()]
        .filter((post) => post.deletedAt === null)
        .filter((post) => tag === null || tag === undefined || post.tags.includes(tag))
        .filter(
          (post) =>
            normalizedQuery === null ||
            `${post.title} ${post.body}`.toLowerCase().includes(normalizedQuery),
        )
        .filter(
          (post) => cursor === null || cursor === undefined || isAfterPostCursor(post, cursor),
        )
        .sort(sortPostsDescending)
        .slice(0, limit)
        .map(toPostListItem);
    },
    listPostsByAuthor: async ({ authorId, limit }) =>
      [...store.posts.values()]
        .filter((post) => post.authorId === authorId && post.deletedAt === null)
        .sort(sortPostsDescending)
        .slice(0, limit)
        .map(toPostListItem),

    insertComment: async (comment) => {
      store.comments.set(comment.id, {
        ...comment,
        deletedAt: null,
      });
    },
    getCommentById: async ({ id }) => store.comments.get(id) ?? null,
    softDeleteComment: async ({ id, now }) => {
      const comment = store.comments.get(id);
      if (comment) comment.deletedAt = now;
    },
    listComments: async ({ postId, limit, cursor }) =>
      [...store.comments.values()]
        .filter((comment) => comment.postId === postId && comment.deletedAt === null)
        .filter((comment) => {
          if (!cursor) return true;
          const byTime = comment.createdAt.getTime() - cursor.createdAt.getTime();
          return byTime > 0 || (byTime === 0 && comment.id.localeCompare(cursor.id) > 0);
        })
        .sort(
          (left, right) =>
            left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
        )
        .slice(0, limit)
        .map(toCommentListItem),

    addReaction: async ({ postId, userId }) => {
      const key = `${postId}:${userId}`;
      if (store.reactions.has(key)) return false;
      store.reactions.add(key);
      return true;
    },
    removeReaction: async ({ postId, userId }) => {
      const key = `${postId}:${userId}`;
      return store.reactions.delete(key);
    },
    reactions: {
      increment: async (postId) => {
        store.reactionCounts.set(postId, (store.reactionCounts.get(postId) ?? 0) + 1);
        store.reactionIncrements.set(postId, (store.reactionIncrements.get(postId) ?? 0) + 1);
      },
      decrement: async (postId) => {
        store.reactionCounts.set(postId, Math.max(0, (store.reactionCounts.get(postId) ?? 0) - 1));
      },
      drop: async (postId) => {
        for (const key of store.reactions) {
          if (key.startsWith(`${postId}:`)) store.reactions.delete(key);
        }
        store.reactionCounts.delete(postId);
      },
    },

    findOpenReport: async ({ reporterId, targetType, targetId }) =>
      [...store.reports.values()].find(
        (report) =>
          report.status === 'open' &&
          report.reporterId === reporterId &&
          report.targetType === targetType &&
          report.targetId === targetId,
      ) ?? null,
    getReportById: async ({ id }) => store.reports.get(id) ?? null,
    insertReport: async (report) => {
      const duplicate = [...store.reports.values()].some(
        (existing) =>
          existing.status === 'open' &&
          existing.reporterId === report.reporterId &&
          existing.targetType === report.targetType &&
          existing.targetId === report.targetId,
      );
      if (duplicate) return null;

      const created: ReportListItem = {
        ...report,
        status: 'open',
        handledBy: null,
        handledAt: null,
      };
      store.reports.set(created.id, created);
      return created;
    },
    resolveReport: async ({ reportId, status, handledBy, handledAt, audit }) => {
      const report = store.reports.get(reportId);
      if (!report || report.status !== 'open') return null;

      report.status = status;
      report.handledBy = handledBy;
      report.handledAt = handledAt;
      store.auditLogs.push(audit);

      if (status === 'takedown') {
        if (report.targetType === 'post') {
          const post = store.posts.get(report.targetId);
          if (post) post.deletedAt = handledAt;
        } else {
          const comment = store.comments.get(report.targetId);
          if (comment) comment.deletedAt = handledAt;
        }
      }

      return report;
    },
    listPendingReports: async ({ limit }) =>
      [...store.reports.values()].filter((report) => report.status === 'open').slice(0, limit),
    listAuditLogs: async ({ limit }) =>
      [...store.auditLogs]
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, limit),
  };

  return { ports, store };
}

describe('社区列表游标', () => {
  it('连续翻页不重复、不遗漏，并按创建时间与 id 稳定排序', async () => {
    const posts = Array.from({ length: 5 }, (_, index) =>
      makePost(`post-${index + 1}`, new Date(NOW.getTime() + (index + 1) * 1000)),
    );
    const { ports } = createPorts(posts);
    const seen: string[] = [];
    let cursor: string | undefined;

    do {
      const page = await listFeed(ports, { limit: 2, cursor });
      expect(page.ok).toBe(true);
      if (!page.ok) throw new Error('列表读取失败');
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(seen).toEqual(['post-5', 'post-4', 'post-3', 'post-2', 'post-1']);
    expect(new Set(seen).size).toBe(posts.length);
  });
});

describe('社区点赞幂等', () => {
  it('并发点赞只保留一行，且计数只增加一次', async () => {
    const post = makePost('post-like', NOW);
    const { ports, store } = createPorts([post]);

    const outcomes = await Promise.all(
      Array.from({ length: 32 }, () => likePost(ports, { postId: post.id, userId: 'user-1' })),
    );

    expect(outcomes.every((outcome) => outcome.ok && outcome.liked)).toBe(true);
    expect(store.reactions).toEqual(new Set(['post-like:user-1']));
    expect(store.reactionIncrements.get(post.id)).toBe(1);
    expect(store.reactionCounts.get(post.id)).toBe(1);
  });
});

describe('社区软删除', () => {
  it('删除后从公开列表与搜索消失，但详情仍保留软删除事实', async () => {
    const target = makePost('post-search', NOW, {
      title: 'Needle in title',
      body: 'searchable body',
    });
    const { ports } = createPorts([target]);

    const before = await listFeed(ports, { query: 'needle', limit: 20 });
    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error('删除前搜索失败');
    expect(before.items.map((item) => item.id)).toEqual([target.id]);

    const deleted = await deletePost(ports, { postId: target.id, authorId: target.authorId });
    expect(deleted).toEqual({ ok: true, postId: target.id });

    const after = await listFeed(ports, { query: 'needle', limit: 20 });
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error('删除后搜索失败');
    expect(after.items).toEqual([]);

    const detail = await readPost(ports, { postId: target.id });
    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error('软删除详情读取失败');
    expect(detail.post.deletedAt).toEqual(NOW);
  });
});

describe('社区举报审核', () => {
  it('举报不自动下架，只有管理员确认后才从列表消失并写审计', async () => {
    const target = makePost('post-report', NOW, { title: '待审核帖子' });
    const { ports, store } = createPorts([target]);

    const submitted = await createReport(ports, {
      reporterId: 'reporter-1',
      targetType: 'post',
      targetId: target.id,
      reason: '需要审核',
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) throw new Error('举报提交失败');
    expect(submitted.alreadyReported).toBe(false);
    expect(store.posts.get(target.id)?.deletedAt).toBeNull();

    const duplicate = await createReport(ports, {
      reporterId: 'reporter-1',
      targetType: 'post',
      targetId: target.id,
      reason: '重复提交',
    });
    expect(duplicate).toEqual({ ok: true, reportId: submitted.reportId, alreadyReported: true });

    const denied = await confirmTakedown(ports, {
      reportId: submitted.reportId,
      actorId: 'user-2',
      actorRole: 'user',
    });
    expect(denied).toEqual({ ok: false, failure: expect.objectContaining({ code: 'NOT_ADMIN' }) });
    expect(store.posts.get(target.id)?.deletedAt).toBeNull();

    const confirmed = await confirmTakedown(ports, {
      reportId: submitted.reportId,
      actorId: 'admin-1',
      actorRole: 'admin',
    });
    expect(confirmed).toEqual({
      ok: true,
      reportId: submitted.reportId,
      targetType: 'post',
      targetId: target.id,
    });
    expect(store.posts.get(target.id)?.deletedAt).toEqual(NOW);
    expect(store.auditLogs).toHaveLength(1);
    expect(store.auditLogs[0]).toMatchObject({
      action: 'report.takedown',
      targetType: 'post',
      targetId: target.id,
    });

    const list = await listFeed(ports, { limit: 20 });
    expect(list.ok).toBe(true);
    if (!list.ok) throw new Error('审核后列表读取失败');
    expect(list.items).toEqual([]);
  });
});

function validPostRequest(
  overrides: Partial<{ authorId: string; title: unknown; body: unknown; tags: unknown }> = {},
) {
  return {
    authorId: 'author-1',
    title: '一篇有效帖子',
    body: '正文内容',
    tags: ['TypeScript'],
    ...overrides,
  };
}

describe('社区纯规则边界', () => {
  it('归一化并校验帖子、评论与举报输入', () => {
    expect(charLength('😀a')).toBe(2);
    expect(asText(' text ')).toBe(' text ');
    expect(asText(null)).toBe('');
    expect(normalizeTags(' TypeScript, typescript，前端、前端  后端 ')).toEqual([
      'typescript',
      '前端',
      '后端',
    ]);
    expect(normalizeTags([' A ', 1, null, 'a'])).toEqual(['a']);
    expect(normalizeTag('  TypeScript ')).toBe('typescript');
    expect(normalizeTag('  ')).toBeNull();
    expect(normalizeQuery('  Hello  ')).toBe('Hello');
    expect(normalizeQuery('  ')).toBeNull();

    expect(validatePostInput({ title: '  ', body: '正文', tags: [] })).toMatchObject({
      ok: false,
      failure: { code: 'CONTENT_INPUT_INVALID', field: 'title' },
    });
    expect(validatePostInput({ title: '😀'.repeat(121), body: '正文', tags: [] })).toMatchObject({
      ok: false,
      failure: { code: 'CONTENT_INPUT_TOO_LARGE', field: 'title' },
    });
    expect(validatePostInput({ title: '标题', body: '  ', tags: [] })).toMatchObject({
      ok: false,
      failure: { code: 'CONTENT_INPUT_INVALID', field: 'body' },
    });
    expect(validatePostInput({ title: '标题', body: 'x'.repeat(20_001), tags: [] })).toMatchObject({
      ok: false,
      failure: { code: 'CONTENT_INPUT_TOO_LARGE', field: 'body' },
    });
    expect(
      validatePostInput({ title: '标题', body: '正文', tags: ['x'.repeat(25)] }),
    ).toMatchObject({
      ok: false,
      failure: { code: 'CONTENT_INPUT_TOO_LARGE', field: 'tags' },
    });
    expect(
      validatePostInput({ title: '标题', body: '正文', tags: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    ).toMatchObject({
      ok: false,
      failure: { code: 'CONTENT_TAG_LIMIT_EXCEEDED', field: 'tags' },
    });
    expect(validatePostInput({ title: ' 标题 ', body: ' 正文 ', tags: 'A, a' })).toEqual({
      ok: true,
      value: { title: '标题', body: '正文', tags: ['a'] },
    });

    expect(validateCommentInput({ body: '  ' })).toMatchObject({
      ok: false,
      failure: { code: 'CONTENT_INPUT_INVALID', field: 'body' },
    });
    expect(validateCommentInput({ body: 'x'.repeat(2_001) })).toMatchObject({
      ok: false,
      failure: { code: 'CONTENT_INPUT_TOO_LARGE', field: 'body' },
    });
    expect(validateCommentInput({ body: ' 评论 ' })).toEqual({
      ok: true,
      value: { body: '评论' },
    });

    expect(normalizeReportTargetType('post')).toBe('post');
    expect(normalizeReportTargetType('video')).toBeNull();
    expect(
      validateReportInput({ targetType: 'video', targetId: 'id', reason: '理由' }),
    ).toMatchObject({
      ok: false,
      failure: { code: 'CONTENT_INPUT_INVALID', field: 'targetType' },
    });
    expect(
      validateReportInput({ targetType: 'post', targetId: '  ', reason: '理由' }),
    ).toMatchObject({
      ok: false,
      failure: { code: 'CONTENT_INPUT_INVALID', field: 'targetId' },
    });
    expect(validateReportInput({ targetType: 'post', targetId: 'id', reason: '  ' })).toMatchObject(
      {
        ok: false,
        failure: { code: 'CONTENT_INPUT_INVALID', field: 'reason' },
      },
    );
    expect(
      validateReportInput({ targetType: 'comment', targetId: 'id', reason: 'x'.repeat(501) }),
    ).toMatchObject({
      ok: false,
      failure: { code: 'CONTENT_INPUT_TOO_LARGE', field: 'reason' },
    });
    expect(
      validateReportInput({ targetType: 'comment', targetId: ' id ', reason: ' 理由 ' }),
    ).toEqual({
      ok: true,
      value: { targetType: 'comment', targetId: 'id', reason: '理由' },
    });
  });

  it('编解码游标、分页、配额、归属与审核判定', () => {
    const point = { createdAt: NOW, id: 'cursor-1' };
    const encoded = encodeCursor(point);
    expect(decodeCursor(null)).toEqual({ ok: true, cursor: null });
    expect(decodeCursor(undefined)).toEqual({ ok: true, cursor: null });
    expect(decodeCursor('')).toEqual({ ok: true, cursor: null });
    expect(decodeCursor(encoded)).toEqual({ ok: true, cursor: point });
    expect(decodeCursor(123)).toMatchObject({
      ok: false,
      failure: { code: 'CONTENT_INPUT_INVALID', field: 'cursor' },
    });
    for (const json of [
      '{',
      'null',
      '{}',
      '{"t":"bad","i":"id"}',
      '{"t":"2026-03-01T00:00:00.000Z","i":""}',
    ]) {
      const invalid = Buffer.from(json, 'utf8').toString('base64url');
      expect(decodeCursor(invalid)).toMatchObject({
        ok: false,
        failure: { code: 'CONTENT_INPUT_INVALID', field: 'cursor' },
      });
    }

    expect(resolvePageSize(undefined)).toBe(20);
    expect(resolvePageSize('')).toBe(20);
    expect(resolvePageSize('not-a-number')).toBe(20);
    expect(resolvePageSize(0)).toBe(20);
    expect(resolvePageSize(1.9)).toBe(1);
    expect(resolvePageSize(999)).toBe(50);

    const pageWithNext = paginate({
      rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      limit: 2,
      cursorOf: (item) => ({ createdAt: NOW, id: item.id }),
    });
    expect(pageWithNext.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(pageWithNext.nextCursor).toBeTypeOf('string');
    expect(paginate({ rows: [], limit: 2, cursorOf: () => point }).nextCursor).toBeNull();
    expect(isQuotaExceeded({ recentCount: 2, quotaPerHour: 2 })).toBe(true);
    expect(isQuotaExceeded({ recentCount: 1, quotaPerHour: 2 })).toBe(false);
    expect(isQuotaExceeded({ recentCount: 0, quotaPerHour: -1 })).toBe(true);
    expect(quotaWindowStart(NOW)).toEqual(new Date('2026-02-28T23:00:00.000Z'));

    expect(decidePostAccess({ viewerId: 'author-1', authorId: 'author-1' })).toEqual({
      allowed: true,
    });
    expect(decidePostAccess({ viewerId: 'author-2', authorId: 'author-1' })).toMatchObject({
      allowed: false,
      failure: { code: 'POST_FORBIDDEN' },
    });
    expect(decideCommentAccess({ viewerId: 'author-1', authorId: 'author-1' })).toEqual({
      allowed: true,
    });
    expect(decideCommentAccess({ viewerId: 'author-2', authorId: 'author-1' })).toMatchObject({
      allowed: false,
      failure: { code: 'COMMENT_FORBIDDEN' },
    });
    expect(decideModerationAccess('admin')).toEqual({ allowed: true });
    expect(decideModerationAccess('user')).toMatchObject({
      allowed: false,
      failure: { code: 'NOT_ADMIN' },
    });
    expect(auditActionFor('takedown')).toBe('report.takedown');
    expect(auditActionFor('dismissed')).toBe('report.dismiss');
    expect(buildAuditDetail({ reportId: 'report-1', targetType: 'post', targetId: 'post-1' })).toBe(
      '举报 report-1 → post:post-1',
    );
  });
});

describe('社区帖子操作', () => {
  it('覆盖创建、修改、删除、读取、列表与配额分支', async () => {
    const target = makePost('post-operations', NOW, { tags: ['typescript'], title: 'Hello' });
    const { ports, store } = createPorts([target]);

    expect(await loadVisiblePost(ports, target.id)).toEqual(target);
    expect(await loadVisiblePost(ports, 'missing')).toBeNull();
    expect(await createPost(ports, validPostRequest({ title: '  ' }))).toMatchObject({
      ok: false,
      failure: { code: 'CONTENT_INPUT_INVALID' },
    });

    const created = await createPost(ports, validPostRequest());
    expect(created).toEqual({ ok: true, postId: 'generated-1' });
    expect(store.posts.get('generated-1')).toMatchObject({ tags: ['typescript'] });

    const quota = createPorts();
    quota.ports.postQuotaPerHour = 0;
    expect(await createPost(quota.ports, validPostRequest())).toMatchObject({
      ok: false,
      failure: { code: 'CONTENT_QUOTA_EXCEEDED' },
    });
    expect(quota.store.posts.size).toBe(0);

    expect(
      await updatePost(ports, {
        postId: 'missing',
        authorId: 'author-1',
        title: '标题',
        body: '正文',
        tags: [],
      }),
    ).toMatchObject({ ok: false, failure: { code: 'POST_NOT_FOUND' } });
    expect(
      await updatePost(ports, {
        postId: target.id,
        authorId: 'author-2',
        title: '标题',
        body: '正文',
        tags: [],
      }),
    ).toMatchObject({ ok: false, failure: { code: 'POST_FORBIDDEN' } });
    expect(
      await updatePost(ports, {
        postId: target.id,
        authorId: 'author-1',
        title: '标题',
        body: '  ',
        tags: [],
      }),
    ).toMatchObject({ ok: false, failure: { code: 'CONTENT_INPUT_INVALID', field: 'body' } });
    expect(
      await updatePost(ports, {
        postId: target.id,
        authorId: 'author-1',
        title: '更新后的标题',
        body: '更新后的正文',
        tags: ['updated'],
      }),
    ).toEqual({ ok: true, postId: target.id });

    const page = await listFeed(ports, { limit: 1, tag: 'updated', query: '更新' });
    expect(page.ok).toBe(true);
    if (page.ok) expect(page.items.map((item) => item.id)).toEqual([target.id]);
    expect(await listFeed(ports, { cursor: 'bad' })).toMatchObject({
      ok: false,
      failure: { code: 'CONTENT_INPUT_INVALID', field: 'cursor' },
    });
    expect(await listMyPosts(ports, { authorId: 'author-1', limit: '1' })).toMatchObject({
      ok: true,
      nextCursor: null,
    });

    await likePost(ports, { postId: target.id, userId: 'author-1' });
    expect(await deletePost(ports, { postId: target.id, authorId: 'author-2' })).toMatchObject({
      ok: false,
      failure: { code: 'POST_FORBIDDEN' },
    });
    expect(await deletePost(ports, { postId: target.id, authorId: 'author-1' })).toEqual({
      ok: true,
      postId: target.id,
    });
    expect(await loadVisiblePost(ports, target.id)).toBeNull();
    expect(await deletePost(ports, { postId: target.id, authorId: 'author-1' })).toMatchObject({
      ok: false,
      failure: { code: 'POST_NOT_FOUND' },
    });
    expect(await readPost(ports, { postId: target.id })).toMatchObject({ ok: true, post: target });
    expect(await readPost(ports, { postId: 'missing' })).toMatchObject({
      ok: false,
      failure: { code: 'POST_NOT_FOUND' },
    });
  });
});

describe('社区评论操作', () => {
  it('覆盖评论可见性、创建、删除与游标翻页', async () => {
    const post = makePost('post-comments', NOW);
    const { ports, store } = createPorts([post]);

    expect(await loadVisibleComment(ports, 'missing')).toBeNull();
    expect(
      await createComment(ports, { postId: 'missing', authorId: 'author-1', body: '评论' }),
    ).toMatchObject({ ok: false, failure: { code: 'POST_NOT_FOUND' } });
    expect(
      await createComment(ports, { postId: post.id, authorId: 'author-1', body: '  ' }),
    ).toMatchObject({ ok: false, failure: { code: 'CONTENT_INPUT_INVALID', field: 'body' } });

    const quota = createPorts([post]);
    quota.ports.commentQuotaPerHour = 0;
    expect(
      await createComment(quota.ports, { postId: post.id, authorId: 'author-1', body: '评论' }),
    ).toMatchObject({ ok: false, failure: { code: 'CONTENT_QUOTA_EXCEEDED' } });

    const created = await createComment(ports, {
      postId: post.id,
      authorId: 'author-1',
      body: '第一条评论',
    });
    expect(created).toEqual({ ok: true, commentId: 'generated-1' });
    store.comments.set(
      'comment-1',
      makeComment('comment-1', post.id, new Date(NOW.getTime() + 1_000)),
    );
    store.comments.set(
      'comment-2',
      makeComment('comment-2', post.id, new Date(NOW.getTime() + 2_000)),
    );

    expect(await listPostComments(ports, { postId: post.id, cursor: 'bad' })).toMatchObject({
      ok: false,
      failure: { code: 'CONTENT_INPUT_INVALID', field: 'cursor' },
    });
    const firstPage = await listPostComments(ports, { postId: post.id, limit: 1 });
    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok || !firstPage.nextCursor) throw new Error('评论第一页没有游标');
    expect(firstPage.items).toHaveLength(1);
    const secondPage = await listPostComments(ports, {
      postId: post.id,
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.ok).toBe(true);

    expect(
      await deleteComment(ports, { commentId: 'missing', authorId: 'author-1' }),
    ).toMatchObject({
      ok: false,
      failure: { code: 'COMMENT_NOT_FOUND' },
    });
    expect(
      await deleteComment(ports, { commentId: 'comment-1', authorId: 'author-2' }),
    ).toMatchObject({ ok: false, failure: { code: 'COMMENT_FORBIDDEN' } });
    expect(
      await deleteComment(ports, { commentId: 'comment-1', authorId: 'comment-author-1' }),
    ).toEqual({
      ok: true,
      commentId: 'comment-1',
    });
    expect(await loadVisibleComment(ports, 'comment-1')).toBeNull();
  });
});

describe('社区点赞操作', () => {
  it('处理不存在、重复点赞与重复取消', async () => {
    const post = makePost('post-reactions', NOW);
    const { ports } = createPorts([post]);

    expect(await likePost(ports, { postId: 'missing', userId: 'user-1' })).toMatchObject({
      ok: false,
      failure: { code: 'POST_NOT_FOUND' },
    });
    expect(await unlikePost(ports, { postId: 'missing', userId: 'user-1' })).toMatchObject({
      ok: false,
      failure: { code: 'POST_NOT_FOUND' },
    });
    expect(await likePost(ports, { postId: post.id, userId: 'user-1' })).toEqual({
      ok: true,
      postId: post.id,
      liked: true,
    });
    expect(await likePost(ports, { postId: post.id, userId: 'user-1' })).toEqual({
      ok: true,
      postId: post.id,
      liked: true,
    });
    expect(await unlikePost(ports, { postId: post.id, userId: 'user-1' })).toEqual({
      ok: true,
      postId: post.id,
      liked: false,
    });
    expect(await unlikePost(ports, { postId: post.id, userId: 'user-1' })).toEqual({
      ok: true,
      postId: post.id,
      liked: false,
    });
  });
});

describe('社区举报与审核操作', () => {
  it('覆盖目标检查、幂等举报、驳回、下架、终态与管理员列表', async () => {
    const post = makePost('post-moderation', NOW);
    const comment = makeComment('comment-moderation', post.id, NOW);
    const { ports, store } = createPorts([post]);
    store.comments.set(comment.id, comment);

    expect(
      await createReport(ports, {
        reporterId: 'reporter-1',
        targetType: 'post',
        targetId: 'missing',
        reason: '理由',
      }),
    ).toMatchObject({ ok: false, failure: { code: 'POST_NOT_FOUND' } });
    expect(
      await createReport(ports, {
        reporterId: 'reporter-1',
        targetType: 'comment',
        targetId: 'missing',
        reason: '理由',
      }),
    ).toMatchObject({ ok: false, failure: { code: 'COMMENT_NOT_FOUND' } });

    const commentReport = await createReport(ports, {
      reporterId: 'reporter-1',
      targetType: 'comment',
      targetId: comment.id,
      reason: '评论需要审核',
    });
    expect(commentReport).toMatchObject({ ok: true, alreadyReported: false });
    if (!commentReport.ok) throw new Error('评论举报创建失败');
    expect(
      await createReport(ports, {
        reporterId: 'reporter-1',
        targetType: 'comment',
        targetId: comment.id,
        reason: '重复举报',
      }),
    ).toEqual({ ok: true, reportId: commentReport.reportId, alreadyReported: true });

    const postReport = await createReport(ports, {
      reporterId: 'reporter-1',
      targetType: 'post',
      targetId: post.id,
      reason: '帖子需要审核',
    });
    expect(postReport).toMatchObject({ ok: true, alreadyReported: false });
    if (!postReport.ok) throw new Error('帖子举报创建失败');
    expect(
      await confirmTakedown(ports, {
        reportId: postReport.reportId,
        actorId: 'user-1',
        actorRole: 'user',
      }),
    ).toMatchObject({ ok: false, failure: { code: 'NOT_ADMIN' } });

    const dismissed = await dismissReport(ports, {
      reportId: commentReport.reportId,
      actorId: 'admin-1',
      actorRole: 'admin',
    });
    expect(dismissed).toMatchObject({ ok: true, targetType: 'comment', targetId: comment.id });
    expect(store.comments.get(comment.id)?.deletedAt).toBeNull();
    expect(
      await dismissReport(ports, {
        reportId: commentReport.reportId,
        actorId: 'admin-1',
        actorRole: 'admin',
      }),
    ).toMatchObject({ ok: false, failure: { code: 'REPORT_ALREADY_HANDLED' } });

    expect(
      await confirmTakedown(ports, {
        reportId: 'missing',
        actorId: 'admin-1',
        actorRole: 'admin',
      }),
    ).toMatchObject({ ok: false, failure: { code: 'REPORT_NOT_FOUND' } });
    expect(
      await confirmTakedown(ports, {
        reportId: postReport.reportId,
        actorId: 'admin-1',
        actorRole: 'admin',
      }),
    ).toMatchObject({ ok: true, targetType: 'post', targetId: post.id });
    expect(
      await confirmTakedown(ports, {
        reportId: postReport.reportId,
        actorId: 'admin-1',
        actorRole: 'admin',
      }),
    ).toMatchObject({ ok: false, failure: { code: 'REPORT_ALREADY_HANDLED' } });

    expect(await listPendingReports(ports, { actorRole: 'user' })).toMatchObject({
      ok: false,
      failure: { code: 'NOT_ADMIN' },
    });
    expect(await listPendingReports(ports, { actorRole: 'admin' })).toMatchObject({ ok: true });
    expect(await listAuditLogs(ports, { actorRole: 'user' })).toMatchObject({
      ok: false,
      failure: { code: 'NOT_ADMIN' },
    });
    expect(await listAuditLogs(ports, { actorRole: 'admin' })).toMatchObject({ ok: true });
  });

  it('在唯一约束竞态下回读、重试，并在连续冲突时返回可重试错误', async () => {
    const post = makePost('post-race', NOW);
    const race = createPorts([post]);
    const racedReport = makeReport('report-raced', post.id, NOW);
    let raceFinds = 0;
    race.ports.findOpenReport = async () => {
      raceFinds += 1;
      return raceFinds === 1 ? null : racedReport;
    };
    race.ports.insertReport = async () => null;
    expect(
      await createReport(race.ports, {
        reporterId: 'reporter-1',
        targetType: 'post',
        targetId: post.id,
        reason: '竞态',
      }),
    ).toEqual({ ok: true, reportId: racedReport.id, alreadyReported: true });

    const retry = createPorts([post]);
    const retriedReport = makeReport('report-retried', post.id, NOW);
    let insertCount = 0;
    retry.ports.findOpenReport = async () => null;
    retry.ports.insertReport = async () => {
      insertCount += 1;
      return insertCount === 1 ? null : retriedReport;
    };
    expect(
      await createReport(retry.ports, {
        reporterId: 'reporter-1',
        targetType: 'post',
        targetId: post.id,
        reason: '重试',
      }),
    ).toEqual({ ok: true, reportId: retriedReport.id, alreadyReported: false });

    const conflict = createPorts([post]);
    conflict.ports.findOpenReport = async () => null;
    conflict.ports.insertReport = async () => null;
    expect(
      await createReport(conflict.ports, {
        reporterId: 'reporter-1',
        targetType: 'post',
        targetId: post.id,
        reason: '持续冲突',
      }),
    ).toMatchObject({ ok: false, failure: { code: 'CONTENT_WRITE_CONFLICT' } });
  });
});
