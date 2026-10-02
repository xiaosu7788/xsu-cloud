'use client';

/**
 * 媒体查询 hook。
 *
 * 只在「CSS 表达不了」的地方用：用 CSS 能做的一律用 CSS（`hidden md:flex` 之类）。
 * 判断视口来决定渲染什么结构，会在首屏水合前后给出两个不同的 DOM，代价是布局抖动与
 * 闪烁；`ResponsiveNav` / `ResponsiveTable` 因此都走 CSS 切换，只有
 * `ResponsiveGallery` 的翻页按钮需要这个 hook。
 *
 * 实现用 `useSyncExternalStore` 而不是 `useState` + `useEffect`：
 *
 * 1. 订阅的是浏览器的真实状态，不是 React 的渲染时机，避免「首次渲染读到旧值再补一次渲染」；
 * 2. 服务端快照必须显式给出。这里给 `false`，也就是服务端一律按「不是桌面」渲染。
 *    这不是偷懒：服务端拿不到视口宽度，而 `false` 与 Tailwind 的移动优先写法一致，
 *    保证「服务端渲染出来的结构 = 移动端应有的结构」，桌面端水合成另一个结构时差异最小。
 */
import { useCallback, useSyncExternalStore } from 'react';

import { atLeast, type Breakpoint } from './breakpoints';

/** 订阅一段媒体查询。`query` 变化时重新订阅。 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onStoreChange);
      return () => list.removeEventListener('change', onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 服务端与「首次水合前」的快照。稳定引用，不能写成箭头函数字面量。 */
function getServerSnapshot(): boolean {
  return false;
}

/** 视口是否达到某个断点，等价于 Tailwind 的 `md:`。 */
export function useAtLeast(breakpoint: Breakpoint): boolean {
  return useMediaQuery(atLeast(breakpoint));
}
