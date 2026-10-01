# xsu-cloud

个人云站：中转站入口 · 社区 · 工具箱 · 生图工作台 · 后台管理。

---

## ✅ 当前状态：M0 地基已落地，尚未写业务代码

仓库里已有可运行的工程骨架：pnpm workspace 与全部约定目录、`packages/config` 共享配置（eslint / tsconfig / tailwind）、分层铁律 ESLint 规则（含故意的失败用例）、提交级检查链（ESLint / Prettier / `tsc --noEmit` / Vitest）、CI 工作流，以及 `docker/` 本地 Postgres + Redis。

**没有任何业务代码**：`packages/*` 只有占位 `src/index.ts`。下一步是 **M1（鉴权与设计系统）**，见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。

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

完整版本号与选型理由见 [`AGENTS.md`](AGENTS.md) 第 5 节。版本号是规划期从 npm registry 实查的，实施时以当时的稳定版为准。当前真正落地的只有提交级工具链（Node 24 / TypeScript 5.9.3 / ESLint 10.11.0 / Prettier 3.9.9 / Vitest 5.0.2），其余仍为规划选型。

## 目录结构

```text
apps/web/app/(site)        公开页
apps/web/app/(console)     登录后的用户控制台
apps/web/app/(admin)       后台管理
apps/web/app/api           Route Handlers
apps/web/components        共享 UI 与响应式原语
apps/web/features          按模块组织
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

尚未建立的文档（按需补齐）：`docs/DATA-MODEL.md`、`docs/API.md`、`docs/TESTING.md`、`docs/SECURITY.md`、`docs/DEPLOYMENT.md`、`docs/ADR/`、`docs/CHANGELOG.md`。

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

本地依赖服务（需要 Docker；容器尚未实际启动验证过）：

```bash
Copy-Item docker/.env.example docker/.env   # 先填 POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
docker compose -f docker/docker-compose.yml up -d
```

Compose 不给这三个变量任何默认值：缺失时直接报错，避免用弱口令把库起起来。

应用本体还没有 `dev` / `build` 脚本，M1 引入 Next.js 后补。

远端仓库是 <https://github.com/xiaosu7788/xsu-cloud>，默认分支 `main`；推送需要显式走本地代理，见 [`AGENTS.md`](AGENTS.md) 已知债务。

## 怎么验证

- 本文件的「当前状态」一节必须反映真实情况。能力落地后立刻改写，不允许挂着过期状态。
- 文档索引里的每个链接必须可达。链接失效即为缺陷。
- 「本地开发」里的每条命令必须实际跑得通；命令与结果不一致时改命令或删命令，不许留未验证的命令。

## 已知债务

- 文档描述的系统**大部分还不存在**：除提交级工具链与 Compose 定义外，所有验收标准都未经执行，属于承诺而非证据。
- 工程侧的未验证项（Compose 未 `up`、覆盖率工具未接入）与推送所需的网络条件集中记在 [`AGENTS.md`](AGENTS.md)「已知债务」；此处不重复。
- Markdown 不参与 Prettier 检查（见 `.prettierignore`），格式靠人工维持。
- `docs/PRD.md` 第 5 节仅剩「机房位置」一项待决；OAuth 提供方与账号关联策略已定，但尚无任何实现。
- 尚未决定是否启用外部文档流水线工具链对 `AGENTS.md` 的托管区块，见 `docs/ROADMAP.md` M0 待办。
