/**
 * Playwright 配置（`AGENTS.md` 第 7 节的「PR 级」验证）。
 *
 * 它验的不是「页面能打开」，而是 `docs/ROADMAP.md` M1 三条退出标准各自的那件事实：
 * 公开页静态预渲染、桌面与移动两套视口下导航可用且 360px 无横向滚动、非管理员访问
 * `(admin)` 得到统一拒绝响应。这三条此前只有一次性手工实测，没有可重跑的回归。
 *
 * ## 下面第一条 import 的顺序不能动
 *
 * `./e2e/env` 在被求值时设定 `PLAYWRIGHT_BROWSERS_PATH`，而 `playwright-core` 是在自己
 * 被 import 的那一刻把该变量读走的。`import` 会被提升到文件顶部，所以「在上面写一行
 * 赋值语句」在这里没用，只能靠「它排在第一条 import」来保证先后。完整理由写在
 * `e2e/env.ts` 的文件头。
 *
 * ## 两套视口做成两个 project，而不是一个用例里的两次 goto
 *
 * 视口、`isMobile`、`hasTouch`、`deviceScaleFactor` 四件套由 Playwright 在创建浏览器
 * 上下文时给定；在用例里手动 `setViewportSize()` 会触发一次重排，「首屏就不该横向滚动」
 * 这件事于是测不到——那正是退出标准 2 要验的东西。
 *
 * ## 为什么不用 `devices['Desktop Chrome']`
 *
 * 那套预设带 `channel: 'chrome'`，要求机器上另行安装品牌 Chrome；本项目只用
 * `playwright install chromium` 装下来的 Chromium。显式写视口与移动标志，少一层外部依赖。
 *
 * ## 测的是生产构建，不是 dev
 *
 * `next dev` 一律按请求渲染，「首页是否静态预渲染」在 dev 下根本无从判断。所以
 * `webServer.command` 先 `next build` 再 `next start`。不给它加「跳过构建」之类的开关：
 * 本地迭代靠先手工起一个 `next start -p 3100` 再让 `reuseExistingServer` 复用，而不是
 * 让配置长出分支。
 */
import { join } from 'node:path';

import { defineConfig, type ReporterDescription } from '@playwright/test';

import {
  BASE_URL,
  MOBILE_DEVICE_SCALE_FACTOR,
  PLAYWRIGHT_ARTIFACTS,
  PORT,
  VIEWPORTS,
} from './e2e/env';

/**
 * CI 上同时给 GitHub 注解（失败直接标在 diff 上）与 HTML 报告（事后翻细节）；
 * 本地只给一行动态输出，失败时再去 `Temp/out/playwright/test-results` 看留档。
 */
const reporter: ReporterDescription[] = process.env.CI
  ? [['github'], ['html', { open: 'never', outputFolder: join(PLAYWRIGHT_ARTIFACTS, 'report') }]]
  : [['list']];

export default defineConfig({
  testDir: './e2e',
  /* 产物落在 Temp/ 下，不在 apps/web 里散落 test-results / playwright-report。 */
  outputDir: join(PLAYWRIGHT_ARTIFACTS, 'test-results'),
  fullyParallel: true,
  /* 留下 `test.only` 会让整批用例静默缩水，CI 上直接判失败。 */
  forbidOnly: Boolean(process.env.CI),
  /* CI 上网络与服务启动都比本机慢，留一次重试；本机留着重试只会掩盖不稳定用例。 */
  retries: process.env.CI ? 1 : 0,
  reporter,
  use: {
    baseURL: BASE_URL,
    /* 只在失败时留档：trace 全量保留会让产物目录迅速膨胀，而绝大多数时候没人看。 */
    trace: 'retain-on-failure',
    /*
     * 端到端里不启用 Service Worker。
     *
     * `public/sw.js` 的 `activate` 会调 `clients.claim()`，而 `components/service-worker-registrar.tsx`
     * 监听到 `controllerchange` 就 `window.location.reload()`。Playwright 每个用例都是全新的
     * 浏览器上下文，对 `/sw.js` 来说永远等于「首次安装」：页面加载完成后，SW 预热完那 6 个
     * 静态文件就接管页面，然后**整页重载一次**。重载时机取决于预热快慢，于是「刚填好的表单
     * 被抹掉、紧接着点在空表单上」这种失败会随机器快慢随机出现——本仓库第一次跑
     * `auth.setup.ts` 正是撞在这里：页面显示「请填写邮箱与密码。」，而服务端日志里那次登录
     * 其实是 200。
     *
     * 拦掉它，用例面对的才是「页面自身的行为」。代价是 SW 的更新提示条不在端到端覆盖范围内，
     * 已记在 `docs/ROADMAP.md` 的未验证清单；把那条链路纳入覆盖要靠一个专门的用例，
     * 而不是让每个用例都去赌一次重载。
     */
    serviceWorkers: 'block',
  },
  projects: [
    {
      /*
       * 只跑夹具：`auth.setup.ts` 造账号并登录一次、`tools.setup.ts` 造出一条他人运行记录，
       * 两者都把结果落盘供后面两个 project 读。按 `\.setup\.ts$` 匹配而不是点名某个文件：
       * 新增夹具时忘改这里，它会**静默地跑进 desktop 与 mobile 两个 project**——夹具是写库的，
       * 并发重入正是它们被放进 setup 的理由（见 `e2e/tools.setup.ts` 文件头）。
       */
      name: 'setup',
      testMatch: /\.setup\.ts$/,
    },
    {
      name: 'desktop',
      use: { viewport: VIEWPORTS.desktop },
      dependencies: ['setup'],
      testIgnore: /\.setup\.ts$/,
    },
    {
      name: 'mobile',
      use: {
        viewport: VIEWPORTS.mobile,
        /*
         * 三件套必须一起给。只把视口改窄得到的是「变窄的桌面」：Tailwind 的
         * `md:`/`lg:` 断点会走到移动分支，但按触控能力或像素比分的支路不会——
         * 而 `docs/PRD.md` 4.1 对触控目标 44px 的承诺正是按触控分的。
         */
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: MOBILE_DEVICE_SCALE_FACTOR,
      },
      dependencies: ['setup'],
      testIgnore: /\.setup\.ts$/,
    },
  ],
  webServer: {
    command: `pnpm exec next build && pnpm exec next start -p ${PORT}`,
    url: BASE_URL,
    /*
     * `BETTER_AUTH_URL` 必须覆盖成被测地址。
     *
     * 仓库根目录 `.env` 里它是 `http://localhost:3000`（`next dev` 用），而这里服务起在
     * `127.0.0.1:3100`。Better Auth 在本项目没有配 `trustedOrigins`，来源校验按 `baseURL`
     * 做，两者不一致时从登录页发出的 POST 会被判成跨站来源而拒绝——表现是「夹具登录失败」，
     * 根因却在配置。
     *
     * 这个赋值能被 `next start` 读到，靠的是 `process.loadEnvFile` 的实测语义：已存在于
     * `process.env` 的变量不会被 `.env` 覆盖（见 `packages/platform/src/env.ts` 文件头第 3 条）。
     * `webServer.env` 又是在 `process.env` 之上合并的（Playwright 1.63.0 的
     * `runner/index.js` 第 872-876 行），所以这里给的值就是最终值。
     *
     * 只覆盖这一项：`DATABASE_URL` 等仍从 `.env` 读取（CI 上没有 `.env`，那几个变量由
     * workflow 的 job 级 env 提供），本地测试连的就是仓库根 `.env` 里那个库。
     */
    env: { BETTER_AUTH_URL: BASE_URL },
    /* CI 上必须自己起：复用上一批遗留的服务等于在测别的代码。 */
    reuseExistingServer: !process.env.CI,
    /* 首次要跑一次完整构建（含类型检查与 Tailwind 扫描），给足五分钟。 */
    timeout: 300_000,
  },
});
