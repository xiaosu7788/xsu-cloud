/**
 * Service Worker。纯 JavaScript，放在 `public/` 下原样发布，不经任何构建
 * （因此这里不能出现 TS 语法，也不能 import 别的模块）。
 *
 * ## 一、更新策略：用户确认后刷新，而不是静默立即激活
 *
 * `docs/PRD.md` 4.3 的原文要求是「更新策略必须明确定义 …… 不允许放任用户长期运行旧代码」，
 * 并给了两条路：立即激活，或给用户「有新版本，点击刷新」的提示。这里选后者，原因是
 * 「不允许旧代码」与「不许丢用户输入」会直接冲突：用户可能正停在表单页填一屏字，或者正在上传，
 * 静默 `skipWaiting()` + `clients.claim()` 会让他在下一次导航时突然拿到新产物，未提交的内容一起消失。
 * 所以 install 阶段**不调用 `skipWaiting()`**，新 SW 停在 waiting，由
 * `apps/web/components/service-worker-registrar.tsx` 弹出提示条，用户点了才发 `SKIP_WAITING`。
 *
 * 配套约定：`CACHE_NAME` 带版本号。**改了本文件或下面的预热清单，必须手改版本号**，
 * 否则 activate 里的清理逻辑认不出上一个版本的缓存，旧资源会一直占着配额。
 *
 * ## 二、缓存范围刻意极小
 *
 * PRD 4.3 明确「离线只做『提示页』，不做离线数据」，据此本文件只缓存离线提示页与一组图标：
 *
 * - **HTML 页面与 `app/api/` 一律不缓存**，直接放行给浏览器。它们带登录态与动态内容，
 *   缓存下来会让用户看到别人的、或者昨天的页面 —— 这是 Service Worker 最经典的事故来源；
 * - **只有 `/_next/static/` 进缓存**：那是 Next 的内容哈希产物，内容一变 URL 就变，
 *   cache-first 不可能给出旧内容；
 * - 没有后台同步、没有 IndexedDB：既然不做离线数据，就不存在需要重放的写入队列。
 *
 * ## 三、配色同源（webmanifest 是 JSON，写不了注释，因此记在这里）
 *
 * `manifest.webmanifest` 的 `background_color` 与 `theme_color` 都取 `#0a0a0a`：那是
 * `scripts/generate-pwa-icons.mjs` 生成的图标自身的底色，与 `apps/web/components/theme.ts` 的
 * `THEME_COLOR.dark`、`apps/web/app/globals.css` 里 `.dark` 的 `--background: oklch(0.145 0 0)`
 * 是同一个颜色的三种写法。manifest 只能给一个颜色，取图标同色时安装闪屏上图标与背景之间
 * 没有可见边界（取浅色则会得到白底加一块深色方块的闪屏）。这三处取值必须一起改。
 */

/*
 * ESLint：Service Worker 的 `self` / `caches` 不是 Node 全局量，而仓库根 ESLint 配置目前
 * 只装了 `globals.node`（`packages/config/eslint/index.mjs` 注明浏览器侧全局量随 M1 按目录补）。
 * 这里先用一条指令声明，避免 `pnpm lint`（`eslint .`）扫到本文件时报 `no-undef`；
 * 等那些按目录的浏览器全局量补上之后，这一行可以删掉。
 */
/* global self, caches */

/** 版本号：见文件头第一节，改 SW 或预热清单必须手改这里。 */
const CACHE_NAME = 'xsu-shell-v1';

/** 离线提示页的路径。fetch 的导航回落与 install 的预热共用这一个常量。 */
const OFFLINE_URL = '/offline.html';

/**
 * 预热清单。
 *
 * 刻意不含首页：首页是服务端渲染的动态内容，缓存它等于把登录态页面发给了下一个访客。
 * 图标进清单是因为离线提示页自己会用到它们，缺了会出现「提示页上图标是裂图」。
 */
const PRECACHE_URLS = [
  OFFLINE_URL,
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

/**
 * 安装：把预热清单写进当前版本的缓存。
 *
 * `addAll` 是原子的 —— 任意一个 URL 取不到，整次 install 失败，旧 SW 继续服务。
 * 这是刻意的：宁可保持旧版本，也不要装上一个预热不全、离线时拿不出提示页的 SW。
 * 预热清单里的都是 `public/` 下的静态文件，正常部署下不会失败。
 */
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  // 这里刻意不调用 self.skipWaiting()，理由见文件头第一节。
});

/**
 * 激活：清掉所有非当前版本的缓存，接管未受控页面，然后通知已打开的页面。
 *
 * 清理放在 activate 而不是 install：只有确定新版本真的激活了，删旧缓存才是安全的。
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));

      // 让本次激活立即接管已在打开的页面，否则用户要再刷新一次才会走新 SW。
      await self.clients.claim();

      /*
       * 通知所有窗口「SW 已激活」。提示条组件据此可以确认切换已经落地；
       * 真正的 reload 仍由页面侧的 controllerchange 触发，那条链路不依赖这条消息。
       */
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        client.postMessage({ type: 'SW_ACTIVATED' });
      }
    })(),
  );
});

/**
 * 只接受页面显式发来的 `SKIP_WAITING`（提示条上的「刷新」按钮）。
 * 不监听别的消息类型：SW 一旦开始接受模糊指令，行为就很难从页面侧看清。
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/**
 * `/_next/static/` 的 cache-first。
 *
 * 这些 URL 带内容哈希，同一个 URL 的内容永远不变，所以命中就直接返回、完全不碰网络。
 * 未命中才回源，并把成功响应存一份。
 */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }

  const response = await fetch(request);

  /*
   * 只缓存成功响应。把 404 / 500 存下来的话，一次偶发失败会被固化成永久失败
   * （同一个哈希 URL 之后不会再变）。
   */
  if (response.ok) {
    try {
      await cache.put(request, response.clone());
    } catch {
      /*
       * 配额满、或响应本身不可缓存时 `put` 会 reject。资源这次已经正常返回给页面了，
       * 不该因为写缓存失败让页面报错；这里吞掉异常，但必须吞：不接住就是一个
       * 未处理的 rejection，控制台会多出无意义的错误。
       */
    }
  }

  return response;
}

/**
 * 页面导航的 network-first：真实内容永远优先，只有真的连不上时才给离线提示页。
 */
async function networkFirst(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const offline = await caches.match(OFFLINE_URL);
    if (offline) {
      return offline;
    }

    /*
     * 缓存里也没有提示页（install 没成功、或缓存被系统清掉）：抛回原始网络错误，
     * 让浏览器出它自己的离线错误页。respondWith 收到 undefined 会抛 TypeError，
     * 那比原始错误难查得多。
     */
    throw error;
  }
}

/**
 * 请求分流。
 *
 * 三条放行分支是有意为之，不是遗漏：非 GET 与跨源交给浏览器默认行为；`/api/` 与其余同源请求
 * 直接放行，不拦截也不缓存 —— 把 HTML 或接口响应缓存下来会让旧内容顶掉登录态与动态内容。
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 1. 非 GET、跨源：不介入。
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // 2. 接口：不缓存、不拦截。
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // 3. Next 的内容哈希产物：可以放心 cache-first。
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 4. 页面导航：network-first，失败回落离线提示页。
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  // 5. 其余（图片、字体、页面内 RSC 请求等）：不介入。
});
