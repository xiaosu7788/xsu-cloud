# CHANGELOG — xsu-cloud

改了什么。按时间倒序追加，一条改动一行到一组条目。

事实归属：范围与验收看 [`PRD.md`](PRD.md)，里程碑划分与退出标准看 [`ROADMAP.md`](ROADMAP.md)，分层与边界看 [`ARCHITECTURE.md`](ARCHITECTURE.md)，表结构看 [`DATA-MODEL.md`](DATA-MODEL.md)，外部系统契约看 [`INTEGRATIONS.md`](INTEGRATIONS.md)。本文件只记「什么时候改了什么」，不重复以上内容。

---
 
 ---
 
## 设计系统基线对齐 DoulorCloud（2026-10-05，M5 之后）

**状态**：外壳层与页面层全部落盘；提交级检查链、生产构建与端到端回归（双视口）均已实跑。基线口径、三处刻意偏离的对比度实算与已知债务见 [`DESIGN.md`](DESIGN.md)。

### 新增

- **设计基线** `apps/web/app/globals.css`：自托管可变字体 Outfit（`public/fonts/outfit-var.woff2`，32 KB，`unicode-range` 仅拉丁、中文回退系统栈）、`--font-app` 单一字体来源、`@utility glass-panel / glass-sidebar / glass-card`（透明度由 `color-mix` 从 `--card` 派生，`.dark` 档补 inset 高光描边）、`page-enter` / `data-fade` 关键帧、`cursor-glow`、云纹 `body::before` 底纹、`prefers-reduced-motion` 统一收口。
- **共享组件** `apps/web/components/`：`page-header`、`empty-state`、`page-enter`、`data-fade`、`cursor-effect`、`ui/badge`、`ui/skeleton` 共 7 个（移植自参考实现，写法改为本站风格）。
- **文档** [`DESIGN.md`](DESIGN.md) 建立并登记进 [`AGENTS.md`](AGENTS.md) 文档表（A 级）与 [`README.md`](README.md) 清单。

### 行为变化

- **全站标题层级统一**：19 个页面的手写 `<h1>` 标题区改为 `PageHeader`（标题 + 说明 + 右侧操作），移动端标题由 `text-xl` 变为 `text-2xl`。`/` 与 `/tools` 的 hero 标题、帖子详情的标题（带作者与时间行）**保持原样**，不走组件。
- **`PageHeader` 不自带外边距**：参考实现是 `mb-8`，与本站页面容器的 `gap-6` 叠加会变成 56px，导致「用了组件的页面」与「没用组件的页面」间距不一致。
- **`PageHeader` 的 `description` 收 `ReactNode`**（`title` 仍收 `string`）：说明文字里嵌链接的页面（控制台「我的帖子」、编辑帖、公开社区索引）不必在「丢链接」与「不用组件」之间二选一。
- **空态统一为 `EmptyState`**：公开社区索引、标签页、搜索页与控制台「我的帖子」的四处一行文案改为「标题 + 说明 + 下一步入口」。搜索页的 `没有找到相关帖子。` 文案逐字保留（e2e 精确断言）。

### 修复

- **后台入口对管理员不可见**（`(console)/layout.tsx`）：`ADMIN_HOME` 此前只在 `(admin)` 分区内被引用，管理员登录后落在控制台却看不到任何通往后台的入口。改为按角色装配控制台导航项。

### 已知债务

- `badge` / `skeleton` / `data-fade` 三个组件**已移植但未接线**（`badge` 与既有的 `adminStatusBadge` 是两套状态样式，接线前须先统一）。全文见 [`DESIGN.md`](DESIGN.md) 第 9 节。

---

 ## M5 — 后台管理（2026-10-05）
 
 **状态**：六项交付物全部落盘；提交级检查链、生产构建与端到端回归（双视口）均已实跑。四条退出标准的证据见 [`ROADMAP.md`](ROADMAP.md) M5「状态」，领域规则与防自锁见 [`spec/SPEC-admin.md`](spec/SPEC-admin.md)，表结构见 [`DATA-MODEL.md`](DATA-MODEL.md) 3.13 与 3.12。
 
 ### 新增
 
 - **数据层** `packages/db`：`site_config` 单行表（CHECK `id = 1`、三项每小时配额 nullable、`updated_by` SET NULL，`schema/admin.ts`）与迁移 `0003_admin_tables.sql`——`user` 加 `banned_at` / `ban_reason`，`audit_logs.target_type` 的 CHECK 扩为 `('post','comment','user','site_config')`（DROP + ADD 为 drizzle 生成后手工核对）；仓储 `repositories/admin.ts`（条件 UPDATE 回读区分失败码、业务变更与审计同事务、单行 upsert）。
 - **领域层** `packages/core/src/admin/`：`users`（改角色 / 封禁 / 解封，`selfRoleChange` / `selfBan` / `lastAdmin` 防自锁，幂等返回 `changed:false` 不写审计）、`content`（帖子与评论下架 / 恢复，恢复评论要求父帖存活）、`config`（配额覆盖校验 0..1000000 + upsert 同事务审计）、`overview` / `tasks`（只读统计）、`rules` / `types`（`ADMIN_FAILURE` 失败码表与 `AUDIT_ACTION` 扩展）。
 - **平台层** `packages/platform`：`quota.ts`（`resolveQuotaOverrides`：`site_config` 覆盖 > env 默认 > core 常量）、`admin.ts`（`AdminGateway`）、`auth.ts` 挂 `databaseHooks.session.create.before` 对封禁现查——不开 cookieCache，角色与封禁每请求见库；`community.ts` / `tools.ts` 的端口工厂改异步并在装配点读覆盖。
 - **表现层** `apps/web`：`/admin` 概览、`/admin/users`、`/admin/content`、`/admin/tasks`、`/admin/config`、`/admin/audit` 六页（全部动态渲染）；Server Action 返回 void + `?ok=` 白名单 / `?error=` 键横幅；`features/admin/` 的导航、审计动作标签与视图层。
 - **端到端** `apps/web/e2e/`：`admin-m5.spec.ts`（封禁 → 会话即断 → 解封需重登、自锁行、内容下架恢复含公开侧「内容不可见」、配置三态往返 + 审计行断言）、`admin-access.spec.ts` 的 `GUARDED_PATHS` 扩到 9 条、`ADMIN_PATHS` 扩到 7 条。
 - **文档** [`DATA-MODEL.md`](DATA-MODEL.md) 新增 3.13（`site_config`）并增补 3.1 / 3.12；[`spec/SPEC-admin.md`](spec/SPEC-admin.md) 建立；[`TESTING.md`](TESTING.md) 回填 M5 用例数。
 
 ### 行为变化
 
 - **三项每小时配额的生效优先级改为「`site_config` 覆盖 > env 默认 > core 常量」**：`createCommunityPorts` / `createToolPorts` 变为异步；0 = 管理员显式关闭，null = 不覆盖回落 env——两者语义分开。
 - **封禁即时生效**：登录被 `session.create.before` 拒绝，既有会话在封禁事务内删除；解封后必须重新登录。
 
 ### 修复
 
 - **点赞挂载同步丢计数（M3 遗留）**：`like-button.tsx` 的批量点赞响应里已解析出的计数被旧 hook 丢弃，详情页 ISR 15 秒窗口内的 reload 首帧显示 0。改为 `useSyncLikes` 同时回写 `count` 与 `liked`，响应缺条目时保留原值（`?? prev.count`）。由双视口端到端回归暴露，修复后社区点赞流在两视口均通过。
 
 ### 已知债务（M5 新增，全文见 SPEC-admin「已知债务」）
 
 - `audit_logs` 的 target 无外键（多态），删除 user 会级联掉以其为 target 的审计行——与 M3 同一取舍。
 - 配额覆盖在网关装配点现读 DB，不在请求热路径；成本看板占位于 `/admin/tasks`，等 M4/M6 数据源回填。
 - 任务重试 / 取消不在本轮（M6 任务语义），`/admin/tasks` 只读统计。
 
 ---
 
 ## M3 — 社区（2026-10-04）

**状态**：交付物全部落盘；提交级检查链、生产构建与端到端回归（双视口）均已实跑。四条退出标准的证据见 [`ROADMAP.md`](ROADMAP.md) M3「状态」，验证方法与用例数见 [`TESTING.md`](TESTING.md)，表结构与触发器见 [`DATA-MODEL.md`](DATA-MODEL.md) 3.8–3.12。

### 新增

- **数据层** `packages/db`：`posts` / `comments` / `reactions` / `reports` / `audit_logs` 五张表（`schema/community.ts` + 迁移 `0002_community_tables.sql`）与仓储 `repositories/community.ts`（`(created_at,id)` 游标分页、软删除、`(post_id,user_id)` 复合主键 `ON CONFLICT` 幂等点赞、部分唯一索引幂等举报、管理员处置与审计写入同事务）。`audit_logs` 的追加只读触发器（行级 + 语句级，挡 `UPDATE` / `DELETE` / `TRUNCATE`）是 drizzle-kit 表达不了的手写 SQL，本机已实测全部拒绝。
- **领域层** `packages/core/src/community/`：`posts`（发帖「校验 → 配额 → 写入」编排）、`comments`（评论配额与软删）、`reactions`（幂等点赞 + 计数缓存失效）、`reports`（举报不改内容状态；`confirmTakedown` 把下架、举报置终态、写审计锁进同一事务）、`rules`（标签/查询归一化、长度与配额常量）、`types`（失败码表）。
- **平台层** `packages/platform`：`community.ts`（`CommunityGateway`：领域端口 + 页面读取；`generateStaticParams` 用的 `listRecentPostIds` / `listFeedTags`，`STATIC_PARAMS_POST_LIMIT = 20`）、`cache.ts`（点赞计数缓存：键 `community:post:{id}:likes`、TTL 60 秒、回填只在键存在时写、所有失败 best-effort）。
- **表现层** `apps/web`：`/community`（ISR 30s）、`/community/[id]`（ISR 15s，`generateStaticParams` 预渲染最近 20 帖，新帖走 `dynamicRoutes` 按需生成）、`/community/tags/[tag]`（ISR 30s，预渲染已知标签）、`/community/search`（动态，随查询变化）、`/console/community` 与编辑页、`/admin/reports`（管理员确认下架 / 驳回）；点赞 / 批量计数 / 举报三个 API 路由；`features/community/` 的发帖、评论、乐观点赞、游标加载组件。
- **端到端** `apps/web/e2e/`：`community.spec.ts`（真翻页、双上下文并发点赞、软删从列表与搜索消失、举报 → 管理员确认下架、360px 无横向滚动）、`admin.setup.ts` + `admin-seed.ts`（真实注册编排造管理员；第二轮回归修为「存在即复用」——管理员是 `audit_logs` 的 actor，删号会级联删审计行、被触发器拦截，套件跨运行不幂等，见下方已知债务）。
- **运维脚本** `scripts/grant-admin.ts`（首个管理员的提权入口，复用 `@xsu/core` 角色常量，不写 `audit_logs`）与 `scripts/verify-reaction-cache.ts`（Redis 计数缓存手工回归；「提交级测试不起 Redis」的纪律见 [`TESTING.md`](TESTING.md) 第 5 节）。
- **修复** `packages/db/src/client.ts` 在模块加载时自举加载仓库根 `.env`（`process.loadEnvFile`，不覆盖已有变量）——修复脚本与端到端在未注入环境变量时 `next build` 必败于缺 `DATABASE_URL` 的问题；修复不改任何包的依赖方向。
- **文档** [`DATA-MODEL.md`](DATA-MODEL.md) 新增 3.8–3.12（五表、触发器、索引与「必须一起看的规则」）；[`TESTING.md`](TESTING.md) 回填 M3 用例数与覆盖率；[`docs/spec/SPEC-community.md`](spec/SPEC-community.md) 建立。

### 行为变化

- **点赞计数读 Redis 缓存，最多落后 60 秒。** 这是「读多写少不进数据库」的第一处落地：写路径（点赞 / 取消）实时失效键，读路径回填。「缓存只负责快、不负责正确」的语义与手工回归见 [`spec/SPEC-community.md`](spec/SPEC-community.md) 第 5、9 节。
- **删除帖子和评论是软删除**（`deleted_at` 置时间戳）：行保留，列表、搜索与详情同时不可见，可见性统一走 `deleted_at is null` 谓词；审核线索不随内容消失。

### 已知债务（M3 新增，全文见 SPEC-community「已知债务」）

- 搜索是 `ILIKE` 顺序扫描，没装 `pg_trgm`；M3 量级够用，内容量上来后单独评估。
- `audit_logs` 的 actor 级联（`ON DELETE CASCADE`）与追加只读触发器在「删除带审计行的管理员账号」这一点上互相冲突——级联产生的审计行 DELETE 会被触发器拒绝、进而拒绝整条删号语句。M3 没有删除账号的用户路径，暂时只是理论冲突；真要支持注销时需把该外键改为 `SET NULL` 或提供受控的审计归档路径。

---

## M2 — 工具箱与 worker 基础设施（2026-10-03）

**状态**：交付物全部落盘；提交级检查链、生产构建、端到端回归（双视口）与 k6 容量实测都已实跑。三条退出标准的证据见 [`ROADMAP.md`](ROADMAP.md) M2「状态」，容量真实数字见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 第 8 节，验证方法与手工回归步骤见 [`TESTING.md`](TESTING.md)。

### 新增

- **数据层** `packages/db`：`tool_runs` / `tool_favorites` 两张表（schema + 迁移 `0001_tools_tables.sql`）与仓储 `repositories/tools.ts`（配额窗口计数、写入、分页列表、单条读取、收藏增删、按保留期删运行历史、删过期会话）。
- **领域层** `packages/core/src/tools/`：`registry.ts`（代码内工具目录，模块加载即拒绝重复 slug）、`builtin.ts`（`json-format` / `text-stats` / `base64` / `hash` 四支纯函数，后两支标记 `sensitive`）、`run-tool.ts`（`runTool` 主流程「查目录 → 校验 → 配额 → 执行 → 落历史」、`TOOL_FAILURE` 错误码表、`buildRunSummary` 摘要截断与脱敏、`decideToolRunAccess` 归属判定）、`types.ts`。
- **平台层** `packages/platform`：`queue.ts`（BullMQ：生产者快速失败与消费者不断连的连接策略、任务名常量、可脱离 Redis 单测的 `dispatchJob`、每天 04:00 UTC 的清理调度、`createQueuedMailTransport`）、`maintenance.ts`（`cleanupCutoffs` 纯函数 + `runMaintenanceCleanup`）、`tools.ts`（把领域层端口接到数据层）；`env.ts` 新增 `REDIS_URL` / `TOOL_RUN_QUOTA_PER_HOUR` / `TOOL_RUN_RETENTION_DAYS`。
- **worker 基础设施首次落地** `apps/web/worker/`：`index.ts`（独立进程入口，`pnpm --filter @xsu/web worker`；同镜像不同 command，不监听端口；SIGTERM / SIGINT 优雅收尾，未捕获异常退出码 1）、`handlers.ts`（`mail.send` 与 `maintenance.cleanup` 的实现）。
- **表现层** `apps/web`：`/tools`（公共分区，预渲染）与 `/console/tools`、`/console/tools/[slug]`、`/console/tools/runs`、`/console/tools/runs/[id]`（控制台分区，动态）；`features/tools/` 的 `routes.ts` / `form-fields.ts` / `format.ts` / `run-form.tsx` / `run-state.ts`；`components/ui/select.tsx` 与 `textarea.tsx`。
- **端到端** `apps/web/e2e/`：`tools-seed.ts`（走真实注册编排造出「他人」账号及其运行记录）、`tools.setup.ts`、`tools.spec.ts`；`env.ts` 增 `OTHER_USER` 与 `FOREIGN_TOOL_RUN_FILE`。
- **运维脚本** `scripts/enqueue-manual-jobs.ts`：手工入队一条邮件任务与一条清理任务，配合 worker 做队列手工回归（步骤见 [`TESTING.md`](TESTING.md) 第 5 节）；根 `tsconfig.json` 的 `include` 加上 `scripts/**/*.ts`，让脚本进 `tsc --noEmit`。
- **文档** [`TESTING.md`](TESTING.md) 建立：提交级 / PR 级 / 周期级 / 里程碑级各验什么、外部集成的测试形态、队列与清理任务的手工回归步骤。

### 依赖版本（从 npm registry 实查后固化）

| 包 | 版本 |
| --- | --- |
| bullmq | 6.3.11 |
| ioredis | 6.0.0 |
| @vitest/coverage-v8 | 5.0.2 |
| tsx | 4.23.15 |
| @tanstack/react-query | 5.104.1 |
| @tanstack/react-table | 9.2.4 |

`bullmq` / `ioredis` 装在 `packages/platform`；`tsx` 是 `apps/web` 的 devDependency（worker 与脚本的运行时）；`@vitest/coverage-v8` 在仓库根。**最后两项零引用，见「已知债务」。**

### 行为变化

- **注册验证邮件从「请求内同步发」改为「入队后由 worker 发」。** 代价是注册成功不再等于邮件已发出；发送失败进队列重试（attempts 3 + 指数退避 5s）。契约见 [`INTEGRATIONS.md`](INTEGRATIONS.md) 第 4 节。
- **过期会话与超期的运行历史开始被删除**：`maintenance.cleanup` 每天 04:00（UTC）跑一次，两条删除各自独立、幂等（[`DATA-MODEL.md`](DATA-MODEL.md) 3.6）。
- **`vitest.config.ts` 启用 `packages/core` 分支覆盖率门槛 80%**，配套接入 `@vitest/coverage-v8`；实测分支覆盖率 98%。
- **CI 的 `e2e` job 多了一个 Redis service**：端到端夹具走真实注册编排，注册链路现在依赖队列。

### 修复

- `docs/TESTING.md` 的队列手工回归原引用 `Temp/` 下的草稿脚本 —— Temp 不入库，别人照做必然找不到文件。改为仓库内的 `scripts/enqueue-manual-jobs.ts`。
- `apps/web/playwright.config.ts`：setup project 原来点名 `/auth\.setup\.ts/`。新增 `tools.setup.ts` 后若不改，它会**静默地跑进 desktop 与 mobile 两个 project** —— 夹具是写库的，并发重入会互相删掉对方刚造的记录，用例于是以「这条 id 不存在」的方式假通过。改按 `/\.setup\.ts$/` 匹配，并把这条理由写进配置。
- **CI 上的端到端夹具读不到 `BETTER_AUTH_URL`，`e2e` job 从加进来那一刻起就是红的。** 该值原先只在 `apps/web/playwright.config.ts` 的 `webServer.env` 里给，而 `setup` 夹具（走真实注册编排，需先构造 Better Auth 实例）跑在 **Playwright 自己的进程**里：仓库根没有 `.env`（CI 正是如此）时它拿不到值，夹具在开工前就被服务端配置校验拦下。改为在 `apps/web/e2e/env.ts` 里按 `PLAYWRIGHT_BROWSERS_PATH` 的同一套办法补上（已显式设过则不覆盖），`webServer.env` 保留。**本地一直没暴露**，因为根 `.env` 里有这一项。

## M1 补课 — PR 级端到端回归（2026-10-03）

**状态**：M1 的三条退出标准从「一次性手工实测」升级为可重跑的 Playwright 回归。本机 `pnpm --filter @xsu/web test:e2e` 实跑 32 passed / 5 skipped / 0 failed（跳过项均带显式理由）；CI 新增 `e2e` job。覆盖范围与不覆盖的部分见 [`ROADMAP.md`](ROADMAP.md) M1「状态」与第 5 节。

### 新增

- **端到端资产** `apps/web/e2e/`：`env.ts`（环境基线，含浏览器二进制缓存目录的设定时机）、`seed.ts`（走真实注册编排造出非管理员账号）、`auth.setup.ts`（通过登录页真实登录一次并落盘会话状态）、`public-pages.spec.ts`（双视口导航、360px 无横向滚动、触控目标、axe、主题持久化）、`static-render.spec.ts`（预渲染清单与运行期响应头两处对账）、`admin-access.spec.ts`（统一拒绝响应）。
- **`apps/web/playwright.config.ts`**：desktop 1280×800 与 mobile 360×800 两个 project（`isMobile` + `hasTouch` + `deviceScaleFactor` 三件套一起给），`setup` project 作为两者依赖；`webServer` 先 `next build` 再 `next start -p 3100`，只覆盖 `BETTER_AUTH_URL`；产物落在 `Temp/out/playwright`。
- **`apps/web` 的 `test:e2e` 脚本**；**CI 的 `e2e` job**（Postgres service + `pnpm --filter @xsu/db db:migrate` + 浏览器缓存 + `playwright install --with-deps chromium`）；**`AGENTS.md`** 第 2 节新增 `apps/web/e2e` 目录约定、第 7 节 PR 级补上可执行命令。

### 依赖版本（从 npm registry 实查后固化）

| 包 | 版本 |
| --- | --- |
| @playwright/test | 1.63.0 |
| @axe-core/playwright | 4.13.0 |

两者都是 devDependency，不进生产运行时；M7 的 Dockerfile 仍守「builder 装全量、运行镜像只留生产依赖 + `.next` 产物」。浏览器二进制装在仓库内 `Temp/cache/ms-playwright`（已被 `.gitignore` 忽略），不写用户级缓存目录。

### 修复

- `apps/web/e2e/public-pages.spec.ts`：首页用例里的「登录」入口在顶栏（`SessionBadge`）与正文各有一个，`getByRole('link')` 在严格模式下匹配到 2 个元素直接失败；判据改为从 `main` 出发。
- `apps/web/e2e/static-render.spec.ts`：`x-nextjs-prerender` 这个头 Next 会写两遍，Playwright 把取值拼成 `1, 1`，原断言拿整串比 `'1'` 于是一直红。新增 `headerValues()`（按 `,` 拆开去重），正反两侧（预渲染标记应存在 / 不应存在）改用同一把尺。

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

- **M0、M1 与 M2 的条目都是里程碑收尾时一次性补写的**，不是逐 PR 增量记录 —— 这三段的时间线因此不可信，只能当作「包含哪些内容」的索引。「M2 起应按 PR 追加」这句承诺到 M2 仍未兑现。
- 本文件不记录被否决的方案与理由，那属于 `docs/ADR/`（尚未建立，见 [`ROADMAP.md`](ROADMAP.md) 第 5 节）。
- M1 段落里的「状态」与 [`ROADMAP.md`](ROADMAP.md) 存在同一事实的两处表述，属待清理的重复；目前以 `ROADMAP.md` 为准。
- **`@tanstack/react-query` 与 `@tanstack/react-table` 已安装但零引用。** 两者在 [`../AGENTS.md`](../AGENTS.md) 第 5 节的技术栈里，M1 的条目把引入点写成「留给 M2」，于是 M2 装了。**装了不用是负担**：会进生产镜像、会随版本漂移、会让人以为已经在用。要么在 M3 后台管理里真正用上，要么在 M3 开工前卸掉，不允许一直挂着。
- **`recharts` 是上一条的反例。** M1 的条目同样把它「留给 M2」，M2 判断它的真实用途是后台看板（M5），于是**没有**安装 —— 技术栈表里的包不等于每个里程碑都要装。这一条留在这里是为了防止有人照着 M1 的清单把它补装进来。
