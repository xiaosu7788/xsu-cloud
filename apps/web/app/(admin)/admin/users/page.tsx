/**
 * 用户管理（`/admin/users`）：搜索、改角色、封禁 / 解封。
 *
 * ## 页面结构
 *
 * 顶部是 GET 搜索表单（`?q=`，与社区搜索页同一形态）；下面是用户表格
 * （`ResponsiveTable` 宽表 + 移动卡片），每行的操作列：
 *
 * - **自己那一行不渲染任何表单**——防自锁的第一、二规则在领域层兜底
 *   （`selfRoleChange` / `selfBan`），但界面直接不给入口才是第一道防线；
 * - 改角色用 `<select>` + 提交按钮；封禁弹出理由输入（`<details>` 展开一个内联表单）；
 *   解封是一个按钮。
 *
 * ## 状态语义
 *
 * `bannedAt` 非空即封禁中；封禁理由在表格里截断显示（完整值看审计日志的 detail）。
 * 操作结果经 `?ok=` / `?error=` 回本页横幅（SPEC §5），搜索关键词与页码由表单隐藏字段
 * 原样带回。
 */
import type { Metadata } from 'next';

import type { AdminUserView } from '@xsu/core';
import { ADMIN_PAGE_SIZE_DEFAULT, listUsersForAdmin } from '@xsu/core';
import { createAdminGateway } from '@xsu/platform';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ResponsiveTable, type ResponsiveTableColumn } from '@/components/responsive-table';
import { AccessDenied } from '@/features/auth/access-denied';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readAdminAccess } from '@/features/auth/session';
import { ADMIN_USERS } from '@/features/admin/routes';
import {
  AdminBanner,
  AdminPager,
  formatAdminDate,
  readErrorCode,
  readOkCode,
} from '@/features/admin/view';

import { banUserAction, unbanUserAction, updateUserRoleAction } from './actions';

export const metadata: Metadata = {
  title: '用户管理',
};

/** 角色下拉的选项。`ROLES` 的顺序即展示顺序（user 在前，admin 在后）。 */
const ROLE_OPTIONS = [
  { value: 'user', label: 'user' },
  { value: 'admin', label: 'admin' },
] as const;

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; ok?: string; error?: string }>;
}) {
  const access = await readAdminAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  const params = await searchParams;
  const query = typeof params.q === 'string' ? params.q : '';
  const page = (() => {
    const parsed = Number(params.page ?? '');
    return Number.isFinite(parsed) && Math.trunc(parsed) >= 1 ? Math.trunc(parsed) : 1;
  })();

  const gateway = createAdminGateway();
  const users = await listUsersForAdmin(gateway, {
    actorRole: access.role,
    query,
    page,
  });

  if (!users.ok) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="用户管理" />
        <p className="text-sm text-destructive">{users.failure.message}</p>
      </div>
    );
  }

  const rows = users.value.items;
  const columns: ResponsiveTableColumn<AdminUserView>[] = [
    {
      key: 'user',
      header: '用户',
      primary: true,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{row.name}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{row.email}</span>
        </div>
      ),
    },
    {
      key: 'role',
      header: '角色',
      mobileLabel: '角色',
      cell: (row) => <span className="font-mono text-xs">{row.role}</span>,
    },
    {
      key: 'status',
      header: '状态',
      mobileLabel: '状态',
      cell: (row) =>
        row.bannedAt !== null ? (
          <span className="text-destructive">
            封禁中
            {row.banReason !== null ? (
              <span className="block text-xs text-muted-foreground">{row.banReason}</span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">正常</span>
        ),
    },
    {
      key: 'createdAt',
      header: '注册时间',
      mobileLabel: '注册时间',
      cell: (row) => (
        <span className="text-muted-foreground">{formatAdminDate(row.createdAt)}</span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      mobileLabel: '操作',
      cell: (row) =>
        row.id === access.user.id ? (
          <span className="text-xs text-muted-foreground">当前登录者</span>
        ) : (
          <div className="flex flex-col gap-2">
            <form action={updateUserRoleAction} className="flex items-center gap-1">
              <input type="hidden" name="userId" value={row.id} />
              <input type="hidden" name="q" value={query} />
              <input type="hidden" name="page" value={String(page)} />
              <Select
                name="role"
                defaultValue={row.role}
                aria-label={`选择 ${row.email} 的新角色`}
                className="h-9 w-24 text-xs"
              >
                {ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <Button type="submit" variant="outline" size="sm">
                改角色
              </Button>
            </form>
            {row.bannedAt === null ? (
              <details className="flex flex-col gap-1">
                <summary className="cursor-pointer text-xs text-muted-foreground">封禁…</summary>
                <form action={banUserAction} className="flex flex-col gap-1">
                  <input type="hidden" name="userId" value={row.id} />
                  <input type="hidden" name="q" value={query} />
                  <input type="hidden" name="page" value={String(page)} />
                  <Input
                    type="text"
                    name="reason"
                    maxLength={200}
                    placeholder="封禁理由（可留空）"
                    aria-label={`填写 ${row.email} 的封禁理由`}
                    className="h-9 text-xs"
                  />
                  <Button type="submit" variant="destructive" size="sm">
                    确认封禁
                  </Button>
                </form>
              </details>
            ) : (
              <form action={unbanUserAction}>
                <input type="hidden" name="userId" value={row.id} />
                <input type="hidden" name="q" value={query} />
                <input type="hidden" name="page" value={String(page)} />
                <Button type="submit" variant="outline" size="sm">
                  解封
                </Button>
              </form>
            )}
          </div>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="用户管理"
        description="按邮箱或名字模糊搜索；封禁会立即让该用户的全部会话下线。全部操作都有审计记录。"
      />

      <AdminBanner ok={readOkCode(params.ok)} error={readErrorCode(params.error)} />

      {/* GET 表单：搜索是读操作，刷新、分享、回退都不应重放。 */}
      <form action={ADMIN_USERS} method="get" role="search" className="flex items-center gap-2">
        <Input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="按邮箱或名字搜索"
          aria-label="搜索用户"
          className="max-w-xs"
        />
        <Button type="submit" variant="outline">
          搜索
        </Button>
      </form>

      <Card>
        <CardHeader>
          <CardTitle>用户列表</CardTitle>
          <CardDescription>
            {query === ''
              ? `共 ${users.value.total} 个账号。`
              : `匹配「${query}」共 ${users.value.total} 条。`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ResponsiveTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            empty={query === '' ? '还没有注册用户。' : '没有匹配的用户。'}
          />
          <AdminPager
            base={ADMIN_USERS}
            page={page}
            total={users.value.total}
            limit={ADMIN_PAGE_SIZE_DEFAULT}
            q={query}
          />
        </CardContent>
      </Card>
    </div>
  );
}
