/**
 * `(console)` 分区外壳：登录后的用户控制台。
 *
 * ## 这个布局是分区里唯一读会话的地方
 *
 * 读会话必然要读请求头（`features/auth/session.ts` 里走 `headers()`），一旦发生，**本分区的
 * 所有页面**都变成动态渲染。这是有意接受的代价，而且被限制在这两个分区里：公开页
 * （`(site)`）不读会话，因此仍然静态预渲染（`docs/ARCHITECTURE.md` 7.1 红线 1、
 * `docs/ROADMAP.md` M1 退出标准 1）。
 *
 * ## 拒绝策略只有一份
 *
 * 判定来自 `readConsoleAccess()`，翻译成响应只走 `features/auth/guard.ts`：未登录弹到登录页，
 * 其余渲染 `AccessDenied`。控制台对任何合法角色都开放，所以后面那条分支当前不可达；保留它
 * 是因为「分区布局必须处理拒绝」这件事在控制台与后台是同一段代码，删掉就会从后台那份里漏掉。
 *
 * **注意**：布局守的是「直接访问本分区的地址」。分区内部跳转时，Next 的路由缓存可能复用
 * 没有变化的布局段，服务端不再执行这里。因此**自己要用用户信息的页面必须自己再守一次**，
 * 见 `app/(console)/console/settings/page.tsx`。
 *
 * ## 两套壳共用一份入口清单
 *
 * `components/responsive-nav.tsx` 用同一个数组渲染桌面侧边栏与移动底部 Tab。清单里每个路径
 * 都必须真的有一个页面——这条约束靠人工 review 维持，见 `features/auth/routes.ts` 文件头。
 * 移动端不渲染侧边栏底部的 `AccountPanel`，所以「账号设置」同时是手机上退出登录与切换主题的
 * 唯一入口，不能从清单里删。

 * 管理员的清单比普通用户多一条「后台管理」，见下面的 `consoleNavItems`。
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { FileText, Gauge, Settings, ShieldCheck, Wrench } from 'lucide-react';

import { isAdmin, type Role } from '@xsu/core';

import { ResponsiveNav, type NavItem } from '@/components/responsive-nav';

import { AccessDenied } from '@/features/auth/access-denied';
import { AccountPanel } from '@/features/auth/account-panel';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { ADMIN_HOME, CONSOLE_HOME, CONSOLE_SETTINGS, SITE_HOME } from '@/features/auth/routes';
import { CONSOLE_COMMUNITY } from '@/features/community/routes';
import { readConsoleAccess } from '@/features/auth/session';
import { CONSOLE_TOOLS } from '@/features/tools/routes';

/**
 * 控制台入口。
 *
 * 每一项都必须真的有一个页面——这条约束靠人工 review，见 `features/auth/routes.ts` 文件头。
 * `console` / `settings` 是 M1 的，工具箱是 M2 的，「我的帖子」是 M3 的。中转站入口与
 * 「我的任务」排在 M4 / M6，落地时加在这里——在导航里写一个还没有页面的路径，用户点进去
 * 只会看到 404。角色相关的项不写在这里，见下面的 `consoleNavItems`。
 */
const CONSOLE_NAV_ITEMS: readonly NavItem[] = [
  {
    href: CONSOLE_HOME,
    label: '控制台',
    icon: <Gauge aria-hidden className="size-5" />,
    /* `/console` 同时是 `/console/settings` 的前缀，不精确匹配就会两项一起高亮。 */
    exact: true,
  },
  {
    href: CONSOLE_TOOLS,
    label: '工具箱',
    icon: <Wrench aria-hidden className="size-5" />,
  },
  {
    href: CONSOLE_COMMUNITY,
    label: '我的帖子',
    icon: <FileText aria-hidden className="size-5" />,
  },
  {
    href: CONSOLE_SETTINGS,
    label: '账号设置',
    icon: <Settings aria-hidden className="size-5" />,
  },
];

/**
 * 控制台入口清单：管理员比普通用户多一条「后台管理」。
 *
 * 角色用的是布局里 `readConsoleAccess()` 的同一个结论——一次请求内只判定一次，不额外查库；
 * 也不下发给客户端判断，非管理员的 HTML 里根本没有这个链接。
 *
 * 这条入口只能长在这里。登录后的落点是控制台，而公开页顶栏（`components/site-nav.tsx`）
 * 不读会话——`(site)` 必须保持静态渲染（`docs/ARCHITECTURE.md` 7.1 红线 1），
 * 所以「谁看得见哪个入口」这类差异只能出现在两个分区外壳里。
 */
function consoleNavItems(role: Role): readonly NavItem[] {
  if (!isAdmin(role)) {
    return CONSOLE_NAV_ITEMS;
  }
  return [
    ...CONSOLE_NAV_ITEMS,
    {
      href: ADMIN_HOME,
      label: '后台管理',
      icon: <ShieldCheck aria-hidden className="size-5" />,
    },
  ];
}

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const access = await readConsoleAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  return (
    <ResponsiveNav
      label="控制台导航"
      items={consoleNavItems(access.role)}
      /*
       * 侧边栏顶部的品牌位。桌面才有；移动端靠各页面自己的标题定位。
       * `min-h-11`：与 `components/site-nav.tsx` 的品牌链接同一理由 —— 文字自身只有 18px 高，
       * 命中区比 `docs/PRD.md` 4.1 要求的 44px 少一半以上（1280px 视口实测 66x18）。
       */
      header={
        <Link
          href={SITE_HOME}
          className="inline-flex min-h-11 items-center text-sm font-semibold tracking-tight"
        >
          xsu-cloud
        </Link>
      }
      footer={<AccountPanel name={access.user.name} email={access.user.email} />}
    >
      {/*
       * 内容宽度与内边距放在布局里：控制台的每个页面都要一致，散到各页面就会出现
       * 「有的页贴左边、有的页居中」。`max-w-4xl` 比公开页窄，工作台类界面不需要长行。
       */}
      <div className="mx-auto w-full max-w-4xl px-4 py-6">{children}</div>
    </ResponsiveNav>
  );
}
