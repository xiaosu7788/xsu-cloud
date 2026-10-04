/**
 * 退出标准 1：公开页默认静态化（`docs/ARCHITECTURE.md` 7.1 红线 1）。
 *
 * ## 为什么必须看构建期的事实
 *
 * 「这个页面是预渲染的还是按请求渲染的」在浏览器里看不出来：两份 HTML 长得一模一样，
 * 都是同一次 `page.goto()`。所以本文件同时对账两处证据：
 *
 * 1. `next build` 自己写下的清单 —— `prerender-manifest.json` 的 `routes` 记着「哪些路由在
 *    构建期被渲染成了文件」，`app-path-routes-manifest.json` 记着「这个应用一共有哪些页面」；
 * 2. 运行期响应头 —— 预渲染的响应带 `x-nextjs-prerender` 与 `s-maxage` 缓存头，按请求
 *    渲染的带 `no-store`，且没有预渲染标记（本机 `next start` 实测；这个头 Next 会重复写，
 *    取值要按 `headerValues` 的方式看）。
 *
 * 只看第 2 条不够：`x-nextjs-prerender` 是 Next 的实现细节，它改名之后这条断言会变成
 * 「只要不报错就算过」。只看第 1 条也不够：清单是构建的产物，服务起没起、起的是不是这一份
 * 产物，它管不着。两条一起看，钉住的才是「用户收到的那份 HTML 是构建期做出来的」。
 *
 * ## 判据为什么是「反向」的
 *
 * 只写「首页必须在 `routes` 里」的话，将来新加一个公开页并且它读了会话（于是变成动态渲染）
 * 时，这条断言照样绿——而那时被违反的是红线 1，不是构建。因此判据是：公开分区里**每一个**
 * 页面都必须在构建期预渲染，除非它在 `SITE_DYNAMIC_EXCEPTIONS` 里且写明了理由。两边都能红：
 * 新页面忘了静态化会红，例外表过期（页面删了、或已经不动态了）也会红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type TestInfo } from '@playwright/test';

import { SIGN_IN_PATH, SIGN_UP_PATH, SITE_HOME } from '@/features/auth/routes';

import { COMMUNITY_SEARCH } from '@/features/community/routes';

import { NEXT_BUILD_DIR } from './env';

/** 构建产物里「有哪些页面」：键是源码路径（`/(site)/sign-in/page`），值是路由（`/sign-in`）。 */
type AppPathRoutesManifest = Record<string, string>;

/**
 * 构建产物里「哪些页面被预渲染了」。`initialRevalidateSeconds` 为 `false` 表示纯静态，
 * 数字表示带 ISR 的重新生成周期——那是另一件事，退出标准 1 要的是「默认静态化」。
 */
type PrerenderManifest = {
  routes: Record<string, { initialRevalidateSeconds: number | false } | undefined>;
  /**
   * ISR 动态路由（如 `/community/[id]`）不记在 `routes` 里，记在这里。键形如
   * `/community/[id]`（构建清单写法，不带具体 id），运行期要用 routeRegex 或前缀匹配具体 URL。
   */
  dynamicRoutes: Record<string, { routeRegex: string } | undefined>;
};

/**
 * `(site)` 里**有意**按请求渲染的页面。两侧都对账：列在这里但实际是静态、或页面已不存在，
 * 都说明这张表过期了；而某个页面变成动态却没列进来，也一样失败。
 */
const SITE_DYNAMIC_EXCEPTIONS: Readonly<Record<string, string>> = {
  [SIGN_IN_PATH]: '第三方提供方清单来自环境变量，OAuth 失败码必须出现在首屏 HTML（见该页文件头）。',
  [SIGN_UP_PATH]: '已登录的人不该看到注册表单，因此要读会话（见该页文件头）。',
  [COMMUNITY_SEARCH]: '搜索词来自请求的 searchParams，空词与查询结果不能在构建期固化。',
};

/**
 * 构建产物与视口无关：同一份断言在 desktop 与 mobile 两个 project 里只会得到同一个结论，
 * 重复跑只是把同一个结论印两遍。视口相关的东西（导航壳、横向滚动、触控目标）在
 * `public-pages.spec.ts` 里跑。
 */
function onlyOncePerRun(testInfo: TestInfo): void {
  test.skip(
    testInfo.project.name !== 'desktop',
    '构建产物与视口无关，只在 desktop project 里跑一次。',
  );
}

function readBuildArtifact<T>(fileName: string): T {
  const path = join(NEXT_BUILD_DIR, fileName);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new Error(
      `读不到构建产物 ${path}：${String(error)}\n` +
        '本文件读的是 `next build` 写下的清单。playwright.config.ts 的 webServer 已经是先 build 再 start，' +
        '正常从配置跑不会到这里；只有直接对着别处启动的服务跑本文件时，才需要先手工构建一次。',
      /* 保留原始错误：读不到文件与 JSON 坏了要能分开看。 */
      { cause: error },
    );
  }
}
/** 已预渲染的路由集合：`routes` 是静态与 ISR 静态路由，`dynamicRoutes` 是 ISR 动态路由。 */
function prerenderedRoutes(): Set<string> {
  const manifest = readBuildArtifact<PrerenderManifest>('prerender-manifest.json');
  return new Set([...Object.keys(manifest.routes), ...Object.keys(manifest.dynamicRoutes ?? {})]);
}

/**
 * 取一个响应头的取值列表。
 *
 * 同一个头出现多次时 Playwright 会把它们拼成一串：本机实测 `/` 的 `x-nextjs-prerender`
 * 是 `1, 1`（Next 自己写了两遍同一个事实）。因此判定不能拿整串去比 `'1'`——那样「这个标记
 * 出现两次」会被读成「没有预渲染」，而多写一遍与事实本身无关。这里按 `,` 拆开、去重，
 * 剩下的才是这个响应真正声称的事。
 */
function headerValues(headers: Record<string, string | undefined>, name: string): string[] {
  const raw = headers[name];
  if (!raw) return [];
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(values)];
}

/**
 * 按分区目录切分页面路由。API 路由（键以 `/route` 结尾）与 `_not-found`、`_global-error`
 * 这类内部页面（键没有分区前缀）都不算「页面」。
 */
function pageRoutesByPartition(): Map<string, string[]> {
  const byPartition = new Map<string, string[]>();
  const manifest = readBuildArtifact<AppPathRoutesManifest>('app-path-routes-manifest.json');

  for (const [source, route] of Object.entries(manifest)) {
    if (!source.endsWith('/page')) continue;
    const partition = /^\/\(([^)]+)\)\//.exec(source)?.[1];
    if (!partition) continue;
    byPartition.set(partition, [...(byPartition.get(partition) ?? []), route]);
  }

  return byPartition;
}

test('首页在构建期被预渲染，且是纯静态而不是 ISR', async ({ request }) => {
  onlyOncePerRun(test.info());

  const entry = readBuildArtifact<PrerenderManifest>('prerender-manifest.json').routes[SITE_HOME];

  expect(
    entry,
    `${SITE_HOME} 不在 prerender-manifest 的 routes 里：它没有在构建期被渲染。`,
  ).toBeDefined();
  expect(
    entry?.initialRevalidateSeconds,
    '首页带上了 ISR 的重新生成周期：退出标准 1 要的是「默认静态化」。',
  ).toBe(false);

  /* 构建期是静态的，还要确认用户拿到的就是那一份。 */
  const headers = (await request.get(SITE_HOME)).headers();
  expect(
    headerValues(headers, 'x-nextjs-prerender'),
    '首页的响应没有预渲染标记，说明它在请求期重新渲染了。',
  ).toEqual(['1']);
});

test('公开分区里除例外表以外的页面都必须在构建期预渲染', async () => {
  onlyOncePerRun(test.info());

  const siteRoutes = pageRoutesByPartition().get('site') ?? [];
  expect(
    siteRoutes.length,
    '公开分区一个页面都没找到：清单格式变了，或者分区目录不叫 (site) 了。',
  ).toBeGreaterThan(0);

  const prerendered = prerenderedRoutes();

  const missing = siteRoutes.filter(
    (route) => !prerendered.has(route) && !(route in SITE_DYNAMIC_EXCEPTIONS),
  );
  expect(
    missing,
    '这些公开页既没有在构建期预渲染，也没有被登记为例外：要么它读了会话或请求头（红线 1），' +
      '要么它确实该按请求渲染，但忘了写进 SITE_DYNAMIC_EXCEPTIONS 并说明理由。',
  ).toEqual([]);

  const stale = Object.keys(SITE_DYNAMIC_EXCEPTIONS).filter(
    (route) => prerendered.has(route) || !siteRoutes.includes(route),
  );
  expect(
    stale,
    '例外表里有失效的条目：对应页面已经不存在，或者它现在又能静态预渲染了，请删掉这一条。',
  ).toEqual([]);
});

test('控制台与后台的页面一律不得预渲染', async () => {
  onlyOncePerRun(test.info());

  const byPartition = pageRoutesByPartition();
  const guarded = ['console', 'admin'].flatMap((partition) => byPartition.get(partition) ?? []);

  /* 空集合上的断言必然通过，所以先钉住「确实取到了这两个分区的页面」。 */
  expect(
    guarded.length,
    '没取到 (console) 或 (admin) 的页面：清单格式变了，这条断言就没在验任何东西。',
  ).toBeGreaterThanOrEqual(3);

  const prerendered = prerenderedRoutes();
  expect(
    guarded.filter((route) => prerendered.has(route)),
    '受保护页面被预渲染了：它们按定义依赖当前用户，构建期渲染出来的那份对谁都不成立。',
  ).toEqual([]);
});

test('例外表里的公开页在运行期确实按请求渲染', async ({ request }) => {
  onlyOncePerRun(test.info());

  for (const [path, reason] of Object.entries(SITE_DYNAMIC_EXCEPTIONS)) {
    const headers = (await request.get(path)).headers();

    expect(
      headerValues(headers, 'x-nextjs-prerender'),
      `${path} 出现了预渲染标记，但它被登记为按请求渲染，理由是「${reason}」。`,
    ).toEqual([]);
    expect(
      headers['cache-control'],
      `${path} 的缓存头不是「不缓存」，按请求渲染的页面不该被中间层缓存。`,
    ).toContain('no-store');
  }
});
