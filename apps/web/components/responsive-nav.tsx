'use client';

/**
 * 响应式导航壳：桌面侧边栏 + 移动底部 Tab。
 *
 * 对应 `docs/ARCHITECTURE.md` 7.4「`ResponsiveNav`（桌面侧边栏 / 移动底部 Tab 两套壳）」，
 * 是控制台与后台的导航骨架。
 *
 * ## 一份清单驱动两套壳
 *
 * 两套壳渲染同一个 `items` 数组，不是两份配置。分成两份之后必然出现「加了页面只改了
 * 桌面菜单」，而这种缺陷只在手机上出现，本机开发时看不见。
 *
 * ## 显隐用 CSS，不用 JS 判断视口
 *
 * `hidden lg:flex` / `lg:hidden`。理由写在 `components/use-media-query.ts` 的文件头：
 * 服务端拿不到视口宽度，用 JS 判断会先渲染一处、水合后换成另一处。CSS 切换甚至更好——
 * `display: none` 会把另一套壳整个移出可访问性树，屏幕阅读器不会听到两遍同一组链接。
 *
 * ## 移动 Tab 的高度是一个对外承诺
 *
 * `h-14`（3.5rem）且自己吃掉 `env(safe-area-inset-bottom)`。
 * `components/service-worker-registrar.tsx` 的更新提示条按同样两个数值避让底部导航，
 * 改这里必须同时改那边，否则提示条会开始盖住 Tab 栏（盖住主航线入口比看不到更新提示严重）。
 *
 * ## 触控与安全区
 *
 * 两套壳的可点击项都至少 44px 高（`docs/PRD.md` 4.1）：移动 Tab 整格 `h-14`，
 * 桌面侧边栏项 `min-h-11`。移动 Tab 补 `pb-[env(safe-area-inset-bottom)]`，
 * 否则 iPhone 的横条会压住最下面一行文字。
 *
 * 外层用 `min-h-dvh` 而不是 `min-h-screen`：移动浏览器地址栏收起时 `vh` 不变，
 * 用 `vh` 会得到一段被地址栏盖住、滚不到的内容（`docs/PRD.md` 4.1）。
 *
 * ## 两套壳都用亚克力面板
 *
 * 桌面侧边栏走 `glass-sidebar`、移动底部 Tab 走 `glass-panel`（`app/globals.css`），与公开站
 * 顶栏同一套视觉。内容区外面套 `PageEnter`：切页时只有页面内容入场，侧边栏与 Tab 不动 ——
 * 把它们也包进去，点一次导航整个外壳都会跟着闪一下。
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { PageEnter } from '@/components/page-enter';
import { cn } from '@/components/utils';

/**
 * 一条导航项。
 *
 * `icon` 收 `ReactNode` 而不是组件类型：调用方直接写
 * `<Home aria-hidden className="size-5" />`，图标尺寸与装饰性属性在调用点一眼可见，
 * 不必为「怎么把尺寸传给组件」再造一层约定。
 */
export type NavItem = {
  href: string;
  label: string;
  icon?: ReactNode;
  /**
   * 只按完全相等判定当前项。
   *
   * 需要它的场合是「父路径也是一个真实页面」：`/console` 与 `/console/tasks` 并存时，
   * 不写 `exact` 会让访问 `/console/tasks` 时两个项同时高亮。
   */
  exact?: boolean;
};

/**
 * 移动 Tab 的容量上限。
 *
 * 超过这个数量就不再平分宽度，Tab 栏改为横向可滚动：平分会让每项挤到只剩两三个字
 * （360px 下 6 项约 60px/项），而滚动至少还能把标签读全。
 */
const MOBILE_TAB_MAX = 5;

/**
 * 当前项判定。根路径必须精确匹配，否则它会给所有路由都加上高亮。
 *
 * 导出给 `components/site-nav.tsx`（站点顶栏）复用：两套壳的「当前项」语义必须是同一套，
 * 否则会出现「顶栏高亮、底栏不高亮」这类只在某个视口下暴露的分叉。
 */
export function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact || item.href === '/') {
    return pathname === item.href;
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** 当前态样式：靠底色与文字色，不靠 hover（`docs/PRD.md` 4.1 禁止 hover 作唯一反馈）。 */
const ITEM_ACTIVE = 'bg-muted font-medium text-foreground';
const ITEM_IDLE = 'text-muted-foreground hover:bg-muted hover:text-foreground';

export type ResponsiveNavProps = {
  items: readonly NavItem[];
  /** 页面内容。放在这里而不是让调用方另包一层：底部 Tab 需要给内容区留等高内边距。 */
  children?: ReactNode;
  /** 桌面侧边栏顶部，通常是品牌或当前区域名。移动端不渲染。 */
  header?: ReactNode;
  /** 桌面侧边栏底部，通常是主题切换与退出登录。移动端不渲染。 */
  footer?: ReactNode;
  /** 两套壳共用的可访问名称，例如「控制台导航」。 */
  label: string;
  className?: string;
};

export function ResponsiveNav({
  items,
  children,
  header,
  footer,
  label,
  className,
}: ResponsiveNavProps) {
  const pathname = usePathname();
  const scrollable = items.length > MOBILE_TAB_MAX;

  return (
    <div className={cn('flex min-h-dvh flex-col lg:flex-row', className)}>
      {/* 桌面壳：窄屏整块移出可访问性树，不会与底部 Tab 重复播报。 */}
      <aside className="glass-sidebar hidden border-border lg:flex lg:w-60 lg:shrink-0 lg:flex-col lg:border-r">
        {header ? <div className="px-4 py-4">{header}</div> : null}

        <nav aria-label={label} className="flex-1 px-2 py-2">
          <ul className="flex flex-col gap-1">
            {items.map((item) => {
              const active = isActive(pathname, item);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    /* 屏幕阅读器靠它读出「当前页」，高亮底色对它无效。 */
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex min-h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors',
                      active ? ITEM_ACTIVE : ITEM_IDLE,
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

        {footer ? <div className="border-t border-border p-3">{footer}</div> : null}
      </aside>

      <div className="min-w-0 flex-1 pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pb-0">
        {/* 内容区入场动画：外壳（侧边栏 / 底部 Tab）留在外面，不跟着闪。 */}
        <PageEnter>{children}</PageEnter>
      </div>

      {/*
       * 移动壳：`fixed` + 与内容区等高的 `pb-*`（上面的 3.5rem）共同保证最后一行内容
       * 不会被 Tab 栏压住。`z-40` 让对话框、toast 这些 `z-50` 的浮层仍然压在它上面。
       */}
      <nav
        aria-label={label}
        className={cn(
          'glass-panel fixed inset-x-0 bottom-0 z-40 border-t border-border',
          'pb-[env(safe-area-inset-bottom)] lg:hidden',
        )}
      >
        <ul className={cn('flex h-14 items-stretch', scrollable && 'overflow-x-auto')}>
          {items.map((item) => {
            const active = isActive(pathname, item);
            return (
              <li key={item.href} className={cn(scrollable ? 'shrink-0' : 'min-w-0 flex-1')}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-full flex-col items-center justify-center gap-1 px-3 text-[0.6875rem]',
                    'transition-colors',
                    active ? ITEM_ACTIVE : ITEM_IDLE,
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
    </div>
  );
}
