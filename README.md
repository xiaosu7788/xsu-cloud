# xsu-cloud

个人云站：中转站入口 · 社区 · 工具箱 · 生图工作台 · 后台管理。

---

## ✅ 当前状态：M2 工具箱已落地，提交级检查链、端到端回归与容量实测均已实跑

仓库里已有可运行的工程骨架：pnpm workspace 与全部约定目录、`packages/config` 共享配置（eslint / tsconfig / tailwind）、分层铁律 ESLint 规则（含故意的失败用例）、提交级检查链（ESLint / Prettier / `tsc --noEmit` / Vitest）、CI 工作流，以及 `docker/` 本地 Postgres + Redis。

M1 已落盘：数据层表与迁移（鉴权四表 + 邀请码）、`packages/core` 四条横切规则、`packages/platform`（配置校验、Better Auth 实例、注册编排）、`apps/web` 三个分区外壳（`(site)` / `(console)` / `(admin)`）与权限守卫、设计系统与双主题、`ResponsiveNav` / `ResponsiveTable` / `ResponsiveGallery` 三个响应式原语、PWA 四件套。M2 已落盘：工具箱（工具目录在代码内的注册表、四支纯函数工具、运行历史与收藏）、`packages/platform` 的队列与过期清理、**`apps/web/worker` 这个独立 worker 进程**（BullMQ 首次落地），以及 `docs/TESTING.md`。

**验证到哪一步**：提交级检查链 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test`（9 个文件 129 个用例，含 `packages/core` 分支覆盖率门槛 80%，实测 98%）与 `next build` 退出码均为 0。端到端回归 `pnpm --filter @xsu/web test:e2e`（生产构建 + 真实库 + 桌面 1280px / 移动 360px 两套视口）**56 个用例 50 通过 / 6 跳过 / 0 失败**，M1 与 M2 各三条退出标准现在都由它守住。容量方面，k6 第二轮按端点打点跑出 3226 iterations / 16130 次请求（146.58 req/s）、全站 `p95` 453.34 ms、**全程 0 个 5xx**，真实数字已回填 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 第 8 节（不再是 TBD）；该节同时写明了局限：单机、本机压本机、无 CDN、单应用副本、只压读路径。**仍未验证的是 OAuth 回调、真实 SMTP 投递、邮箱验证链接的完整往返、PWA 更新提示在浏览器里的交互，以及「杀掉 Redis 后任务不丢」**（端到端里 Service Worker 被刻意屏蔽，理由见 `apps/web/playwright.config.ts`）。完整清单见 [`docs/ROADMAP.md`](docs/ROADMAP.md) 第 5 节。

## 这是什么

一个由单人开发与维护的多功能站点，同时**预留对外服务能力**（数据模型、配额、审计从第一天就按对外服务设计）。

架构核心是五个分层加一条铁律：领域层不得依赖框架，集成层不得反向依赖领域层。这条规则换来两个能力 —— 模块变热时可以整块搬成独立服务（同语言零重写），以及接新外部系统只加一个目录。详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

**外部系统不在本项目内。** 与外部系统之间只有集成层适配器这一条通路，见 [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md)。

## 技术栈

| 用途 | 选型 |
| --- | --- |
| 框架 | Next.js 16（App Router） |
| UI | React 19 + shadcn/ui + Tailwind CSS 4 |
| 语言 | TypeScript 5.9（不用 7.x） |
| 数据库 | PostgreSQL（自托管） |
| ORM | Drizzle ORM + drizzle-kit |
| 缓存 / 队列 | Redis + BullMQ |
| 鉴权 | Better Auth |
| 校验 | Zod |
| 接口数据 | TanStack Query + TanStack Table |
| 包管理 | pnpm workspace |
| 部署 | Docker Compose（单机，机房在境外） |
| 对象存储 | S3 兼容 API（开发 MinIO / 生产 Cloudflare R2） |

完整版本号与选型理由见 [`AGENTS.md`](AGENTS.md) 第 5 节。M1 与 M2 从 npm registry 实查后固化下来的版本记在 [`docs/CHANGELOG.md`](docs/CHANGELOG.md) 的对应里程碑节；M2 新增的是 BullMQ 6.3.11 / ioredis 6.0.0 / `@vitest/coverage-v8` 5.0.2 / `tsx` 4.23.15 / TanStack Query 5.104.1 / Table 9.2.4，**recharts 仍未安装**（它的用途是后台看板，属 M5）。

## 目录结构

```text
apps/web/app/(site)        公开页
apps/web/app/(console)     登录后的用户控制台
apps/web/app/(admin)       后台管理
apps/web/app/api           Route Handlers
apps/web/components        共享 UI 与响应式原语
apps/web/features          按模块组织
apps/web/worker            队列消费者的进程入口（独立进程）
packages/core              领域层：纯 TypeScript
packages/integrations      集成层：一个外部系统一个目录
packages/db                数据层
packages/platform          auth / cache / queue
packages/shared            通用工具与类型
packages/config            共享配置
docs/  docker/  scripts/  .github/workflows/  Temp/
```

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | 强制约束：分层铁律、红线、目录约定、文档纪律 |
| [`docs/PRD.md`](docs/PRD.md) | 做什么、不做什么、每模块验收标准、待决问题 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 分层、部署拓扑、并发策略、数据模型分区、容量数字 |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | M0–M7 里程碑与退出标准 |
| [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) | 外部系统集成契约与适配器约定 |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | 表、字段、索引、迁移纪律与「这张表是谁的」约定 |
| [`docs/TESTING.md`](docs/TESTING.md) | 四档验证各验什么、覆盖率门槛、集成测试形态、手工回归步骤 |
| [`docs/DESIGN.md`](docs/DESIGN.md) | 设计系统基线：token、字体、玻璃层次、动效、共享组件契约与已知债务 |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | 改了什么：按里程碑追加，含实查后的依赖版本 |

尚未建立的文档（按需补齐）：`docs/API.md`、`docs/SECURITY.md`、`docs/DEPLOYMENT.md`、`docs/ADR/`。

## 本地开发

提交级检查（在仓库根执行，均已实跑通过）：

```bash
pnpm install       # 安装依赖；pnpm-lock.yaml 已入库，CI 用 --frozen-lockfile
pnpm lint          # ESLint，含分层铁律
pnpm typecheck     # tsc --noEmit，再对各 workspace 跑 typecheck
pnpm test          # Vitest
pnpm format        # Prettier 写入
pnpm format:check  # Prettier 检查（Markdown 不参与，见 .prettierignore）
```

PR 级端到端（需要本地 Postgres 与 Redis 都已启动、迁移已跑过 —— 夹具走真实注册编排，而注册链路依赖队列；Playwright 的浏览器二进制装在仓库内 `Temp/cache/ms-playwright`，首次要先 `pnpm exec playwright install chromium`）：

```bash
pnpm --filter @xsu/web test:e2e   # 先 next build 再 next start，桌面 1280px 与移动 360px 两套视口
```

本地依赖服务（需要 Docker；compose 的 `postgres` 与 `redis` 两个服务都已实际启动过 —— postgres 跑过迁移，redis 已被 worker 真实消费）：

```bash
Copy-Item docker/.env.example docker/.env   # 先填 POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
docker compose -f docker/docker-compose.yml up -d
```

Compose 不给这三个变量任何默认值：缺失时直接报错，避免用弱口令把库起起来。

应用本体还需要仓库根的一个 `.env`：字段清单见入库的 `.env.example`，必填项缺失时服务端启动即报错（不给默认值）。本机 `.env` 由 `.gitignore` 排除，不入库。

应用本体已经有脚本：`pnpm --filter @xsu/web dev` / `build` / `start` / `worker` / `typecheck` / `test:e2e`；仓库根的 `pnpm typecheck` 已经把它们串进来。队列消费者用 `pnpm --filter @xsu/web worker` 单独起（独立进程，不监听端口），手工回归步骤见 [`docs/TESTING.md`](docs/TESTING.md) 第 5 节。

远端仓库是 <https://github.com/xiaosu7788/xsu-cloud>，默认分支 `main`；推送需要显式走本地代理，见 [`AGENTS.md`](AGENTS.md) 已知债务。

## 怎么验证

- 本文件的「当前状态」一节必须反映真实情况。能力落地后立刻改写，不允许挂着过期状态。
- 文档索引里的每个链接必须可达。链接失效即为缺陷。
- 「本地开发」里的每条命令必须实际跑得通；命令与结果不一致时改命令或删命令，不许留未验证的命令。

## 已知债务

- 文档描述的系统**大部分还不存在**：M1 与 M2 的代码已落地，两批共六条退出标准由 `pnpm test`、`pnpm --filter @xsu/web test:e2e` 与 `docs/ARCHITECTURE.md` 第 8 节的真实数字守住（都可重跑，CI 上跑）；除这六条之外的业务验收标准仍属承诺而非证据。
- 工程侧的未验证项（真实 SMTP 投递、OAuth 回调、「杀掉 Redis 后任务不丢」没有实测）与推送所需的网络条件集中记在 [`AGENTS.md`](AGENTS.md)「已知债务」；此处不重复。
- Markdown 不参与 Prettier 检查（见 `.prettierignore`），格式靠人工维持。
- `docs/PRD.md` 第 5 节仅剩「机房位置」一项待决；OAuth 提供方与账号关联策略已定，并在 M1 按该结论实现（不自动关联账号、绑定须已登录后主动发起），但本机没有提供方凭证，该流程尚无运行时验证。
