'use client';

/**
 * 让 `theme-color` 跟着主题走。
 *
 * `docs/PRD.md` 4.2 的原文要求是「`theme-color` 随主题切换」。这件事没法只用 CSS 做：
 * 那个 meta 影响的是浏览器自己的外框（移动端地址栏、状态栏），CSS 令牌管不到它。
 *
 * ## 为什么是把两个 meta 都改成同一个值
 *
 * 根布局用 Next 的 `viewport.themeColor` 出了**两条**带 `media` 的 meta，
 * 让「跟随系统」在**没有 JavaScript** 时也正确（这是纯 CSS 媒体查询能覆盖的部分）。
 * 一旦用户手动选定主题，真正的主题就不再等于系统偏好，那两条带 `media` 的 meta 会一起给出
 * 错误颜色。这里的做法是保留两条、把 `content` 都改写成「实际生效的主题色」：
 *
 * - 不插入 / 删除节点，因此与 React 对 `<head>` 的托管不会打架，重复执行也是幂等的；
 * - `media` 仍然在，只是两条指向同一个颜色，无论浏览器选哪条结果都对。
 *
 * 没用 `useEffect` 之外的时机：`resolvedTheme` 未就绪时是 `undefined`，此时不动 DOM，
 * 让 Next 预先渲染的值留着——那本就是一个合法颜色，不是未定义状态。
 */
import { useEffect } from 'react';
import { useTheme } from 'next-themes';

import { THEME_COLOR } from './theme';

export function ThemeColorSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (resolvedTheme !== 'light' && resolvedTheme !== 'dark') return;

    const color = THEME_COLOR[resolvedTheme];
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.setAttribute('content', color);
    }
  }, [resolvedTheme]);

  return null;
}
