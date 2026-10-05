/**
 * `(site)` 分区外壳：公开页。
 *
 * ## 这个布局刻意不读会话
 *
 * 与根布局同一条理由（`app/layout.tsx` 文件头）：一旦在布局里调用 `cookies()`，
 * **整个分区**都会变成动态渲染，`docs/ROADMAP.md` M1 退出标准 1 随之失效。
 * 顶栏的登录态因此由客户端组件 `SessionBadge` 自己拿（它读 `/api/auth/get-session`）。
 *
 * 这是本分区唯一一处与鉴权有关的东西，也正是「公开页默认静态化」这条要求的落点：
 * 判断依据是 `next build` 的输出里 `/` 标着 `○`（静态预渲染），而不是代码里没出现
 * `cookies`。公开分区里有一个**有意为之**的动态例外：`/sign-in` 要按请求读环境配置与
 * OAuth 回调参数，理由写在该页文件头。
 *
 * ## 导航清单为什么放在这个文件里
 *
 * `SiteNav` 收的是「一个分区自己的入口清单」，它属于布局的装配，
 * 不属于任何业务模块。放进 `features/` 会让一个还没建立的模块先有一套目录。
 * 等社区、工具箱落地时，各自的入口由各自模块导出，这里只做拼装。
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { PageEnter } from '@/components/page-enter';
import { SiteNav } from '@/components/site-nav';
import { ThemeToggle } from '@/components/theme-toggle';

import { SessionBadge } from '@/features/auth/session-badge';
import { SITE_HOME } from '@/features/auth/routes';
import { COMMUNITY_HOME } from '@/features/community/routes';

/**
 * 顶栏链接。
 *
 * 只放**确实存在**的公开页。写一个指向 `/community` 的入口而去访问一个 404，比少一个入口
 * 严重得多——「导航里出现的每个路径都必须真的有一个页面」是一条靠人工 review 维持的约束，
 * 见 `features/auth/routes.ts` 文件头。
 *
 * 工具箱（M2）与社区（M3）的入口已在 M3 一起加进顶栏：公开入口达到两个以上后，
 * `components/site-nav.tsx` 按 M1 写下的条件补上了移动底部 Tab（首页 / 社区 / 工具箱三项）。
 * 此后每个新公开页落地时都要同时更新这份清单与移动 Tab——它们由同一个数组渲染。
 */
const SITE_NAV_ITEMS = [
  { href: SITE_HOME, label: '首页', exact: true },
  { href: COMMUNITY_HOME, label: '社区', exact: false },
  { href: '/tools', label: '工具箱', exact: false },
] as const;

export const metadata: Metadata = {
  description: '个人云站：中转站控制台、社区、工具箱与生图工作台。',
};

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      {/*
       * 操作区顺序是「主题 → 登录态」：主题切换在任何登录状态下都在，位置固定，
       * 用户不必因为登录与否去找它。移动端两个按钮都占 44px（`Button` 的 `sm` 与
       * `icon` 尺寸在小屏都是 44px，见 `components/ui/button.tsx`）。
       */}
      <SiteNav
        label="站点导航"
        items={SITE_NAV_ITEMS}
        actions={
          <>
            <ThemeToggle />
            <SessionBadge />
          </>
        }
      />

      {/*
       * `flex-1` 让内容不足一屏时也能把页面撑满，避免深色下页脚下露出一条异色。
       * 宽度与顶栏一致（`max-w-5xl` + `px-4`），否则两者的左右边缘会错开。
       *
       * 移动端 `pb-[calc(3.5rem+env(safe-area-inset-bottom))]`：给 `SiteNav` 的底部 Tab
       * 让位（`h-14` = 3.5rem），与 `ResponsiveNav` 内容区的写法一致——安全区由 Tab 栏自己
       * 吃掉，内容区只让出 Tab 栏高度本身。`md:pb-0`：桌面端没有 Tab，恢复原 `py-8`。
       *
       * 内容外面套 `PageEnter`（客户端组件）：切页时页面区块依次淡入，而顶栏与底部 Tab 在它
       * 外面、不参与。它取 `usePathname()` 而不是 `useSearchParams()` —— 后者会要求 Suspense
       * 边界，并让本分区失去静态预渲染，直接违反本文件开头那条红线。
       */}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
        <PageEnter>{children}</PageEnter>
      </main>
    </div>
  );
}
