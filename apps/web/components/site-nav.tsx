'use client';

/**
 * 公开站点的顶栏。
 *
 * 与 `components/responsive-nav.tsx` 的分工：那个是**登录后**的工作区骨架（桌面侧边栏 +
 * 移动底部 Tab），这个是**未登录也能看**的公开页顶栏。
 *
 * ## 为什么公开页没有第二套壳
 *
 * `docs/PRD.md` 4.1 要求「导航在移动端与桌面端各一套壳」，`docs/ROADMAP.md` M1 把它落实为
 * `ResponsiveNav` 的两套壳。这里刻意不照搬底部 Tab，原因是公开页的入口到现在也只有首页：底部
 * Tab 在只有一个格子时会渲染成一条空条——它占掉手机最宝贵的一条带，却不提供任何去处。
 * 两套壳的前提是「有足够多的入口值得占那条带」。
 *
 * 注意 `(site)` 下已经有第二个页面（`/tools`，M2 的工具箱清单），但它的入口放在首页正文里，
 * 没有进顶栏——顶栏链接是「目的地」级别的入口，加它就等于公开入口达到两个。
 * **重新评估的时机**：社区落地、公开入口达到两个以上时，按 `ResponsiveNav` 的写法补底部
 * Tab；到那时 `ITEM_*` 的当前态样式与 `isActive` 都直接复用，不需要新逻辑。
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

export type SiteNavProps = {
  items: readonly NavItem[];
  /** 右侧操作区，通常是主题切换与登录态入口。 */
  actions?: ReactNode;
  /** 导航区的可访问名称。 */
  label: string;
  className?: string;
};

export function SiteNav({ items, actions, label, className }: SiteNavProps) {
  const pathname = usePathname();

  return (
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
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
