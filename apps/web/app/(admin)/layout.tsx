/**
 * `(admin)` 分区外壳：后台管理。
 *
 * ## 这个分区是 M1 退出标准 3 的落点
 *
 * `docs/ROADMAP.md` M1 退出标准 3 要求「非管理员访问 `(admin)` 得到统一拒绝响应」，
 * `docs/PRD.md` 3.5 验收 2 把它写成「不能一处 403 一处 404 一处 500」。实现方式是：本分区
 * **所有**页面都在这一层（以及需要用户信息的页面自己那一层）走 `readAdminAccess()`，
 * 判定结果只由 `features/auth/guard.ts` 翻译成两种响应：
 *
 * | 情形 | 响应 | HTTP |
 * | --- | --- | --- |
 * | 未登录 / 会话失效 | 重定向到登录页 | 307 |
 * | 已登录但不是管理员 | `AccessDenied` 拒绝视图 | 200 |
 *
 * 状态码是 200 而不是 403 的原因写在 `features/auth/guard.ts` 文件头（Next 的真 403 需要
 * 实验特性，本项目不为一个拒绝页引入），对账信息（`403 FORBIDDEN`）直接印在拒绝页上。
 *
 * ## 导航里为什么有一个 `/console/settings`
 *
 * `ResponsiveNav` 在移动端不渲染侧边栏底部，账号面板在手机上就没有落点：后台管理员在手机上
 * 会连退出登录都找不到。而 `/console/settings` 对任何合法角色都开放、内容与角色无关，
 * 因此先复用它。后台自己的账号与站点配置项排在 M5，到那时再决定是否搬进来——现在为它
 * 多做一份页面，等于把「同一组操作两套实现」这条问题提前引入。
 *
 * 后台真正的入口（用户、内容、任务、配置、审计）都在 M5，落地时才加进 `ADMIN_NAV_ITEMS`；
 * 现在写进去只会得到 404。
 */
import Link from 'next/link';
import { LayoutDashboard, Settings } from 'lucide-react';
import type { ReactNode } from 'react';

import { ResponsiveNav, type NavItem } from '@/components/responsive-nav';

import { AccessDenied } from '@/features/auth/access-denied';
import { AccountPanel } from '@/features/auth/account-panel';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { ADMIN_HOME, CONSOLE_SETTINGS, SITE_HOME } from '@/features/auth/routes';
import { readAdminAccess } from '@/features/auth/session';

const ADMIN_NAV_ITEMS: readonly NavItem[] = [
  {
    href: ADMIN_HOME,
    label: '后台概览',
    icon: <LayoutDashboard aria-hidden className="size-5" />,
    /* `/admin` 是将来所有后台子页面的前缀，不精确匹配会让它在每个子页面都高亮。 */
    exact: true,
  },
  {
    href: CONSOLE_SETTINGS,
    label: '账号设置',
    icon: <Settings aria-hidden className="size-5" />,
  },
];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const access = await readAdminAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  return (
    <ResponsiveNav
      label="后台导航"
      items={ADMIN_NAV_ITEMS}
      /* 品牌位同样补 44px 命中区，理由见 `app/(console)/layout.tsx` 的同一处注释。 */
      header={
        <Link
          href={SITE_HOME}
          className="flex min-h-11 flex-col justify-center gap-0.5 text-sm font-semibold tracking-tight"
        >
          <span>xsu-cloud</span>
          {/* 后台与用户控制台的观感必须能一眼区分，否则误操作会发生在最不该发生的地方。 */}
          <span className="text-xs font-normal text-muted-foreground">后台管理</span>
        </Link>
      }
      footer={<AccountPanel name={access.user.name} email={access.user.email} />}
    >
      <div className="mx-auto w-full max-w-5xl px-4 py-6">{children}</div>
    </ResponsiveNav>
  );
}
