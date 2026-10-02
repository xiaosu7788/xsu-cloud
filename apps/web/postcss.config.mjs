/**
 * PostCSS 配置：只接 Tailwind 4。
 *
 * ## 为什么必须显式写 `base`
 *
 * Tailwind 4 取消了 `tailwind.config.js` 的 `content` 数组，改成自动探测源文件，
 * 探测起点由 PostCSS 插件的 `base` 选项决定，**默认值是 `process.cwd()`**。
 * `cwd` 取决于从哪里启动进程：从仓库根执行 `pnpm --filter @xsu/web dev` 时是仓库根，
 * `cd apps/web && pnpm dev` 时是 `apps/web`。两者探测到的类名集合不同，
 * 表现是「在某一台机器上样式偶尔少几段」——这类问题排查成本极高。
 *
 * 这里把基准钉死在 `apps/web`，与启动方式无关。样式入口 `app/globals.css` 是站点
 * 自己的文件，`components/`、`features/`、`app/` 都在这个基准之下，因此自动探测的
 * 覆盖范围正好是表现层，不会扫进 `packages/` 与 `Temp/`。
 *
 * ## 为什么不能用 `import.meta.url` 定位（M1 运行时验证实测）
 *
 * 最初的实现是 `dirname(fileURLToPath(import.meta.url))`，**实测解析成
 * `D:\Project\xsu-cloud\apps\apps\web`，多出一层 `apps`**：Turbopack 把
 * `import.meta.url` 当静态资源引用改写，拼的是「turbopack 根（`pnpm-workspace.yaml`
 * 所在的仓库根）+ 相对该根的项目路径」，而项目根本身已经是 `apps/web`，于是重复一层。
 *
 * 后果极其隐蔽：`base` 指向不存在的目录，Tailwind 扫到 0 个候选类，产物里只剩
 * `:root`、`.dark` 与 base 层，**全站工具类一个都没生成**；而 `tsc`、`eslint`、
 * `next build`、`next dev` 的退出码全是 0，静态检查链完全发现不了。
 *
 * 因此改为从 `process.cwd()` 向上找 `pnpm-workspace.yaml` 定位仓库根，再拼
 * `apps/web`——与 `packages/platform/src/env.ts` 同一套做法，不依赖被改写的
 * `import.meta.url`。兜底两条：找到的目录必须含 `next.config.ts`，否则退回
 * `process.cwd()`。宁可多扫（多出几条无用规则），不能少扫（少扫就是全站样式失效）。
 *
 * 事实依据：`@tailwindcss/postcss@4.3.3` 的 `dist/index.d.ts` 里 `base` 的注释
 * 「The base directory to scan for class candidates. Defaults to the current working directory.」
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/** 从 start 向上找带工作区标记的目录；到文件系统根仍未命中则返回 null。 */
function findWorkspaceRoot(start) {
  let current = resolve(start);
  let parent = dirname(current);
  while (parent !== current) {
    if (existsSync(join(current, WORKSPACE_MARKER))) return current;
    current = parent;
    parent = dirname(current);
  }
  return existsSync(join(current, WORKSPACE_MARKER)) ? current : null;
}

/** 应用目录必须同时具备工作区标记与 Next 配置，缺一即视为解析失败。 */
function resolveBase() {
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  if (workspaceRoot) {
    const appDir = join(workspaceRoot, 'apps', 'web');
    if (existsSync(join(appDir, 'next.config.ts'))) return appDir;
  }
  return process.cwd();
}

const base = resolveBase();

export default {
  plugins: {
    '@tailwindcss/postcss': { base },
  },
};
