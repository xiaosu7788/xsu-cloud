/**
 * 工具箱路由常量。
 *
 * 与 `features/auth/routes.ts` 同一条约定：路径只写一处，本文件**只放常量，不 import 任何东西**
 * ——它会被服务端组件、客户端组件与 Server Action 一起引用。分成两个文件而不是并进
 * `features/auth/routes.ts`，是因为「导航里出现的每个路径都必须真的有一个页面」这条约束
 * 靠人工 review：把工具箱的路径混进 auth 那份清单，核对时得先在心里把两个模块拆开。
 *
 * 与 `app/` 下的目录一一对应（`docs/spec/SPEC-tools.md` 第 6 节）：
 *
 * | 常量 | 目录 | 所在分区 |
 * | --- | --- | --- |
 * | `TOOLS_HOME` | `app/(site)/tools/page.tsx` | `(site)` |
 * | `CONSOLE_TOOLS` | `app/(console)/console/tools/page.tsx` | `(console)` |
 * | `CONSOLE_TOOLS_RUNS` | `app/(console)/console/tools/runs/page.tsx` | `(console)` |
 *
 * 两个带参数的页面没有对应的常量，只能由下面两个函数拼——`[slug]` 与 `runs/[id]` 的值是
 * 运行期才知道的。把拼接收在这里，页面里就不会出现手写的模板字符串。
 */

/** 公开的工具清单页。静态预渲染，不含执行入口（`docs/spec/SPEC-tools.md` 第 6 节）。 */
export const TOOLS_HOME = '/tools';

/** 工具台：清单 + 收藏开关 + 进入执行页的入口。 */
export const CONSOLE_TOOLS = '/console/tools';

/** 我的运行历史。 */
export const CONSOLE_TOOLS_RUNS = '/console/tools/runs';

/**
 * 某个工具的执行页。
 *
 * `slug` 必须是注册表里的值（调用方先过 `findTool`）。拼一个不存在的 slug 得到的是 404，
 * 不是「工具不存在」的错误页——见 `components/` 之外的页面实现。
 */
export function consoleToolPath(slug: string): string {
  return `${CONSOLE_TOOLS}/${slug}`;
}

/**
 * 单条运行记录。
 *
 * 注意 `runs` 与 `[slug]` 在同一层级：Next 的路由匹配里**静态段优先于动态段**，
 * 所以 `/console/tools/runs` 不会被解释成一个 slug 为 `runs` 的工具。
 * 这条优先级是「加工具时不要取名叫 runs」的隐含约束，在此写明。
 */
export function consoleToolRunPath(id: string): string {
  return `${CONSOLE_TOOLS_RUNS}/${id}`;
}
