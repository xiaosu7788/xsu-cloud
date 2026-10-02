# CHANGELOG — xsu-cloud

改了什么。按时间倒序追加，一条改动一行到一组条目。

事实归属：范围与验收看 [`PRD.md`](PRD.md)，里程碑划分与退出标准看 [`ROADMAP.md`](ROADMAP.md)，分层与边界看 [`ARCHITECTURE.md`](ARCHITECTURE.md)，表结构看 [`DATA-MODEL.md`](DATA-MODEL.md)，外部系统契约看 [`INTEGRATIONS.md`](INTEGRATIONS.md)。本文件只记「什么时候改了什么」，不重复以上内容。

---

## M1 — 鉴权与设计系统（2026-10-02）

**状态**：交付物全部落盘，提交级检查链、`next build` 与运行时最小验证（真实会话 + 两档真实视口）均已实跑；未验证项见 [`ROADMAP.md`](ROADMAP.md) M1「状态」与第 5 节。

### 新增

- **数据层** `packages/db`：鉴权四表（user / session / account / verification）与邀请码表的 schema、Drizzle 迁移与仓储（`repositories/users.ts`、`repositories/invites.ts`）。
- **领域层** `packages/core`：四条横切规则 —— `access.ts`（分区与角色判定）、`invites.ts`（邀请码可用性）、`accounts.ts`（登录方式与账号关联）、`registration.ts`（注册编排与失败回滚）；各带单元测试，`index.ts` 只导出这四条。
- **基础设施层** `packages/platform`：`env.ts`（服务端配置校验，OAuth 键缺任意一项即视为不提供该提供方）、`auth.ts`（Better Auth 实例：禁用邮箱注册路径、OAuth 不自动关联账号、角色走 `additionalFields`）、`registration.ts`（把领域层端口接到数据库与鉴权实例）、`mail.ts`（控制台邮件传输）。
- **表现层外壳** `apps/web`：根布局与 `globals.css` 设计 token；`(site)` 公共分区、`(console)` 用户控制台、`(admin)` 后台三个分区的布局与权限守卫；`api/auth/[...all]` 薄壳。
- **设计系统**：`components/ui/` 的 `Button`、`Input`、`Label`、`Card`；`theme-provider`、`theme-toggle`、`theme-color-sync`（双主题：跟随系统 + 手动切换 + 持久化，`theme-color` 随主题切换）。
- **响应式原语**：`responsive-nav`、`responsive-table`、`responsive-gallery`、`breakpoints`，形态见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 7.4。
- **PWA**：`manifest.webmanifest`、5 个图标（192 / 512 / maskable 192 / maskable 512 / apple-touch-icon）、`sw.js`、离线提示页 `offline.html`。
- **鉴权前端**：登录表单、会话徽章、账号面板、分区拒绝视图、OAuth 回调错误码翻译。
- **注册准入的界面入口**：`app/(site)/sign-up/`（页面 + Server Action）、`features/auth/sign-up-form.tsx`、`features/auth/sign-up.ts`；路径收口在 `features/auth/routes.ts`。Better Auth 自带的 `/sign-up/email` 已被 `disabledPaths` 关掉，注册只能走这条 Server Action，因此这个页面是交付物①在界面上的唯一落点。
- **`.env.example`**：服务端配置字段清单，不含任何真实值（本机 `.env` 由 `.gitignore` 排除）。**`scripts/generate-pwa-icons.mjs`**：一次性图标生成脚本。

### 依赖版本（M1 从 npm registry 实查后固化）

| 包 | 版本 |
| --- | --- |
| next | 16.3.8 |
| react / react-dom / @types/react / @types/react-dom | 19.3.0 |
| typescript | 5.9.3 |
| better-auth | 1.7.7 |
| zod | 4.6.5 |
| tailwindcss / @tailwindcss/postcss | 4.3.3 |
| class-variance-authority / clsx / tailwind-merge | 0.7.1 / 2.1.1 / 3.7.0 |
| lucide-react | 1.49.0 |
| next-themes | 0.4.6 |
| drizzle-orm / drizzle-kit | 0.45.3 / 0.31.11 |
| pnpm | 11.5.2 |
| vitest | 5.0.2 |

按 M1 授权范围**未安装**：BullMQ、ioredis、`@tanstack/react-query`、`@tanstack/react-table`、recharts —— 留给 M2。`@vitest/coverage-v8` 同样未安装，等 M2 有真实领域代码再接入。

### 修复

- `packages/platform/src/registration.ts`：漏 import `getDb`，`tsc --noEmit` 拦下。
- `apps/web/features/auth/session.ts`：`getAuth()` 会立刻校验服务端配置，原先把 `getAuth(...)` 与 `await headers()` 写成一行，于是构建期先撞上配置校验，本该动态渲染的 `(console)`/`(admin)` 被当作可预渲染页面。改为先 `await headers()`，`next build` 拦下。
- `apps/web/components/ui/button.tsx`：`icon` 尺寸的注释与实际不符（它在小屏同样是 44px），已改正。
- `apps/web/next-env.d.ts`：Next 生成物，import 硬编码双引号且本机（Windows）写 CRLF，与 `prettier.config.mjs` 的 `singleQuote` 冲突，手工格式化一次下次构建就被改回去。已排除出 Prettier（`.prettierignore`），否则 `format:check` 会反复打红。
- 5 个源文件按 Prettier 重排（`app/(admin)/admin/page.tsx`、`app/(admin)/layout.tsx`、`app/(site)/page.tsx`、`app/(site)/sign-in/page.tsx`、`features/auth/session.ts`）：纯折行与尾逗号，渲染文本与类型均无变化。
- `packages/platform/src/env.ts`：`.env` 定位原以 `import.meta.url` 推算仓库根，被 Turbopack 改写后实测解析到错误目录，开发态读不到 `.env`，表现为服务端配置校验直接抛错。改为从 `process.cwd()` 向上查找 `pnpm-workspace.yaml`。
- `apps/web/postcss.config.mjs`：同一类缺陷，后果更隐蔽。`import.meta.url` 被改写后解析成 `D:\Project\xsu-cloud\apps\apps\web`（多一层 `apps`），Tailwind 的 `base` 指向不存在的目录、扫到 0 个候选类 —— **全站工具类一个都没生成**，而 `tsc`、ESLint、Prettier、`next build`、`next dev` 退出码全为 0，静态检查链完全看不见。改为向上查找工作区标记，并加 `existsSync(next.config.ts)` 兜底。
- 触摸目标不足 44px（`docs/PRD.md` 4.1）：`components/site-nav.tsx` 的品牌链接命中区 66×20、`app/(console)/layout.tsx` 与 `app/(admin)/layout.tsx` 的品牌位 66×18，均改为 `h-11`/`min-h-11` 撑满 44px。

### 移除

- 7 个 `.gitkeep`（`apps/web/app/(site|console|admin)`、`app/api`、`components`、`features`、`scripts`）：对应目录都有真实文件了。

## M0 — 地基与文档（2026-09-30）

- pnpm workspace 骨架与约定目录、`packages/config` 共享配置、分层铁律 ESLint（含故意的失败用例）、提交级检查链与 CI、本地 Postgres + Redis 的 Compose、文档体系。commit `c671ecb`。

## 怎么验证

- **版本表**：以各 `package.json` 与 `pnpm-lock.yaml` 为准。本表的数字是从 npm registry 实查后抄写的；升级依赖时必须连同本文件一起改，否则视为漏记。
- **条目与里程碑一致**：「新增 / 修复 / 移除」应能对应到 [`ROADMAP.md`](ROADMAP.md) 对应里程碑的交付物；不一致时以源码与构建产物为准，先改本文件。
- **没有可跑的校验脚本**：本文件不参与 Prettier 检查（`.prettierignore` 排除 Markdown），格式靠人工维持。

## 已知债务

- **M0 与 M1 的条目是里程碑收尾时一次性补写的**，不是逐 PR 增量记录 —— 这两段的时间线因此不可信，只能当作「包含哪些内容」的索引。M2 起应按 PR 追加。
- 本文件不记录被否决的方案与理由，那属于 `docs/ADR/`（尚未建立，见 [`ROADMAP.md`](ROADMAP.md) 第 5 节）。
- M1 段落里的「状态」与 [`ROADMAP.md`](ROADMAP.md) 存在同一事实的两处表述，属待清理的重复；目前以 `ROADMAP.md` 为准。
