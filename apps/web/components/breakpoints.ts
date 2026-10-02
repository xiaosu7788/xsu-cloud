/**
 * 断点常量。
 *
 * 存在的理由：同一套断点会在两处被用到——
 *
 * - Tailwind 的工具类（`md:grid-cols-2`）；
 * - **必须用 JavaScript 判断**的地方：`ResponsiveGallery` 在桌面端显示左右翻页按钮、
 *   移动端靠滑动，这改变的是 DOM 而不只是样式，CSS 帮不上忙。
 *
 * 两边各写一份数字，改一处忘一处之后的表现是「CSS 认为还在移动端，JS 认为已经到桌面」，
 * 而且只在某个视口宽度区间复现。这里让两边读同一个常量。
 *
 * ## 单位是 rem，不是 px
 *
 * 事实来源是 `tailwindcss@4.3.3` 的 `theme.css` 第 327-331 行：
 *
 *     --breakpoint-sm:  40rem;
 *     --breakpoint-md:  48rem;
 *     --breakpoint-lg:  64rem;
 *     --breakpoint-xl:  80rem;
 *     --breakpoint-2xl: 96rem;
 *
 * Tailwind 4 的默认断点就是 **rem**。媒体查询里的 rem 按根元素的初始字号换算（浏览器默认
 * 16px，用户可以在设置里调大），所以改过默认字号的用户会拿到比例一致的更大断点。这里必须
 * 沿用同一单位：换成 px 会在「改过默认字号」的机器上与 CSS 分叉，而那类机器恰好是需要照顾
 * 的可访问性场景。
 *
 * `BREAKPOINT_PX` 只用于文档和断言里读数，**不参与判定**。
 */

/** 断点基准值，单位 rem。键名与 Tailwind 的 `sm:` / `md:` 工具类前缀一一对应。 */
export const BREAKPOINTS = {
  sm: 40,
  md: 48,
  lg: 64,
  xl: 80,
  '2xl': 96,
} as const;

export type Breakpoint = keyof typeof BREAKPOINTS;

/** 浏览器默认根字号，只用于把 rem 换算成便于阅读的 px。 */
export const DEFAULT_ROOT_FONT_SIZE = 16;

/** 上表的 px 近似值，给人看。判定一律用 `atLeast` / `below`。 */
export const BREAKPOINT_PX: Record<Breakpoint, number> = {
  sm: BREAKPOINTS.sm * DEFAULT_ROOT_FONT_SIZE,
  md: BREAKPOINTS.md * DEFAULT_ROOT_FONT_SIZE,
  lg: BREAKPOINTS.lg * DEFAULT_ROOT_FONT_SIZE,
  xl: BREAKPOINTS.xl * DEFAULT_ROOT_FONT_SIZE,
  '2xl': BREAKPOINTS['2xl'] * DEFAULT_ROOT_FONT_SIZE,
};

/** `min-width` 形式，与 Tailwind 的 `md:` 完全等价。 */
export function atLeast(breakpoint: Breakpoint): string {
  return `(min-width: ${BREAKPOINTS[breakpoint]}rem)`;
}

/**
 * 严格小于该断点，与 Tailwind 4 的 `max-md:` 等价。
 *
 * 用区间比较语法 `(width < 48rem)` 而不是 `(max-width: 47.999rem)`：后者要猜一个
 * 「刚好小一点」的值，一遇到分数像素的视口就会漏掉一小段。区间比较语法 Tailwind 自己
 * 生成 `max-*` 变体时也在用。
 */
export function below(breakpoint: Breakpoint): string {
  return `(width < ${BREAKPOINTS[breakpoint]}rem)`;
}
