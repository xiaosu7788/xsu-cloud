/**
 * 内容管理（`/admin/content`）：帖子与评论的全状态列表、下架与恢复。
 *
 * ## 页面结构
 *
 * 两张独立的表（`ResponsiveTable`）：帖子在上、评论在下，各自用 `postPage` / `commentPage`
 * 偏移分页——两个表的翻页互不干扰，动作回跳时由隐藏字段把两个页码原样带回。
 *
 * ## 状态语义
 *
 * 列表**不过滤软删除**（后台要能看见并恢复它们）。`deleted_at` 非空即「已下架 / 已删除」：
 * 数据层不区分是管理员下架还是作者删除（同一列），徽章按 SPEC 的合并措辞展示，操作列按
 * 状态给「下架」或「恢复」。恢复评论时父帖已删除会被领域层拒绝（`parentPostDeleted`）。
 *
 * ## 富化
 *
 * 作者名字复用 `createCommunityPorts().authorSummaries`（举报页同款），两个列表的作者 id
 * 合并去重后一批查回。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import type { AdminCommentRow, AdminPostRow } from '@xsu/core';
import { ADMIN_PAGE_SIZE_DEFAULT, listCommentsForAdmin, listPostsForAdmin } from '@xsu/core';
import type { AuthorSummary } from '@xsu/db';
import { createAdminGateway, createCommunityPorts } from '@xsu/platform';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ResponsiveTable, type ResponsiveTableColumn } from '@/components/responsive-table';
import { AccessDenied } from '@/features/auth/access-denied';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readAdminAccess } from '@/features/auth/session';
import { ADMIN_CONTENT } from '@/features/admin/routes';
import {
  AdminBanner,
  AdminPager,
  adminExcerpt,
  adminStatusBadge,
  formatAdminDate,
  readErrorCode,
  readOkCode,
} from '@/features/admin/view';
import { communityPostPath } from '@/features/community/routes';

import {
  restoreCommentAction,
  restorePostAction,
  takedownCommentAction,
  takedownPostAction,
} from './actions';

export const metadata: Metadata = {
  title: '内容管理',
};

/** 状态徽章：正常 / 已下架或已删除（同一列，合并措辞）。 */
function statusCell(deletedAt: Date | null) {
  if (deletedAt === null) {
    return <span className={adminStatusBadge('ok')}>正常</span>;
  }
  return <span className={adminStatusBadge('danger')}>已下架 / 已删除</span>;
}

/** 隐藏字段：动作回跳时把两个表的页码原样带回。 */
function pageInputs(postPage: number, commentPage: number) {
  return (
    <>
      <input type="hidden" name="postPage" value={String(postPage)} />
      <input type="hidden" name="commentPage" value={String(commentPage)} />
    </>
  );
}

export default async function AdminContentPage({
  searchParams,
}: {
  searchParams: Promise<{ postPage?: string; commentPage?: string; ok?: string; error?: string }>;
}) {
  const access = await readAdminAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  const params = await searchParams;
  const toPage = (raw: string | undefined) => {
    const parsed = Number(raw ?? '');
    return Number.isFinite(parsed) && Math.trunc(parsed) >= 1 ? Math.trunc(parsed) : 1;
  };
  const postPage = toPage(params.postPage);
  const commentPage = toPage(params.commentPage);

  const gateway = createAdminGateway();
  const [posts, comments] = await Promise.all([
    listPostsForAdmin(gateway, { actorRole: access.role, page: postPage }),
    listCommentsForAdmin(gateway, { actorRole: access.role, page: commentPage }),
  ]);

  if (!posts.ok) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="内容管理" />
        <p className="text-sm text-destructive">{posts.failure.message}</p>
      </div>
    );
  }

  if (!comments.ok) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="内容管理" />
        <p className="text-sm text-destructive">{comments.failure.message}</p>
      </div>
    );
  }

  // 作者名字富化：两个列表的作者 id 合并去重，一批查回（举报页同款）。
  const communityPorts = await createCommunityPorts({ userId: access.user.id });
  const authorIds = [
    ...new Set([
      ...posts.value.items.map((post) => post.authorId),
      ...comments.value.items.map((comment) => comment.authorId),
    ]),
  ];
  const authors: Map<string, AuthorSummary> = await communityPorts.authorSummaries(authorIds);
  const authorName = (authorId: string) => authors.get(authorId)?.name ?? '已注销用户';

  const postColumns: ResponsiveTableColumn<AdminPostRow>[] = [
    {
      key: 'post',
      header: '帖子',
      primary: true,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <Link
            href={communityPostPath(row.id)}
            className="truncate font-medium underline underline-offset-2"
          >
            {row.title}
          </Link>
          {row.tags.length > 0 ? (
            <span className="truncate text-xs text-muted-foreground">{row.tags.join('、')}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'author',
      header: '作者',
      mobileLabel: '作者',
      cell: (row) => <span className="truncate">{authorName(row.authorId)}</span>,
    },
    {
      key: 'status',
      header: '状态',
      mobileLabel: '状态',
      cell: (row) => statusCell(row.deletedAt),
    },
    {
      key: 'createdAt',
      header: '发布时间',
      mobileLabel: '发布时间',
      cell: (row) => (
        <span className="text-muted-foreground">{formatAdminDate(row.createdAt)}</span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      mobileLabel: '操作',
      cell: (row) =>
        row.deletedAt === null ? (
          <form action={takedownPostAction}>
            <input type="hidden" name="postId" value={row.id} />
            {pageInputs(postPage, commentPage)}
            <Button type="submit" variant="destructive" size="sm">
              下架
            </Button>
          </form>
        ) : (
          <form action={restorePostAction}>
            <input type="hidden" name="postId" value={row.id} />
            {pageInputs(postPage, commentPage)}
            <Button type="submit" variant="outline" size="sm">
              恢复
            </Button>
          </form>
        ),
    },
  ];

  const commentColumns: ResponsiveTableColumn<AdminCommentRow>[] = [
    {
      key: 'comment',
      header: '评论',
      primary: true,
      cell: (row) => <span className="line-clamp-2">{adminExcerpt(row.body)}</span>,
    },
    {
      key: 'author',
      header: '作者',
      mobileLabel: '作者',
      cell: (row) => <span className="truncate">{authorName(row.authorId)}</span>,
    },
    {
      key: 'status',
      header: '状态',
      mobileLabel: '状态',
      cell: (row) => statusCell(row.deletedAt),
    },
    {
      key: 'createdAt',
      header: '发布时间',
      mobileLabel: '发布时间',
      cell: (row) => (
        <span className="text-muted-foreground">{formatAdminDate(row.createdAt)}</span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      mobileLabel: '操作',
      cell: (row) =>
        row.deletedAt === null ? (
          <form action={takedownCommentAction}>
            <input type="hidden" name="commentId" value={row.id} />
            <input type="hidden" name="postId" value={row.postId} />
            {pageInputs(postPage, commentPage)}
            <Button type="submit" variant="destructive" size="sm">
              下架
            </Button>
          </form>
        ) : (
          <form action={restoreCommentAction}>
            <input type="hidden" name="commentId" value={row.id} />
            <input type="hidden" name="postId" value={row.postId} />
            {pageInputs(postPage, commentPage)}
            <Button type="submit" variant="outline" size="sm">
              恢复
            </Button>
          </form>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="内容管理"
        description="帖子与评论的全状态列表：下架立即从公开侧隐藏，恢复会重新可见。全部动作都有审计记录。"
      />

      <AdminBanner ok={readOkCode(params.ok)} error={readErrorCode(params.error)} />

      <Card>
        <CardHeader>
          <CardTitle>帖子</CardTitle>
          <CardDescription>共 {posts.value.total} 篇（含已下架 / 已删除）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ResponsiveTable
            columns={postColumns}
            rows={posts.value.items}
            rowKey={(row) => row.id}
            empty="还没有任何帖子。"
          />
          <AdminPager
            base={ADMIN_CONTENT}
            page={postPage}
            total={posts.value.total}
            limit={ADMIN_PAGE_SIZE_DEFAULT}
            pageKey="postPage"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>评论</CardTitle>
          <CardDescription>共 {comments.value.total} 条（含已下架 / 已删除）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ResponsiveTable
            columns={commentColumns}
            rows={comments.value.items}
            rowKey={(row) => row.id}
            empty="还没有任何评论。"
          />
          <AdminPager
            base={ADMIN_CONTENT}
            page={commentPage}
            total={comments.value.total}
            limit={ADMIN_PAGE_SIZE_DEFAULT}
            pageKey="commentPage"
          />
        </CardContent>
      </Card>
    </div>
  );
}
