/**
 * 根布局。三个路由分区（`(site)`/`(console)`/`(admin)`）共用这一层壳。
 *
 * ## 为什么主题、`theme-color`、Service Worker 都挂在这里
 *
 * 这三件事都必须是「全站只有一处」：分散到三个分区布局里，必然出现某个分区忘了挂
 * `ThemeProvider` 于是深色不生效、或者漏注册 SW 于是那个分区没有离线提示页。
 *
 * ## 这里刻意不读会话
 *
 * 根布局一旦调用 `cookies()` 或读会话，**整站**都会变成动态渲染，直接违反
 * `docs/ARCHITECTURE.md` 7.1 红线 1 与 `docs/ROADMAP.md` M1 退出标准 1。
 * 登录态因此分两处处理，都在更靠近使用点的地方：
 *
 * - 需要服务端判定的分区（`(console)` / `(admin)`）在自己的布局里读，只有那两个分区
 *   变成动态；
 * - 公开页顶部的登录态提示走客户端（`features/auth/session-badge.tsx`），拿的是
 *   `/api/auth/get-session`，因此公开页仍然静态。
 *
 * ## `suppressHydrationWarning` 不是随手加的
 *
 * next-themes 在浏览器绘制前就往 `<html>` 上打 `class` 与 `style="color-scheme"`，
 * 这与服务端渲染出的 `<html>` 属性必然不同。不写这一条，每次首屏都会报水合不一致。
 * 它只作用在这一层元素上，不会掩盖子树的真实水合错误。
 */
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { ServiceWorkerRegistrar } from '@/components/service-worker-registrar';
import { THEME_COLOR } from '@/components/theme';
import { ThemeColorSync } from '@/components/theme-color-sync';
import { ThemeProvider } from '@/components/theme-provider';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'xsu-cloud', template: '%s · xsu-cloud' },
  description: '个人云站：中转站控制台、社区、工具箱与生图工作台。',
  applicationName: 'xsu-cloud',
  manifest: '/manifest.webmanifest',
  /* iOS 加到主屏后的行为。桌面与安卓由 manifest 接管，这里只补 Safari 缺的那部分。 */
  appleWebApp: { capable: true, title: 'xsu-cloud', statusBarStyle: 'default' },
  icons: {
    /*
     * 只列 `purpose="any"` 的两个。maskable 图标交给 manifest：`<link rel="icon">` 没有
     * 表达 purpose 的位置，放这里只会让浏览器在地址栏用一张被裁过的图。
     */
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    /* Safari 不吃 manifest 的图标，这一条不能省，否则 iOS 主屏图标是页面截图。 */
    apple: [{ url: '/icons/apple-touch-icon.png', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /*
   * `viewport-fit=cover` 是 `env(safe-area-inset-*)` 生效的前提。
   * 少了它，`components/responsive-nav.tsx` 与 `ui/button.tsx` 里那些安全区内边距
   * 全部算成 0，iPhone 上底部 Tab 会被手势条压住。
   */
  viewportFit: 'cover',
  /*
   * 出两条带 `media` 的 meta，让「跟随系统且没有 JavaScript」时地址栏颜色也正确。
   * 用户手动选定主题后由 `ThemeColorSync` 把两条都改写成实际生效的主题色——
   * 那时系统偏好已不再等于真实主题，保留 media 只是为了让浏览器无论选哪条都对。
   */
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: THEME_COLOR.light },
    { media: '(prefers-color-scheme: dark)', color: THEME_COLOR.dark },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      {/*
       * `bg-background` / `text-foreground` 放在 body 而不是各分区布局：否则滚动到内容
       * 之外（橡皮筋回弹区）露出的底色由浏览器决定，深色下会闪白。
       */}
      <body className="bg-background text-foreground antialiased">
        <ThemeProvider>
          {children}
          <ThemeColorSync />
        </ThemeProvider>
        {/* SW 只增强，不影响首屏；放在 theme 之外避免它被主题切换连带重渲染。 */}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
