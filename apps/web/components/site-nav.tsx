'use client';

/**
 * 公开站点的顶栏。
 *
 * 与 `components/responsive-nav.tsx` 的分工：那个是**登录后**的工作区骨架（桌面侧边栏 +
 * 移动底部 Tab），这个是**未登录也能看**的公开页顶栏。
 *
 * ## 移动端第二套壳（M3 落地）
 *
 * `docs/PRD.md` 4.1 要求「导航在移动端与桌面端各一套壳」。M1 时公开页只有首页，底部 Tab
 * 会渲染成一条空条，因此当时刻意只有顶栏；社区（M3）落地后公开入口达到三个（首页 / 社区 /
 * 工具箱），按当初写下的条件补上移动底部 Tab。写法照搬 `ResponsiveNav` 的移动壳：`h-14` +
 * `pb-[env(safe-area-inset-bottom)]`，当前态复用 `isActive` 与同一组样式变量。
 *
 * **联动约束**：`components/service-worker-registrar.tsx` 的更新提示条按 `mb-14` 避让底部
 * 导航，改这里的高度必须同时改那边。
 *
 * ## 当前态判定复用 `isActive`
 *
 * 从 `responsive-nav` 引入而不是在这里重写：两处对「当前项」的判定必须一致，否则会出现
 * 「顶栏高亮、底栏不高亮」这种只在某个视口下暴露的分叉。`isActive` 就是为这件事导出的。
 *
 * ## 安全区
 *
 * 顶栏是 `sticky top-0`，在 iPhone 横屏、刘海屏下会被状态栏区域盖住；`viewport-fit=cover`
 * 已由根布局开启（见 `app/layout.tsx`），所以这里补 `pt-[env(safe-area-inset-top)]` 即可。
 * 不加的话顶部会有一截内容压在系统状态栏下面，且无法滚动出来。
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { isActive, type NavItem } from '@/components/responsive-nav';
import { cn } from '@/components/utils';

/** 品牌文案。写在这里而不是当 prop：全站只有一个值，多一个入口只会多一处漂移。 */
const BRAND = 'xsu-cloud';

/** 顶栏链接的当前态与常态样式，与 `responsive-nav` 的 `ITEM_*` 语义相同、形状不同（横排）。 */
const LINK_ACTIVE = 'bg-muted font-medium text-foreground';
const LINK_IDLE = 'text-muted-foreground hover:bg-muted hover:text-foreground';

/** 移动 Tab 的当前态样式：竖排（图标在上、文字在下），照搬 `ResponsiveNav` 的移动壳。 */
const TAB_ACTIVE = 'bg-muted font-medium text-foreground';
const TAB_IDLE = 'text-muted-foreground hover:bg-muted hover:text-foreground';

export type SiteNavProps = {
  items: readonly NavItem[];
  /** 右侧操作区，通常是主题切换与登录态入口。 */
  actions?: ReactNode;
  /** 两套壳（顶栏 + 底部 Tab）共用的可访问名称。 */
  label: string;
  className?: string;
};

export function SiteNav({ items, actions, label, className }: SiteNavProps) {
  const pathname = usePathname();

  return (
    <>
      <header
        className={cn(
          'sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur',
          'pt-[env(safe-area-inset-top)]',
          className,
        )}
      >
        {/*
         * `max-w-5xl` + `px-4`：内容宽与 `(site)` 布局的 `<main>` 对齐，否则顶栏的链接与
         * 正文会左右错开几像素。
         * `gap-2` 而不是 `gap-4`：360px 下品牌 + 两个操作项已经很挤，间距从这里省。
         */}
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-2 px-4">
          {/*
           * `h-11` 而不是让文字自己撑高：文字本身只有 20px 高，命中区比 `docs/PRD.md` 4.1
           * 要求的 44px 少了一半以上，360px 实测命中区只有 66x20。顶栏行高是 `h-14`，
           * 装得下 44px 的命中区，不改变视觉位置。
           */}
          <Link
            href="/"
            className="inline-flex h-11 shrink-0 items-center text-sm font-semibold tracking-tight"
          >
            {BRAND}
          </Link>

          {items.length > 0 ? (
            /*
             * `min-w-0`：让这一块可以被压缩；没有它，`flex-1` 的最小宽度按内容算，
             * 链接一多就会把操作区顶出屏幕（360px 下表现为横向滚动）。
             */
            <nav aria-label={label} className="hidden min-w-0 flex-1 md:block">
              <ul className="flex items-center gap-1">
                {items.map((item) => {
                  const active = isActive(pathname, item);
                  return (
                    <li key={item.href} className="min-w-0">
                      <Link
                        href={item.href}
                        /* 高亮底色对屏幕阅读器无效，当前页要单独标出来。 */
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex h-11 items-center gap-2 rounded-md px-3 text-sm transition-colors',
                          active ? LINK_ACTIVE : LINK_IDLE,
                        )}
                      >
                        {item.icon}
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          ) : null}

          {/* `ml-auto` 让操作区无论导航在不在都贴右；`shrink-0` 保证按钮不被压变形。 */}
          {actions ? (
            <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
          ) : null}
        </div>
      </header>

      {/*
       * 移动底部 Tab：`fixed` + `(site)` 布局 `<main>` 上等高的 `pb-*`（3.5rem + safe-area）
       * 共同保证最后一行内容不被 Tab 栏压住，写法与 `ResponsiveNav` 的移动壳一致。
       * `md:hidden`：桌面端顶栏已有横排导航，Tab 只在窄屏出现。公开站项目前 3 项
       * （≤ `MOBILE_TAB_MAX`），按 `flex-1` 平分宽度即可，不需要横向滚动分支。
       */}
      <nav
        aria-label={label}
        className={cn(
          'fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur',
          'pb-[env(safe-area-inset-bottom)] md:hidden',
        )}
      >
        <ul className="flex h-14 items-stretch">
          {items.map((item) => {
            const active = isActive(pathname, item);
            return (
              <li key={item.href} className="min-w-0 flex-1">
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-full flex-col items-center justify-center gap-1 px-3 text-[0.6875rem]',
                    'transition-colors',
                    active ? TAB_ACTIVE : TAB_IDLE,
                  )}
                >
                  {item.icon}
                  <span className="w-full truncate text-center">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
