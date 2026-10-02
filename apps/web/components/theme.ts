/**
 * 主题选择的取值与常量。
 *
 * 抽到独立文件的原因：`attribute="class"`（next-themes 往 `<html>` 打 class）、
 * `storageKey`、`theme-color` 的色值这三样东西必须**只写一处**——
 * 根布局（服务端）要色值来出初始 `viewport`，切换组件（客户端）要 key 与取值来读写。
 * 分散写会得到「localStorage 里是 `theme`，代码里读 `xsu-theme`」这类静默失效。
 */

/**
 * 三选一，不是「开/关」。
 *
 * 用一个二态开关表达「跟随系统」是不可能的：`theme !== 'dark'` 既可能是「明确选了浅色」，
 * 也可能是「还没选过，跟着系统」。用户点一下之后就无法回到「跟着系统」，
 * 而 `docs/PRD.md` 4.2 明确要求保留这个状态。
 */
export const THEMES = ['light', 'dark', 'system'] as const;

export type ThemeChoice = (typeof THEMES)[number];

/**
 * `localStorage` 的键。
 *
 * 带 `xsu-` 前缀是因为站点可能与同域下的别的应用共存（`docs/PRD.md` 1 节：本项目
 * 与外部系统共享域名），一个叫 `theme` 的键会互相覆盖。
 */
export const THEME_STORAGE_KEY = 'xsu-theme';

/**
 * 浏览器 UI（地址栏、状态栏）的着色。
 *
 * 必须与 `app/globals.css` 里的 `--background` 一致，否则深色模式下页面与浏览器
 * 外框会出现一条突兀的分界线。两个值都是那一对 token 的精确 sRGB 表示：
 *
 * - `oklch(1 0 0)`      → `#ffffff`
 * - `oklch(0.145 0 0)`  → `#0a0a0a`
 *
 * 改 token 时要一起改这里。用十六进制而不是 oklch 是因为 `theme-color` 的解析
 * 依赖浏览器对 CSS 颜色语法的支持，十六进制在任何地方都成立。
 */
export const THEME_COLOR: Record<'light' | 'dark', string> = {
  light: '#ffffff',
  dark: '#0a0a0a',
};

/** 把任意取值收敛成三选一。来自 localStorage 或用户输入时用得上。 */
export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}
