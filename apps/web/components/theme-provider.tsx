'use client';

/**
 * 主题上下文。
 *
 * 只做一层包装，不自己实现主题逻辑——那件事 next-themes 已经做对了两件容易做错的事：
 *
 * 1. **首屏不闪白**：它在 `<head>` 里注入一段同步脚本，在浏览器绘制前就把 class 打到
 *    `<html>` 上。自己在 `useEffect` 里应用主题会先渲染默认主题再改，用户会看到一下白闪。
 * 2. **跟随系统是真的跟随**：`matchMedia('(prefers-color-scheme: dark)')` 的 `change`
 *    事件会被订阅，系统在傍晚自动切深色时页面跟着切，而不是只在刷新时读一次。
 *
 * 本文件存在的意义是把那些**必须固定**的选项收口在一处，别让每个布局各写一套。
 */
import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ThemeProviderProps } from 'next-themes';

import { THEME_STORAGE_KEY } from './theme';

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider
      /*
       * class 而不是 data 属性：`app/globals.css` 的深色 token 挂在 `.dark` 上，
       * 这条线两头必须对齐。
       */
      attribute="class"
      /* 没选过时跟着系统——PRD 4.2 的默认值，也是「不打扰用户」的那一个。 */
      defaultTheme="system"
      enableSystem
      /*
       * 顺手维护 `color-scheme`。这一条管的是浏览器**原生**控件
       * （滚动条、下拉箭头、日期选择器）的着色，纯 CSS 令牌管不到它们；
       * 少写这一行，深色模式下滚动条会白得刺眼。
       */
      enableColorScheme
      /*
       * 切换主题时禁用过渡。开着的话，主题切换会让页面上所有带 `transition` 的元素
       * 一起动画一遍——包括从 `oklch` 跳到另一个 `oklch` 的文字颜色，观感是整页发糊。
       */
      disableTransitionOnChange
      storageKey={THEME_STORAGE_KEY}
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
