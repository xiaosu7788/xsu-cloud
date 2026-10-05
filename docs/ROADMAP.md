# ROADMAP — xsu-cloud

里程碑顺序与退出标准。范围与验收标准见 [`PRD.md`](PRD.md)，分层与边界见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

---

## 1. 总览

| 里程碑 | 名称 | 一句话目标 | 依赖 |
| --- | --- | --- | --- |
| M0 | 地基与文档 | 仓库、分层骨架、CI、文档体系就位 | — |
| M1 | 鉴权与设计系统 | 能登录、能切换主题、桌面与移动两套壳可用 | M0 |
| M2 | 工具箱 | 用最小业务量跑通整条工程链 | M1 |
| M3 | 社区 | 内容模型、分页、缓存、审核 | M2 |
| M4 | 集成层与中转站 | 适配器模式定型，接入外部数据源 | M3 |
| M5 | 后台管理 | 用户、内容、任务、配置、审计 | M4 |
| M6 | 生图工作台 | 队列、轮询、结果转存、画廊 | M5 |
| M7 | 加固与上线 | 压测、备份恢复演练、回滚、开放 | M6 |

## 2. 为什么是这个顺序

- **M2 是工具箱而不是社区。** 社区涉及内容审核、并发写入、缓存一致性，失败成本高、返工代价大。工具箱读多写少、逻辑接近纯函数，用最小的业务量验证「领域层 → 应用层 → 数据层 → 测试 → 部署」整条链最便宜。**工程问题要在爆炸半径最小的地方暴露。**
- **M1 先于一切业务。** 鉴权与设计系统是所有模块的公共依赖。移动端两套导航壳如果拖到业务模块之后再补，等于重写所有页面的布局。
- **M4 才接外部系统。** 集成层的价值要在业务边界已经清晰之后才能正确抽象；过早接入会把外部系统的形状写进领域层。
- **M6 在 M5 之后。** 生图工作台是唯一需要「队列 + 轮询 + 结果转存」的模块，它的可靠性依赖前面已经跑通的 worker 基础设施（M2 就已经引入 worker，M6 只是加任务类型）。
- **M7 不是「收尾」，是独立里程碑。** 单机部署下备份与恢复演练必须专门安排时间，否则永远不会做。

- **「纯站内社交功能批」不占里程碑编号，排在设计系统对齐之后。** 判据是「不依赖外部系统」：这六项功能
  只用 Postgres + Redis + 现有 worker 就能完整实现，而 M4/M6 的价值全在外部系统与转存链路上。把它们挂在
  M4/M6 之后等于让最没有风险的活排在最贵的前置条件后面；提前插在 M5 之后，既不动 M0–M7 的划分，也不阻塞
  M6 的技术依赖（worker 在 M2 就已具备）。

## 3. 各里程碑

### M0 — 地基与文档

**状态**：已完成。2026-09-30 实跑验证两条退出标准 —— `packages/core` 里写 `import next from 'next'` 时 `pnpm lint` 退出码 1；`pnpm typecheck` 退出码 0。2026-10-01 仓库独立为 <https://github.com/xiaosu7788/xsu-cloud>，CI 在 GitHub 上首次跑通（run 36817383046，10 个步骤全 success）。当时未验证的 Compose 在 M1 已实际用起来（`postgres` 服务 `up` 并跑过迁移），仅 `redis` 仍未启动，见 [`../AGENTS.md`](../AGENTS.md)「已知债务」。

**目标**：让后续所有工作有可执行的地基。

**交付物**

- pnpm workspace 骨架与全部目录（按 [`../AGENTS.md`](../AGENTS.md) 第 2 节）。
- `packages/config`：eslint / tsconfig / tailwind 共享配置。
- ESLint 分层铁律生效（`no-restricted-imports`），**并补一条故意的失败用例**。
- CI：`tsc --noEmit`、ESLint、Prettier、Vitest 可运行。
- 文档体系：`README.md`、`AGENTS.md`、`docs/PRD.md`、`docs/ARCHITECTURE.md`、`docs/ROADMAP.md`、`docs/INTEGRATIONS.md`。
- `docker/`：Postgres + Redis 的本地 Compose。

**退出标准**

- `pnpm lint` 在 `packages/core` 中写 `import x from 'next'` 时**必须报错**（已实跑验证，见上面的「状态」）。
- `pnpm tsc --noEmit` 通过。
- **不写任何业务代码。**

**已决（不再挂待办）**

- **不启用外部文档流水线工具链对 `AGENTS.md` 的托管区块**（2026-10-02，用户明确指示）。理由：本项目的文档纪律已由 [`../AGENTS.md`](../AGENTS.md) 第 6 节自包含地定义（A/B/C 级、同一事实只写一处、每份文档必须有「怎么验证」与「已知债务」、冲突以代码为准、A 级同步是硬门禁），与该工具链区块正文的要求基本重叠；而区块正文引用的模板目录是本机绝对路径（`C:\Users\aiLL\Desktop\project-doc-template`），换机器与 CI 上不成立，且区块由插件生成、不许手工编辑。将来若真要维护那套桌面模板再重新评估。

### M1 — 鉴权与设计系统

**状态**：五项交付物全部落盘，静态、运行时与 PR 级端到端验证均已实跑。提交级检查链 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test`（7 个文件 80 个用例）与 `next build` 退出码均为 0（2026-10-02）。构建产出的路由表是 `○ /`、`○ /_not-found`、`ƒ /sign-in`、`ƒ /sign-up`、`ƒ /console`、`ƒ /console/settings`、`ƒ /admin`、`ƒ /api/auth/[...all]` —— 退出标准 1 由此成立：唯一的公开内容页（首页）仍是静态预渲染，公开分区里只有 `/sign-in` 与 `/sign-up` 按请求渲染，而这两个都不是内容页，理由分别写在各自 `page.tsx` 的文件头（登录页：第三方提供方清单来自环境变量、OAuth 失败码必须出现在首屏 HTML；注册页：已登录的人不该看到注册表单）。

**三条退出标准现在都有实测证据**（2026-10-02，本机开发服务 + 真实库 + 真实会话；受保护路由的匿名重定向随后在生产构建上用 `next start` 复测过一遍；脚本在 `Temp/scripts/`，产物在 `Temp/out/`，两者都不入库）：

- **标准 2**：在面板浏览器的同源 iframe 里按 360px / 1280px 量测 `/console`（`(console)` 外壳）与 `/admin`（`(admin)` 外壳）。360px 下 `documentElement.scrollWidth === clientWidth === 360`、桌面侧边栏 `display: none`、底部 Tab `360×57`（整格 `h-14` + `env(safe-area-inset-bottom)`）且两个入口各 `180×56`，最小可点高度 44px；1280px 下侧边栏 `240×900`、底部 Tab `display: none`、侧边栏项 `223×44`，同样无横向滚动。`min-h-dvh` 与安全区内边距在两档视口下都实际出现在 DOM 里。
- **标准 3**：开发库里一个「邮箱已验证、角色 `user`」的真实账号登录后（cookie `better-auth.session_token`，`get-session` 返回 `role=user`），`GET /admin` 得到 200 与统一拒绝视图（正文含「无法访问」「当前账号没有访问该区域的权限。」与 `403 FORBIDDEN` 对账信息），而 `/console`、`/console/settings` 对同一账号正常开放 —— 控制台对任何合法角色都开放，这里不该出现拒绝页。三个受保护路由的匿名请求一律 `307 → /sign-in`，没有出现「一处 403、一处 404、一处 500」。把该账号在开发库里改成 `role=admin` 后，`/admin` 正常渲染后台外壳，两档视口下的结论与 `(console)` 一致。

这一轮构建与类型检查还实际拦下两个缺陷：`packages/platform/src/registration.ts` 漏了 `getDb` 的 import；`apps/web/features/auth/session.ts` 把 `getAuth()` 写在 `await headers()` 之前 —— 前者立刻校验服务端配置，于是本该动态渲染的 `(console)`/`(admin)` 被当成可预渲染页面，构建机没有生产密钥就直接失败。两处都已修，理由写进了各自文件头。运行时验证阶段又拦下三个静态检查链看不见的缺陷（`.env` 定位、Tailwind 扫描基准、导航命中区），逐条记在 [`CHANGELOG.md`](CHANGELOG.md) 的 M1「修复」段。

**三条退出标准已从「手工实测」升级为可重跑的端到端回归**（2026-10-03）：用例在 `apps/web/e2e/`，命令 `pnpm --filter @xsu/web test:e2e`，本机实跑 32 passed / 5 skipped / 0 failed（跳过项是「构建产物断言与本视口无关，只在 desktop 跑一次」和「触控目标只对触控设备成立」，都是带理由的显式 `test.skip`）；CI 上由 `e2e` job 跑同一批（Postgres service + 迁移），入口见 [`AGENTS.md`](../AGENTS.md) 第 7 节。跑的是**生产构建**（`next build` + `next start -p 3100`）加真实库、真实会话，因此量的是与手工实测同一批事实：`/` 在预渲染清单里且运行期带预渲染标记、`(site)` 除例外表外都必须预渲染且例外表不得过期、`(console)`/`(admin)` 一律不得预渲染；公开页顶栏在 1280px 与 360px 两档都可用、两页在 360px 无横向滚动、移动端可点项 ≥44px、axe 无 serious/critical 违规；三个受保护路由的匿名响应形状完全一致（一律 `307 → /sign-in`）、非管理员访问 `/admin` 渲染统一拒绝视图而同一账号访问 `/console` 与首页正常。
**目标**：一套可复用的骨架，业务模块只管填内容。

**交付物**

- Better Auth 接入：邮箱密码作为主路径、会话、角色。**OAuth 按已定结论做**：GitHub 与 Linux.do 两个提供方，各一个适配器；**不自动关联账号**，绑定须已登录后主动发起。邀请码注册准入在本里程碑落地。
- 设计系统：shadcn/ui 基础组件、双主题（light/dark，跟随系统 + 手动切换 + 持久化）。
- **响应式原语**：`ResponsiveNav`、`ResponsiveTable`、`ResponsiveGallery`、断点常量（见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 7.4）。
- 路由分区 `(site)` / `(console)` / `(admin)` 外壳与权限守卫。
- PWA 基础：manifest、图标（含 maskable）、service worker 与**明确的更新策略**。

**退出标准**

- 公开页默认静态化，不因引入鉴权而变成全站动态渲染（红线 1）。
- 桌面与移动视口下导航均可用，360px 无横向滚动。
- 非管理员访问 `(admin)` 得到统一拒绝响应。

### M2 — 工具箱

**状态**：五项交付物全部落盘；提交级检查链、生产构建、端到端回归（双视口）与 k6 容量实测均已实跑（2026-10-03）。`pnpm typecheck`、`pnpm lint`、`pnpm format:check` 退出码 0；`pnpm test`（已内置 `--coverage`）**9 个文件 129 个用例全通过**；`pnpm --filter @xsu/web test:e2e`（`next build` + `next start` + 真实库，桌面 1280px / 移动 360px）**56 个用例 50 通过 / 6 跳过 / 0 失败**（跳过项是「改写共享状态的用例只在 desktop 跑一次」这类带理由的显式 `test.skip`）。

**三条退出标准现在都有实测证据**：

- **标准 1（`packages/core` 分支覆盖 ≥80%）**：`@vitest/coverage-v8` 已接入，`packages/core` 合计语句 99.48% / **分支 98%** / 函数 100% / 行 99.45%。没覆盖到的分支是 `registry.ts` 的重复 slug 抛错与 `types.ts` 的一档类型判别 —— 前者只能在模块加载时触发，为它造一个入口不划算。
- **标准 2（跨用户访问被拒有测试覆盖）**：领域层 `decideToolRunAccess` 只放行归属者（**管理员也不放行**，理由见 [`spec/SPEC-tools.md`](spec/SPEC-tools.md)），用例在 `packages/core/tests/tools.test.ts`；表现层由 `apps/web/e2e/tools.spec.ts` 用第二个真实账号访问他人的运行详情，断言「别人的运行记录打不开，且与不存在的 id 得到同一个视图」，同一文件里还有一条反向断言「自己的运行历史里不出现别人的记录」。
- **标准 3（第 8 节容量数字不再是 TBD）**：[`ARCHITECTURE.md`](ARCHITECTURE.md) 第 8 节的那段 `TBD` 已被替换成 k6 第二轮的真实数字。该轮按端点分别打点：1m50s、VU 上限 30，3226 iterations / 16130 次请求（146.58 req/s），全站 `p95` 453.34 ms / `p99` 584.67 ms，**全程 0 个 5xx、0 个网络错误**。慢点集中在两条动态控制台页（`p95` 511 / 552 ms），两个静态页的 `p95` 都在 30 ms 以内。同节写明了已知局限：单机、本机压本机、无 CDN、单应用副本、只压读路径、`get-session` 因内建限流只有 800 个成功样本。

这一轮有两个「验证本身抓出来的」结果，都写进了 [`ARCHITECTURE.md`](ARCHITECTURE.md) 7.2 与 [`CHANGELOG.md`](CHANGELOG.md) 的 M2 节：k6 报出的 15.04% 失败率**全部**是 `/api/auth/get-session` 的 429，根因是 Better Auth 按默认配置在**进程内**限流（多副本时每副本各限一份）—— M2 是单副本所以没暴露，不是应用缺陷；注册验证邮件从「请求内同步发」改成「入队后由 worker 发」，代价是**注册成功不再等于邮件已发出**。

**目标**：用最小业务量验证整条工程链。

**交付物**

- 工具清单、执行、运行历史、收藏。
- 领域层权限与配额判定，含跨用户访问拒绝的测试。
- worker 基础设施（BullMQ）首次落地。
- `docs/TESTING.md` 建立（`docs/DATA-MODEL.md` 已在 M1 建立）。
- **k6 压测并回填 [`ARCHITECTURE.md`](ARCHITECTURE.md) 第 8 节的真实数字。**

**退出标准**

- `packages/core` 分支覆盖 ≥80%。
- 跨用户访问被拒有测试覆盖。
- 第 8 节容量数字不再是 TBD。

### M3 — 社区

**状态**：四项交付物全部落盘；提交级检查链、生产构建与端到端回归（双视口）均已实跑（2026-10-04）。`pnpm typecheck`、`pnpm lint`、`pnpm format:check` 退出码 0；`pnpm test`（已内置 `--coverage`）**10 个文件 140 个用例全通过**；`pnpm --filter @xsu/web test:e2e`（`next build` + `next start` + 真实库，桌面 1280px / 移动 360px）**65 个用例 59 通过 / 6 跳过 / 0 失败**（跳过项仍是「构建产物与视口无关」与「44px 仅移动端」的按视口去重，见 [`TESTING.md`](TESTING.md) 3.1）。

**四条退出标准现在都有实测证据**：

- **标准 1（连续翻页不重复、不遗漏）**：领域层 `packages/core/tests/community.test.ts` 用内存假仓储翻满多页并断言 `(created_at,id)` 游标边界；e2e 造 25 帖在真实库上连续翻页，断言不重不漏。
- **标准 2（并发点赞不产生重复行）**：`reactions` 的复合主键 `(post_id, user_id)` + `ON CONFLICT DO NOTHING`，领域层单测覆盖幂等语义；e2e 用两个独立浏览器上下文同时点赞同一条帖子，断言 `reactions` 仅一行、计数为 1。
- **标准 3（软删除从列表与搜索同时消失）**：可见性统一走 `deleted_at is null` 谓词；e2e 作者删除后同时断言列表页与搜索页找不到、详情页是统一拒绝视图。
- **标准 4（举报不自动下架、必须有管理员确认路径）**：领域层 `createReport` 不改内容状态，`confirmTakedown` 把下架、举报置终态、写审计锁进同一事务；e2e 走完整路径——举报后内容照旧可见，管理员在 `/admin/reports` 确认下架后内容消失、`audit_logs` 多一行。

这一轮验证抓出并修掉了三个真实缺陷（细节见 [`CHANGELOG.md`](CHANGELOG.md) M3 节）：脚本与 `next build` 环境缺 `DATABASE_URL`（数据层改为模块加载时自举加载 `.env`）；ISR 动态路由缺 `generateStaticParams` 导致公开详情页与标签页不静态化（已补，`dynamicRoutes` 断言进端到端）；e2e 管理员夹具「先删后建」撞上审计触发器、套件跨运行不幂等（改为「存在即复用」）。第三个发现的根因——`audit_logs` 的 actor 级联与追加只读触发器的冲突——记录在 [`spec/SPEC-community.md`](spec/SPEC-community.md) 的已知债务里。

**目标**：第一次真正撞上并发与缓存一致性问题。

**交付物**

- 帖子、评论、点赞、标签、举报、审核。
- 游标分页与复合索引。
- 列表计数走 Redis，读多写少路径不进数据库。
- 内容相关的配额与限流。

**退出标准**

- 连续翻页不重复、不遗漏（自动化测试覆盖）。
- 并发点赞不产生重复行（唯一约束生效）。
- 软删除内容从列表与搜索同时消失。
- 举报内容不会自动下架，必须有管理员确认路径。

### M4 — 集成层与中转站

**目标**：把「外部系统」这件事定型，让后面每接一个源都只是加一个目录。

**交付物**

- `packages/integrations/` 定型：一个外部系统一个目录，只做翻译，不 import `packages/core`。
- 首个适配器：对象存储（S3 兼容 API，开发 MinIO / 生产 Cloudflare R2）。
- 外部数据源适配器：**中转站所用的外部系统只作为数据源接入**，不参与分层、数据模型与选型。
- `external_identities` 表落地，键为 `(provider, external_id)`。
- 中转站入口与控制台页面：用量、额度、密钥展示。
- `docs/INTEGRATIONS.md`、`docs/API.md`、`docs/SECURITY.md` 补齐。

**退出标准**

- 适配器对外的类型全部是本项目自有类型，外部字段名不出现在领域层。
- 外部系统不可用时，页面降级为明确提示而不是 500。
- 外部凭证只存在于服务端；前端产物中搜不到任何密钥。
- 集成层对 `packages/core` 的 import 被 ESLint 拒绝（同 M0 的失败用例）。

### M5 — 后台管理

**目标**：让「对外服务」有可运维的手。

**交付物**

- `(admin)` 分区：用户管理、内容管理、任务管理、站点配置。
- 审计日志：敏感操作只追加、不更新。
- 配额与限流的后台调整入口。
- 用量与成本看板。

**退出标准**

- 每一次管理员敏感操作都能在审计日志里找到对应记录。
- 审计日志表无 UPDATE/DELETE 路径。
- 管理员越权访问被领域层拒绝并有测试覆盖。
- 后台不成为新的动态渲染源：公开页静态化不受影响。

**状态**：已完成。2026-10-05 实跑验证四条退出标准。交付落盘：`(admin)` 六页面（`/admin` 概览、`/admin/users`、`/admin/content`、`/admin/tasks`、`/admin/config`、`/admin/audit`）、`audit_logs` 的追加写仓储与只读查询页、`site_config` 表与配额覆盖入口（优先级 `site_config 覆盖 > env 默认 > core 常量`，调整入口即时生效）、封禁即拒新会话（`session.create.before` 现查 + 封禁事务内删除全部会话，`banned_at`/`ban_reason` 两列）。交付物第 4 条「用量与成本看板」降级：任务页提供只读运行统计，成本看板依赖 M4 的外部系统与计费口径，随 M4 一并补。顺手修掉 M3 遗留的真缺陷：点赞按钮挂载同步只回写 liked 不回写 count，ISR 15 秒窗口内 `page.reload()` 的首帧计数显示 0——`like-button.tsx` 现在同时回写两者。

**四条退出标准现在都有实测证据**（2026-10-05；单测 `pnpm test` 11 个文件 161 个用例全过、core 分支覆盖率 97.96%，e2e 93 个用例 87 passed / 6 skipped / 0 failed，`typecheck` / `lint` / `format:check` 退出码 0）：

- **敏感操作有审计行**：`packages/core/tests/admin.test.ts`（21 例）逐动作断言审计写入（封禁、解封、下架、恢复、配置更新），e2e 对每个动作断言 `?ok=` 横幅与 `audit_logs` 新行（`user-ban` / `user-unban` / `post-takedown` / `post-restore` / `site-config`）。
- **审计日志表无 UPDATE/DELETE 路径**：迁移 `0003_admin_tables.sql` 未触碰两枚触发器；实跑 `select tgname from pg_trigger where tgrelid='audit_logs'::regclass and not tgisinternal` 复核 `append_only` 与 `no_truncate` 仍在；仓储层只有 insert 与 select，不存在 update/delete 审计路径。
- **越权被领域层拒绝并有测试**：每个 admin 入口第一步都是 `requireAdminActor`；`admin.test.ts` 覆盖非管理员被拒；e2e 对 7 条 admin 路由断言统一拒绝视图、对 9 条受保护路由断言匿名同形 `307 → /sign-in`。
- **公开页静态化不受影响**：`static-render.spec.ts` 全绿；构建路由表中 7 条 admin 路由全为 `ƒ` 动态渲染；`/` 等公开页预渲染清单与 M3 一致。

### 设计系统基线对齐 DoulorCloud（M5 之后，非里程碑）

**为什么插在这里**：M1 承诺的「设计系统」只落到了 token 与三个响应式原语，页面层的标题层级、空态、外壳质感
各页各写。以参考实现（`DoulorCloud-main`）为基线做一次全量对齐，属于把 M1 的欠账补上，不改变 M0–M7 的
里程碑划分，因此不占新编号。基线口径与已知债务见 [`DESIGN.md`](DESIGN.md)。

**落盘**：`globals.css` 设计基线（自托管 Outfit、`glass-*` 三档、`page-enter` / `data-fade` 关键帧、
`cursor-glow`、云纹底纹、reduced-motion 收口）、7 个共享组件、19 个页面改用 `PageHeader`、
4 处空态改用 `EmptyState`、控制台外壳按角色装配导航入口（修掉「管理员看不见后台入口」）。

**验证**：`pnpm test` 11 个文件 161 个用例全过（core 分支覆盖率 97.96%）；`pnpm lint` / `format:check` /
`typecheck` 退出码 0；`pnpm --filter @xsu/web test:e2e` **87 passed / 6 skipped / 0 failed**——与对齐前
逐条一致，说明这次改动没有回归；另有只读运行时探针 25 项全过（产物 CSS 里 `glass-*` 三类与
`page-enter` / `data-fade-in` 关键帧确实产出、`color-mix` 透明度 0.68、`backdrop-filter` 生效、
`html` 无背景的红线保持、深色下 `CursorGlow` 挂载且 `z-index: 45`、360px 无横向滚动）。

**已知债务**：`badge` / `skeleton` / `data-fade` 已移植未接线，见 [`DESIGN.md`](DESIGN.md) 第 9 节。

### 纯站内社交功能批（M5 之后，非里程碑）

**为什么插在这里**：参考实现的功能清单里有 6 项功能只用得到 Postgres + Redis + 现有 worker，不需要任何
外部系统。它们既不属中转站也不属生图工作台，因此按「M5 之后、M6 之前」的独立批次推进，不占里程碑编号。
范围判定标准与逐表设计理由见 [`spec/SPEC-social.md`](spec/SPEC-social.md)。

**推进顺序即依赖顺序**：通知 → 私信（入站产生通知）→ 个人空间 → 积分 → 签到（发放积分）→ 成就。
排行榜不在本批（理由见 `SPEC-social.md` 1.2）。

**当前状态（2026-10-05）：领域层与数据层已落盘，页面层尚未开工。**

- 数据层：`packages/db/src/schema/social.ts` 九张表 + 迁移 `0004_past_black_bird.sql`，已在本机实跑生效
  （库内 22 张表、2 条部分唯一索引），`db:check` 无 drift；逐表说明见 [`DATA-MODEL.md`](DATA-MODEL.md)
  3.14–3.22。
- 领域层：`packages/core/src/social/`（`rules` / `notifications` / `points` / `checkins` / `messages` /
  `space` / `achievements` / `types` / `index`），端口以 `SocialPorts` 注入，纯函数无 I/O。
- 验证：`pnpm test` **12 个文件 235 个用例全过**（其中 `social.test.ts` 74 例），`packages/core` 分支
  覆盖率 **98%**（`src/social` 96.41% 语句 / 98.08% 分支，门槛 80%）；`pnpm typecheck` / `pnpm lint` /
  `format:check` 退出码 0。

**未做的部分**：页面、Server Action、API 路由与端到端用例都还没写。[`PRD.md`](PRD.md) 3.7 的六条验收标准
目前只有单测一侧的证据，**要等页面层落地才算兑现**——中间不得声称「社交功能已完成」。

**已知债务**：除 `SPEC-social.md` 第 6 节登记的五条外，本批新增一条——`notifications` 与
`point_transactions` 的幂等依赖部分唯一索引的谓词与查询写法一致，换成别的写法不破坏幂等，但会让索引
静默失效（见 [`DATA-MODEL.md`](DATA-MODEL.md) 已知债务）。

### M6 — 生图工作台

**目标**：跑通「队列 + 轮询 + 结果转存」这条最容易出错的链路。

**交付物**

- 任务提交、进度、历史、重试、取消。
- 外部生图源适配器（在 M4 定型的目录结构内新增，不改核心）。
- **结果转存**：任务完成后由 worker 立即把结果抓回本项目对象存储，`image_assets` 只存本项目自己的 key。
- 轮询全部在 worker 内完成，前端只轮询本项目轻量接口（Redis 承载）。
- 预设、画廊、批量任务。

**退出标准**

- 外部结果链接过期后，历史记录里的图片仍可正常访问（因为早已转存）。
- 提交与查询使用同一凭证（部分外部平台要求一致），凭证不出服务端。
- worker 重启后未完成任务能续跑，不丢任务（Redis AOF 生效）。
- 生成失败有明确错误码与可重试路径，不出现静默失败。

### M7 — 加固与上线

**目标**：让「能跑」变成「敢开放」。

**交付物**

- k6 压测复跑，真实数字写回 [`ARCHITECTURE.md`](ARCHITECTURE.md) 第 8 节。
- **备份与恢复演练**：从备份实际恢复一次，记录耗时与缺口。
- 回滚流程演练：`docs/DEPLOYMENT.md`。
- 合规页面：隐私政策、服务条款、账号注销入口。
- 依赖漏洞扫描与升级。

**退出标准**

- 从备份恢复到可用状态的完整流程被真实执行过一次，耗时被记录。
- 回滚流程被真实执行过一次。
- 账号注销能真正删除或匿名化个人数据。
- 公开页在移动 4G 下的首屏指标达到 PRD 设定目标（红线 1 的最终验收）。

## 4. 怎么验证本文件

- **顺序合理性**：任取一个里程碑，它的「依赖」列指向的里程碑的退出标准必须真的覆盖了它的前置条件。逐项人工核对一次。
- **可执行性**：每个里程碑的退出标准必须是可判定的（能被一条命令、一个测试或一次演练证明），出现「基本可用」「体验良好」这类词即为缺陷。
- **与 A 级文档一致**：里程碑划分与 [`ARCHITECTURE.md`](ARCHITECTURE.md) 的模块边界、[`PRD.md`](PRD.md) 的范围三者不能互相矛盾。
- **演进规则**：里程碑调整时，必须同步修改本文件与 [`PRD.md`](PRD.md) 的范围表，不允许只改一处。

## 5. 已知债务

- **M1 的邀请码发放方式未定**（谁发、发多少、有无有效期）。这不阻塞实现，阻塞上线开放注册。机房位置仍未拍板，见 [`PRD.md`](PRD.md) 第 5 节；当前架构不依赖它，M7 前定即可。
- **M0 的文档体系里 `docs/ADR/` 尚未建立。** 目前的关键决策记录散落在本文件与 [`ARCHITECTURE.md`](ARCHITECTURE.md)，需要在 M0 抽出独立 ADR。
- **本文件的时间估计一律缺失，这是有意的。** 没有可比较的历史速度之前写下的人日数字是编的，不写比写错的强。
- **M7 的备份演练依赖 `docs/DEPLOYMENT.md`，该文件尚未创建。**
- **容量目标尚未定死。** M2 已经给出第一组真实数字（[`ARCHITECTURE.md`](ARCHITECTURE.md) 第 8 节），但那只覆盖读路径与单应用副本，而且是本机压本机。目标用户规模与开放程度相关，等 M3 有并发写入路径的数字后一并回填。

- **M1 的三条退出标准已有可重跑的回归，但覆盖止于「不需要外部交互的那一半」。** 静态化、双视口导航与无横向滚动、统一拒绝响应都由 `apps/web/e2e/` 的用例守住，改坏了 CI 会红（`e2e` job）。它挡不住四件事：邮箱验证链接的完整往返（夹具直接把 `emailVerified` 置真，理由见 `apps/web/e2e/seed.ts`）、OAuth 回调、真实 SMTP 投递，以及 service worker 的注册/离线/更新提示交互（端到端里被刻意屏蔽，见 [`playwright.config.ts`](../apps/web/playwright.config.ts)）。手工实测的原始证据仍留在上面 M1「状态」里。

- **M1 的邮件只走过「控制台传输」，没接过真实 SMTP。** 本机 `.env` 已写入开发值（`.env` 由 `.gitignore` 排除，字段清单是入库的 `.env.example`），迁移已应用到本地 `xsu-postgres`；注册触发的验证邮件只是把链接打到终端，再由脚本去点。真实 SMTP 投递（含退信、限流、生产密钥轮换）未验证。

- **M1 的 PWA 与 OAuth 都只验证到「不涉及外部交互的那一半」。** PWA：生产构建 + `next start` 下 `/manifest.webmanifest`（`application/manifest+json`，917 B）、`/sw.js`（`application/javascript`，8456 B）、`/offline.html`（3320 B）与 5 个图标（192 / 512 / maskable 192 / maskable 512 / apple-touch-icon，均 `image/png`）全部返回 200，字节数是按 `Accept-Encoding: identity` 请求后读到的 `Content-Length`；但 **service worker 的注册、离线提示与「有新版本」提示的交互没有在浏览器里跑过**——端到端用例里它是被刻意屏蔽的（`serviceWorkers: 'block'`），理由见 [`playwright.config.ts`](../apps/web/playwright.config.ts)。OAuth：本机没有 GitHub / Linux.do 的提供方凭证（`packages/platform` 对没配凭证的提供方整个去掉该键），真实回调与账号绑定流程未跑过。

- **创建第一个管理员的途径——已在 M3 补上。** `scripts/grant-admin.ts` 把既有账号提升为 `admin`（复用 `@xsu/core` 的角色常量，提权不写 `audit_logs`），本机已实跑产出 `admin@xsu.local`；端到端夹具 `apps/web/e2e/admin-seed.ts` 走真实注册编排造出管理员并登录，`/admin/reports` 的确认下架 / 驳回在 e2e 中真实走通。完整的管理员运营面（用户管理、内容管理、任务管理、站点配置、审计查询）已在 M5 落地，见上文 M5「状态」。
