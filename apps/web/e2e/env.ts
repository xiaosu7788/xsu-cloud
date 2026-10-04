/**
 * 端到端测试的环境基线。**必须是 `playwright.config.ts` 的第一条 import。**
 *
 * ## 为什么浏览器二进制缓存要由这里设定，而且必须排在最前面
 *
 * `playwright-core` 在**模块初始化**时就把 `PLAYWRIGHT_BROWSERS_PATH` 读进注册表
 * （`lib/coreBundle.js` 里一个立即执行的 IIFE，Playwright 1.63.0 实测），之后再改环境
 * 变量已经无效。所以赋值必须发生在任何 playwright 代码被 import 之前：写在
 * `playwright.config.ts` 里 `defineConfig` 之前不管用，因为 `import` 会被提升到文件顶部。
 * 拆成这个模块并由配置第一条 import，顺序才是确定的。
 *
 * 目标目录 `Temp/cache/ms-playwright` 在仓库内、已被 `.gitignore` 忽略。二进制四百多兆，
 * 放进用户级缓存（Windows 上是 `%LOCALAPPDATA%\ms-playwright`）等于把本项目的产物写到
 * 工作区之外，还会与别的 Playwright 项目互相干扰——各版本要的是不同 revision。
 *
 * 已经显式设过 `PLAYWRIGHT_BROWSERS_PATH`（CI 的 job 级环境变量就是）时不覆盖：
 * 那个值同时决定 `playwright install` 的落点，测试必须跟着走，否则两边找的不是一个目录。
 *
 * ## 定位仓库根目录的方式
 *
 * 与 `apps/web/postcss.config.mjs`、`packages/platform/src/env.ts` 同一套：从 `process.cwd()`
 * 向上找 `pnpm-workspace.yaml`。不用 `__dirname`／`import.meta.url`——配置与用例可能被
 * 以 CJS 或 ESM 两种形态转译，取当前文件位置的写法在两种形态下不一样。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

function findWorkspaceRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, WORKSPACE_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `找不到仓库根目录：从 ${start} 向上都没有 ${WORKSPACE_MARKER}。` +
          '端到端测试必须在仓库内运行。',
      );
    }
    current = parent;
  }
}

/** 仓库根目录（含 `pnpm-workspace.yaml` 的那一层）。 */
export const REPO_ROOT = findWorkspaceRoot(process.cwd());

/** 浏览器二进制缓存目录。 */
export const BROWSERS_PATH = join(REPO_ROOT, 'Temp', 'cache', 'ms-playwright');

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH;
}

/** `apps/web` 目录，也就是 `playwright.config.ts` 与 `next.config.ts` 所在的那一层。 */
export const APP_DIR = join(REPO_ROOT, 'apps', 'web');

/**
 * `next build` 的产物目录。
 *
 * 静态渲染是**构建期事实**，浏览器里看不出来（预渲染出来的 HTML 与按请求渲染出来的
 * HTML 在页面上长得一样）。因此 `static-render.spec.ts` 除了看响应头，还要对账这里的
 * `prerender-manifest.json`——那是 Next 自己写下的「哪些路由是静态的」清单。
 */
export const NEXT_BUILD_DIR = join(APP_DIR, '.next');

/**
 * 端到端服务用的端口。
 *
 * 不用 3000：`next dev` 默认就占 3000，开发时一边开着 dev 一边跑测试会撞端口，
 * 而 Playwright 的 `reuseExistingServer` 会把 dev 服务当成测试目标——那等于测了
 * 另一套东西（开发渲染与生产渲染不是一回事）。
 */
export const PORT = 3100;

/** 端到端服务地址。用 `127.0.0.1` 而不是 `localhost`：后者在有的机器上先解析到 `::1`。 */
export const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * 被测应用的自身地址。
 *
 * 服务端配置校验要求这一项存在（`packages/platform/src/env.ts` 的 `BETTER_AUTH_URL`），
 * 而它有两个消费者，且分别在两个进程里：被测服务本身，以及 **Playwright 自己的进程**
 * （`setup` 夹具走真实注册编排落库，要先构造 Better Auth 实例）。`playwright.config.ts` 的
 * `webServer.env` 只覆盖前者的进程，后者在仓库根没有 `.env` 时（CI 就是这样）拿不到值，
 * 于是夹具在开工之前就被配置校验拦下——2026-10-03 的 CI 就是这么红的。
 *
 * 所以按 `PLAYWRIGHT_BROWSERS_PATH` 的同一套办法处理：模块被求值时就补上，已经显式设过的
 * 值不覆盖。本模块被 `playwright.config.ts` 放在第一条 import、也被夹具直接 import，
 * 因此两个进程都会走到这里。
 */
if (!process.env.BETTER_AUTH_URL) {
  process.env.BETTER_AUTH_URL = BASE_URL;
}

/**
 * 两档视口。`docs/PRD.md` 4.1 要求 360px 宽不出现横向滚动，`docs/ROADMAP.md` M1
 * 退出标准 2 要求桌面与移动视口下导航都可用，因此两档都必须真跑，不能只跑宽屏。
 */
export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 360, height: 800 },
} as const;

/** 移动视口的设备像素比。取 3 是为了让 360px 这一档接近真机而非桌面缩略。 */
export const MOBILE_DEVICE_SCALE_FACTOR = 3;

/**
 * `docs/PRD.md` 4.1 对触控目标的下限，单位 px。
 *
 * 只对移动壳有承诺：桌面按鼠标密度取 36px（见 `components/ui/button.tsx`）。
 */
export const TOUCH_TARGET_MIN = 44;

/**
 * 端到端专用账号：普通用户（非管理员）。
 *
 * 存在的唯一理由是 M1 退出标准 3——「非管理员访问 `(admin)` 得到统一拒绝响应」，
 * 没有第二个角色就验证不了。由 `e2e/seed.ts` 走真实的注册编排建出来，
 * 由 `e2e/auth.setup.ts` 通过登录页界面登录一次。
 */
export const NON_ADMIN = {
  name: 'e2e 普通用户',
  email: 'e2e-non-admin@example.com',
  password: 'e2e-non-admin-password',
} as const;

/** 端到端专用账号：管理员。社区举报 e2e 用它走真实审核路径。 */
export const ADMIN = {
  name: 'e2e 管理员',
  email: 'e2e-admin@example.com',
  password: 'e2e-admin-password',
} as const;

/**
 * 端到端专用账号：他人。
 *
 * 存在的唯一理由是 M2 的跨用户验收（`docs/PRD.md` 3.3 验收 4「用户只能看到自己的运行历史」）：
 * 「别人的记录打不开」需要库里真的躺着一条别人的记录，否则用例验的是「这个 id 不存在」，
 * 而不是「这条记录不属于你」。由 `e2e/tools-seed.ts` 走真实注册编排建出来，
 * **从不登录**，所以不需要 `emailVerified`（`./seed.ts` 文件头里那条例外在这里不存在）。
 */
export const OTHER_USER = {
  name: 'e2e 他人',
  email: 'e2e-other@example.com',
  password: 'e2e-other-password',
} as const;

/**
 * 端到端产物的落点。
 *
 * 放在 `Temp/out/` 而不是 `apps/web/test-results`：`AGENTS.md` 第 2 节已经把 `Temp/`
 * 定为「临时文件与中间产物」的约定目录，整个 `Temp/` 都在 `.gitignore` 里。跟着约定走，
 * 就不必为每引入一个测试框架都往 `.gitignore` 里补一行，也不会有人把失败截图误提交进去。
 *
 * 里面会有：`test-results/`（Playwright 的失败留档）、`report/`（CI 上的 HTML 报告）、
 * `auth/`（登录夹具落盘的会话状态——它含真实会话 cookie，绝不能入库）。
 */
export const PLAYWRIGHT_ARTIFACTS = join(REPO_ROOT, 'Temp', 'out', 'playwright');

/** 登录后的会话状态落盘位置。由 `e2e/auth.setup.ts` 写入，由需要的用例读入。 */
export const NON_ADMIN_STORAGE = join(PLAYWRIGHT_ARTIFACTS, 'auth', 'non-admin.json');

/** 管理员登录后的会话状态，由 `apps/web/e2e/admin.setup.ts` 写入。 */
export const ADMIN_STORAGE = join(PLAYWRIGHT_ARTIFACTS, 'auth', 'admin.json');

/**
 * 他人运行记录坐标的落盘位置。
 *
 * 由 `e2e/tools.setup.ts` 写入，由 `e2e/tools.spec.ts` 读入。**不能在用例里现造**：
 * desktop / mobile 两个 project 会并发跑同一份用例，两边各自「先删后建」那个他人账号时，
 * 一边刚造出来的记录会被另一边删掉——用例于是会以「这条 id 不存在」的方式通过。
 */
export const FOREIGN_TOOL_RUN_FILE = join(PLAYWRIGHT_ARTIFACTS, 'tools', 'foreign-run.json');
