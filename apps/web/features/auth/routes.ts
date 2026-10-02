/**
 * 分区路由常量。
 *
 * 「导航里出现的每个路径都必须真的有一个页面」是一条没有工具检查的约束，靠人工 review。
 * 路径写成字面量散落在导航、守卫、链接里时，这条 review 基本做不成——没有人会把
 * `href="/sigin"` 和 `app/(site)/sign-in/page.tsx` 对照起来看。全部路径收在这里之后，
 * 改路由只需要改一处，而「谁在用这个路径」一次搜索就能看清。
 *
 * 与 `app/` 下的目录一一对应（见 `AGENTS.md` 第 2 节的分区约定）：
 *
 * | 常量 | 目录 | 所在分区 |
 * | --- | --- | --- |
 * | `SITE_HOME` | `app/(site)/page.tsx` | `(site)` |
 * | `SIGN_IN_PATH` | `app/(site)/sign-in/page.tsx` | `(site)` |
 * | `SIGN_UP_PATH` | `app/(site)/sign-up/page.tsx` | `(site)` |
 * | `CONSOLE_HOME` | `app/(console)/console/page.tsx` | `(console)` |
 * | `CONSOLE_SETTINGS` | `app/(console)/console/settings/page.tsx` | `(console)` |
 * | `ADMIN_HOME` | `app/(admin)/admin/page.tsx` | `(admin)` |
 *
 * 为什么 `(console)` 与 `(admin)` 下面还有一层同名目录：路由组括号里的名字不进 URL，
 * 两个分区的 `page.tsx` 都直接放在组根上会同时占用 `/`，那是一个构建期错误。
 * 所以组内再落一层真实的路径段，`/console` 与 `/admin` 各自有前缀。
 *
 * 本文件只放常量，不放逻辑，也不 import 任何东西——它会被服务端组件、客户端组件和
 * Server Action 一起引用。
 */

/** 公开站点首页。 */
export const SITE_HOME = '/';

/** 登录页。守卫在会话失效时重定向到这里。 */
export const SIGN_IN_PATH = '/sign-in';

/** 注册页。全站唯一的注册入口——Better Auth 自带的 `/sign-up/email` 已被关掉。 */
export const SIGN_UP_PATH = '/sign-up';

/** 用户控制台首页。 */
export const CONSOLE_HOME = '/console';

/** 控制台里的账号设置页。移动端顶栏放不下退出登录，这条路由是移动端的主要出口。 */
export const CONSOLE_SETTINGS = '/console/settings';

/** 后台管理首页。只有 `admin` 角色可达。 */
export const ADMIN_HOME = '/admin';
