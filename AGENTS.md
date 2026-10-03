# AGENTS.md — xsu-cloud 项目约束

本文件是本仓库的强制约束，在本项目范围内优先于通用个人习惯。与 `~/.pi/agent/AGENTS.md` 冲突时以本文件为准；本文件未涉及的，按全局规则执行。

> **当前阶段：M1 鉴权与设计系统已落地；提交级检查链、`next build`、运行时最小验证（真实会话 + 真实视口）与 M1 三条退出标准的端到端回归均已实跑。**
> 已有：pnpm workspace 骨架与全部约定目录、`packages/config` 共享配置、分层铁律 ESLint（含故意的失败用例）、提交级检查链与 CI 工作流（提交级与 PR 级两个 job）、`docker/` 本地 Postgres + Redis；M1 又落下数据层表与迁移、`packages/core` 四条横切规则、`packages/platform`（配置校验 / Better Auth 实例 / 注册编排）、`apps/web` 三个分区外壳与权限守卫、设计系统与双主题、三个响应式原语、PWA 四件套、邀请码注册入口，以及 `apps/web/e2e` 里的端到端回归。**登录、邀请码注册、统一拒绝响应与两档视口的布局都已实测，且这三条退出标准现在由可重跑的端到端用例守住**（`pnpm --filter @xsu/web test:e2e`，CI 的 `e2e` job 每次都跑）。仍未验证的是 OAuth 回调（本机无提供方凭证）、真实 SMTP 投递、邮箱验证链接的完整往返，以及 PWA 更新提示在浏览器里的行为（端到端里 Service Worker 被刻意屏蔽，理由见 `apps/web/playwright.config.ts`）。未验证清单见 `docs/ROADMAP.md` 第 5 节。开始任何实现之前，先读 `docs/ARCHITECTURE.md`（分层与边界）与 `docs/PRD.md`（范围与验收）。

---

## 1. 项目一句话

一个个人云站，同时预留对外服务能力：五层分层的单体 Next.js 应用，单机 Docker Compose 部署，机房在境外。

- 对外模块：中转站（入口 + 控制台）、社区、工具箱、生图工作台
- 管理端：后台管理
- **外部系统不在本项目内。** 本项目与外部系统之间只有「集成层适配器」这一条通路，见 `docs/INTEGRATIONS.md`。

## 2. 目录约定

```text
apps/web/app/(site)        公开页：首页、社区、工具箱
apps/web/app/(console)     登录后的用户控制台：中转站入口、我的任务
apps/web/app/(admin)       后台管理
apps/web/app/api           Route Handlers（薄壳）
apps/web/components        跨模块共享 UI，含响应式原语
apps/web/features          按业务模块组织的页面与交互
apps/web/e2e              Playwright 端到端用例与夹具（PR 级验证，不进生产构建）
apps/web/public            PWA manifest、图标与 service worker（不经构建的静态资源）
packages/core              领域层：纯 TypeScript
packages/integrations      集成层：一个外部系统一个目录
packages/db                数据层：schema 与迁移
packages/platform          auth / cache / queue
packages/shared            无业务语义的工具与类型
packages/config            eslint / tsconfig / tailwind 共享配置
docs/                      文档（见第 6 节）
docker/                    Docker Compose 与容器配置
scripts/                   一次性脚本与运维脚本
.github/workflows/           CI 工作流（提交级检查）
Temp/                       临时文件与中间产物（已 gitignore，约定 Temp/{tests,scripts,cache,out}）
```

新增目录必须先改本文件。不允许就地新建目录、事后再补文档 —— 上面这些 `apps/web/*` 子目录
同样在约定之内，不在清单里的（例如 `apps/web/lib`）就是不允许新建的；需要时先在这里加上并说明理由。

`apps/web/e2e` 的理由：端到端用例属于验证资产而不是业务代码，既不能被 `features/` 的模块边界
绑住，也不能混进 `app/` 路由树；测试配置 `apps/web/playwright.config.ts` 放在包根，与
`next.config.ts`、`tsconfig.json` 同级。

## 3. 分层铁律（ESLint 强制，违反即 CI 失败）

依赖方向只能自上而下：

```text
表现层   apps/web/app/(site|console|admin) + components/ + features/
   │
   ▼
应用层   apps/web/app/api/ + Server Actions    薄壳，≤30 行，无业务规则
   │
   ▼
领域层   packages/core                         纯 TypeScript，零框架依赖
   │
   ▼
数据层   packages/db   ←──→   集成层   packages/integrations/*
```

两条硬规则：

1. **`packages/core` 不得 import 任何框架。** 禁止 `next`、`next/*`、`react`、`react-dom`、`server-only`；同时禁止 import `packages/integrations/*`。
2. **`packages/integrations/*` 不得 import `packages/core`。** 适配器只做翻译，不知道业务规则。

已用 `packages/config/eslint` 中 `no-restricted-imports` 的 `paths` + `patterns` 实现，按目录分别覆盖：领域层禁框架与集成层，集成层禁领域层，两者都禁 `apps/web`。**规则的唯一实现文件是 `packages/config/eslint/layering.mjs`**，根 `eslint.config.mjs` 只做转发，行为由 `packages/config/eslint/tests/layering.test.ts` 锁定。

这条规则的存在理由不是洁癖，是两件事：

- 某个模块变热时，可以整块搬成独立的 Hono/Fastify 服务，**同语言、同类型、零重写**；
- 接一个新的外部系统只是加一个目录，核心业务一行不改。

**破坏它等于主动放弃这两个能力。**

## 4. 红线（PR 可阻断）

1. **公开内容页不得默认为动态渲染。** 能用静态/ISR 就用；动态渲染是例外，且必须在 PR 里给出理由。
2. **高频接口不得走页面 SSR。** 轮询、点赞、阅读数走独立轻量接口，必要时以 Redis 承载。
3. **图片与大文件不得经 Node 代理。** 一律对象存储直链 + CDN，Node 只负责签名与元数据。
4. **请求路径内不做 CPU 密集后处理。** 压缩、转码、批量生成一律交 worker，接口只负责入队。
5. **分层依赖方向不得反向**（见第 3 节）。

由「对外服务」定位衍生的补充约束：

6. **每张业务表必须能回答「这是谁的」。** 跨用户访问必须在领域层拒绝，并有测试覆盖。
7. **面向用户的写操作必须有配额与限流。** 注册、发帖、提交任务、上传文件都不例外。
8. **管理员敏感操作必须写审计日志，且审计日志只追加不更新。**

## 5. 技术栈固定项

未经理由充分的 ADR，不得替换。

| 用途 | 选型 | 版本（规划期核对） |
| --- | --- | --- |
| 框架 | Next.js | 16.3.7 |
| UI 引擎 | React / React DOM | 19.3.0 |
| 组件 | shadcn/ui | 4.21.0 |
| 样式 | Tailwind CSS | 4.3.3 |
| 语言 | TypeScript | **5.9**（不用 7.x） |
| 数据库 | PostgreSQL | 自托管 |
| ORM | Drizzle ORM / drizzle-kit | 0.45.3 / 0.31.11 |
| 缓存 | Redis（ioredis） | 6.0 |
| 队列 | BullMQ | 6.3.10 |
| 鉴权 | Better Auth | 1.7.6 |
| 校验 | Zod | 4.6.5 |
| 接口数据 | TanStack Query / Table | 5.104.0 / 9.2.4 |
| 图表 | Recharts | 3.10.1 |
| 包管理 | pnpm workspace | 11.5.2 |
| 部署 | Docker Compose | — |
| 对象存储 | S3 兼容 API（开发 MinIO / 生产 Cloudflare R2） | — |

选型说明：

- **TypeScript 用 5.9 而非 7.x。** 7.x 工具链尚不成熟，个人项目不值得当小白鼠。
- **对象存储只认 S3 兼容 API**，不用任何厂商专用 SDK。这是「换供应商只改 endpoint 与凭证」的前提。
- 版本号在规划阶段从 npm registry 实查；实施时以当时的稳定版为准，升级需记入 `docs/CHANGELOG.md`。

## 6. 文档纪律

文档分三级，**A 级是硬门禁**。

| 文档 | 级 | 回答什么问题 | 何时必须更新 |
| --- | --- | --- | --- |
| `AGENTS.md` | A | 约束、红线、目录约定 | 红线变化时，且必须同步代码 |
| `docs/ARCHITECTURE.md` | A | 分层、模块边界、容量与压测真实数字 | **模块边界变化时不同步就阻断合并** |
| `docs/PRD.md` | A | 做什么、不做什么、验收标准 | 范围变化 |
| `docs/ADR/000x-*.md` | A | 为什么这样选（含被否决的方案） | 做关键决策时当场写 |
| `docs/INTEGRATIONS.md` | B | 每个外部系统的契约、限流、失败处理 | 新增或替换适配器 |
| `docs/DATA-MODEL.md` | B | 表、字段、索引、迁移 | 加表改字段 |
| `docs/API.md` | B | 对外接口与错误码 | 加接口 |
| `docs/spec/SPEC-*.md` | B | 单个需求的可执行规格 | 需求开工前 |
| `docs/TESTING.md` | B | 怎么验、验什么、覆盖线 | A 级改动补验证 |
| `docs/SECURITY.md` | B | 权限模型、密钥管理、数据边界 | 权限或鉴权变化 |
| `docs/DEPLOYMENT.md` | B | 部署、备份、回滚 | 部署方式变化 |
| `docs/CODING-STANDARDS.md` | C | 代码风格与命名 | 很少 |
| `docs/CHANGELOG.md` | C | 改了什么 | 每个 PR |

规则：

- **同一事实只写一处。** 其他文档用链接指过去，不复制。事实归属看上表「回答什么问题」。
- **每份文档必须有「怎么验证」与「已知债务」两节。** 没有这两节的文档视为未完成。
- A 级文档与代码不一致时，**以代码为准并立刻改文档**。改不动就说明架构已经漂移，停下来讨论，不许改文档糊过去。

## 7. 验证要求

- **提交级**：`tsc --noEmit`、ESLint、Prettier、Vitest（`packages/core` 分支覆盖 ≥80%）。
- **PR 级**：Playwright 主流程（桌面 + 移动两套视口）、axe 无 serious 问题、A 级文档同步检查。前两项已实现为 `apps/web/e2e` 下的可重跑用例，命令 `pnpm --filter @xsu/web test:e2e`（要求本地 Postgres 已启动并跑过迁移），CI 的 `e2e` job 跑同一批用例。
- **周期级**：每周依赖漏洞扫描。
- **里程碑级**：k6 压测，**真实数字写回 `docs/ARCHITECTURE.md`**。达不到预期就调架构，不调文档。

## 8. 尚未决策项 —— 禁止擅自假定

以下问题用户尚未拍板。任何实现都不得单方面选定，需要时先问：

| 问题 | 影响 |
| --- | --- |
| 机房具体位置 | 影响跨境延迟，进而影响动态请求的体验上限 |

`docs/PRD.md` 同步标注该项为待决。已经确认的决策记入 `docs/PRD.md` 第 2 节，不再留在本表。

---

## 怎么验证本文件

- **分层铁律**：已实跑验证 —— 在 `packages/core` 里临时落盘 `import next from 'next'`，`pnpm lint` 退出码 1 并报 `no-restricted-imports`；`packages/config/eslint/tests/layering.test.ts` 的 12 个用例同时覆盖「必须报错」与「不得误伤」（`@xsu/db`、`zod`、`@aws-sdk/client-s3` 等负向对照）。
- **目录约定**：与 `docs/ARCHITECTURE.md` 第 2 节逐项一致；不一致即为缺陷。
- **表述时效**：本文件里所有「计划 / 尚未 / M0 建立后」的表述，在对应能力落地后必须改成既成事实，不允许长期挂着。

## 已知债务

- 本机直连 `github.com:443` 会被重置（`api.github.com` 正常），推送必须显式走本地代理：`git -c http.proxy=socks5h://127.0.0.1:10808 push`。SSH 的 443 端口通，但本机默认 SSH 身份是 `xiaosu-git`，不是本仓库所有者账号，所以本仓库固定走 https + gh 凭证。
- 本项目外层还有一个无提交、无远端的 git 仓库（`D:\Project`，其下并列多个无关项目）。在它的工作树里执行 `git add` 会把本项目当成嵌套仓库，操作前先确认当前目录。
- `docker/docker-compose.yml` 的 `postgres` 服务已实际 `up` 并跑过迁移（`xsu-postgres`，healthcheck healthy，宿主端口 5433）；同文件的 `redis` 服务尚未启动过 —— M1 不需要缓存与队列，M2 引入 BullMQ 时再验。
- 第 5 节的版本号已在 M1 从 npm registry 实查后固化到各 `package.json`，实查结果记在 `docs/CHANGELOG.md`；新增依赖（M2 起：BullMQ、ioredis、TanStack Query / Table、recharts）时需重新核对并记录。
- `packages/core` 的 ≥80% 分支覆盖率要求尚无工具支撑：`@vitest/coverage-v8` 刻意未安装，等 M2 有真实领域代码再接入。
- Markdown（含 A 级文档）不参与 Prettier 检查，见 `.prettierignore`；格式靠人工维持。
- 第 8 节仅剩机房位置一项待决；OAuth 提供方与账号关联策略已定，并在 M1 按该结论实现（不自动关联账号、绑定须已登录后主动发起），但尚无运行时验证。
