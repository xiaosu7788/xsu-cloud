# DATA-MODEL — xsu-cloud

本文件回答「有哪些表、字段是什么、索引为什么这么建、迁移怎么走」。

分层职责见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 第 2 节；模块范围与验收见 [`PRD.md`](PRD.md)。本文档只描述**本项目的自有数据**——外部系统的数据不在本库，见 [`INTEGRATIONS.md`](INTEGRATIONS.md) 第 1 节。

**唯一事实来源是 `packages/db/src/schema/` 下的 TypeScript 定义。** 本文件与代码不一致时，以代码为准并立刻改本文件。

---

## 1. 全局约定

| 约定 | 取值 | 理由 |
| --- | --- | --- |
| 数据库 | PostgreSQL（自托管） | 见 [`../AGENTS.md`](../AGENTS.md) 第 5 节 |
| schema | 只用 `public`，不建第二 schema | 单机单库，多 schema 只增加心智负担 |
| 表名 | 复数 snake_case（`invites`、`user` 例外） | `user`/`session`/`account`/`verification` 是 Better Auth 的固定表名，不得改名 |
| 列名 | snake_case | SQL 侧习惯 |
| TypeScript 属性名 | camelCase | Better Auth 的 adapter 按属性名访问，两边不一致会静默取不到值 |
| 主键 | `text`，非自增整数 | id 由应用层生成，避免迁移与合并时依赖序列 |
| 时间列 | `timestamp with time zone`，写到秒以下 | 服务器时区可能变；带时区才没有「本地时间还是 UTC」的歧义 |
| 迁移文件 | 提交进仓库（`packages/db/migrations/`） | 见第 5 节 |

### 1.1 归属约定（红线 6）

`AGENTS.md` 红线 6 要求**每张业务表都必须能回答「这是谁的」**。本表的含义：

- 有 `user_id` 外键 → 归属该用户，跨用户访问必须在领域层拒绝（`packages/core`），并且有测试覆盖。
- 表本身就是用户主体（`user`）→ 归属自身。
- 既不归属用户、也不含用户数据（`verification`）→ 必须在下面逐表说明「为什么不算业务表」。

新增业务表时如果既没有 `user_id` 也不属于上述例外，**说明建模有问题**，不要靠加一句注释绕过去。

---

## 2. 表清单

| 表 | 归属 | 引入里程碑 | 状态 |
| --- | --- | --- | --- |
| [`user`](#31-user) | 自身即主体 | M1 | 已建（迁移 `0000`） |
| [`session`](#32-session) | `user_id` | M1 | 已建（迁移 `0000`） |
| [`account`](#33-account) | `user_id` | M1 | 已建（迁移 `0000`） |
| [`verification`](#34-verification) | 无（见 3.4 说明） | M1 | 已建（迁移 `0000`） |
| [`invites`](#35-invites) | `used_by` / `created_by` | M1 | 已建（迁移 `0000`） |
| [`tool_runs`](#36-tool_runs) | `user_id` | M2 | 已建（迁移 `0001`） |
| [`tool_favorites`](#37-tool_favorites) | `user_id` | M2 | 已建（迁移 `0001`） |

---

## 3. 逐表说明

### 3.1 `user`

定义：`packages/db/src/schema/auth.ts`。Better Auth 的用户表名固定为单数 `user`，不改成 `users`。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 由 Better Auth 生成 |
| `name` | text | not null | 显示名 |
| `email` | text | not null, unique | 登录标识 |
| `email_verified` | boolean | not null, default `false` | 邮箱验证状态；`false` 的用途见 3.4 |
| `image` | text | nullable | 头像地址 |
| `role` | text | not null, default `'user'` | 取值见下 |
| `created_at` / `updated_at` | timestamptz | not null, default `now()` | — |

**`role` 的取值**由 `ROLES = ['user', 'admin'] as const` 定义，领域层从 `@xsu/db/schema` 导入后复用它（`packages/core/src/access.ts` 的 `Role`）。**不要在别处再写一份角色列表**，也不要写 `'admin'` 字面量——领域层导出了 `ADMIN_ROLE` 常量。

**提升为 `admin` 只能由管理员在后台操作，且必须写审计日志**（红线 8）。M1 不做后台改角色的界面，首个管理员用脚本直接改库（见第 5.3 节）。

### 3.2 `session`

定义：`packages/db/src/schema/auth.ts`。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | — |
| `token` | text | not null, unique | 会话令牌 |
| `expires_at` | timestamptz | not null | 过期时间 |
| `ip_address` | text | nullable | 来源 IP |
| `user_agent` | text | nullable | 来源 UA |
| `user_id` | text | not null, FK → `user.id` ON DELETE CASCADE | 归属 |
| `created_at` / `updated_at` | timestamptz | not null, default `now()` | — |

索引：`session_user_id_idx (user_id)`——按用户列出/吊销会话。

**PRD 3.6 验收 4 要求「角色变更后权限立即生效」。** 实现上依赖两件事，改任一件都要重读本节：

1. 授权判定**每次请求从数据库读 `user.role`**，不把角色写进会话 cookie。把角色放进 cookie，就等于在 cookie 有效期内给用户一个旧值。
2. 会话失效与退出登录靠删除 `session` 行生效。

### 3.3 `account`

定义：`packages/db/src/schema/auth.ts`。**这是「登录方式」表，不是「第三方资料」表**：邮箱密码路径也在这里，密码散列放在 `password` 列。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | — |
| `account_id` | text | not null | 该提供方侧的用户标识 |
| `provider_id` | text | not null | 提供方标识（`credential` / `github` / `linuxdo`） |
| `user_id` | text | not null, FK → `user.id` ON DELETE CASCADE | 归属 |
| `access_token` / `refresh_token` / `id_token` | text | nullable | 第三方令牌 |
| `access_token_expires_at` / `refresh_token_expires_at` | timestamptz | nullable | — |
| `scope` | text | nullable | 授权范围 |
| `password` | text | nullable | 邮箱密码路径的散列；OAuth 行为 null |
| `created_at` / `updated_at` | timestamptz | not null, default `now()` | — |

索引：`account_user_id_idx (user_id)`、`account_provider_idx (provider_id, account_id)`。

**`account_provider_idx` 不是普通查询索引，它是「不自动关联」这条决策的落点。** PRD 第 2 节决策 10：OAuth 首次登录一律创建新账号，不按邮箱合并；绑定必须由已登录用户主动发起。所以登录时按 `(provider_id, account_id)` 精确查绑定关系，命中就登录、不命中就走「拒绝或新建」分支，**任何路径都不允许按 `email` 找本地用户**。这个索引保证该查询走索引而不是全表扫。

**反向操作**：解绑必须存在（`INTEGRATIONS.md` 第 7 节），且只在该用户还有其它登录方式时允许——否则用户会被锁在账号外。这条规则属于领域层，落在 `packages/core`。

### 3.4 `verification`

定义：`packages/db/src/schema/auth.ts`。邮箱验证、找回密码等一次性令牌的落盘处。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | — |
| `identifier` | text | not null | 令牌的作用对象（通常是被验证的邮箱） |
| `value` | text | not null | 令牌值 |
| `expires_at` | timestamptz | not null | — |
| `created_at` / `updated_at` | timestamptz | not null, default `now()` | — |

索引：`verification_identifier_idx (identifier)`。

**为什么它不算违反红线 6**：这张表不含用户内容，只存在短期一次性令牌，且令牌由本人持有的邮箱/链接决定归属；它也没有跨用户读取的入口。**但它不能作为先例**——任何承载用户产出的表都必须带 `user_id`。

**写入者只有 Better Auth。** 本项目的业务代码不直接读写这张表；需要令牌语义时用 Better Auth 的 plugin，不要自己往这里插行。

### 3.5 `invites`

定义：`packages/db/src/schema/invites.ts`。邀请码注册准入（PRD 3.6）。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | — |
| `code` | text | not null, unique | 邀请码本体，**大小写敏感** |
| `created_by` | text | FK → `user.id` ON DELETE SET NULL | 发放者；首个管理员用脚本建码时为 null |
| `used_by` | text | FK → `user.id` ON DELETE SET NULL | 使用者；未使用时 null |
| `used_at` | timestamptz | nullable | 使用时间；未使用时 null |
| `expires_at` | timestamptz | nullable | **null 表示不过期** |
| `created_at` | timestamptz | not null, default `now()` | — |

索引：`invites_used_by_idx (used_by)`。

三条必须一起看的规则：

1. **`used_by` 与 `used_at` 必须同时有值或同时为空。** 只给一个是脏数据。领域层把脏数据当「不可用」处理（fail closed），不猜「大概还没用」就放行。判定在 `packages/core/src/invites.ts` 的 `isInviteCorrupted`。
2. **一次性必须靠原子消费，不能靠「先查后写」。** 并发下「查完发现没用 → 两个请求都去写」会放出两个用户。消费用一条带条件的写完成 compare-and-set：

   ```sql
   UPDATE invites
      SET used_by = $1, used_at = now()
    WHERE code = $2
      AND used_by IS NULL
      AND used_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
   RETURNING id;
   ```

   返回 0 行就是没抢到，直接拒绝注册。**顺序必须是「先原子消费成功，再创建用户」**——反过来会在失败时留下一个没有邀请码来源的账号。仓储实现在 `packages/db`，纯判定在 `packages/core`。
3. **大小写敏感，只裁首尾空白。** 用户从聊天窗口复制的码常带空格或换行，裁掉；但不做大小写归一，否则等于偷偷扩大了码空间。归一函数：`normalizeInviteCode`。

`code` 的生成与发放方式：脚本手动发放（见 5.3 节）。**不提供公开的邀请码申请入口。**

### 3.6 `tool_runs`

定义：`packages/db/src/schema/tools.ts`。工具箱的运行历史（PRD 3.3），一次执行一行。**失败也落一行**——否则「用户说失败了但我查不到」无法回答。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 由应用层生成 |
| `user_id` | text | not null, FK → `user.id` ON DELETE CASCADE | 归属（红线 6） |
| `tool_slug` | text | not null，**无外键** | 工具标识，见下第 1 条 |
| `status` | text | not null, CHECK `in ('succeeded','failed')` | 取值来自 `TOOL_RUN_STATUSES` |
| `error_code` | text | nullable | 失败时的稳定错误码（`TOOL_FAILURE[*].code`）；成功为 null |
| `input_bytes` | integer | not null | 输入原文字节数；**敏感输入也存长度**，长度不是内容 |
| `output_bytes` | integer | nullable | 输出字节数；失败或工具无输出时为 null |
| `duration_ms` | integer | not null | 领域层计时：从进入 `runTool` 到产出结果 |
| `input_summary` | text | nullable | 截断后的输入预览；敏感工具为「字段名清单」 |
| `output_summary` | text | nullable | 截断后的输出预览；敏感工具为 null |
| `created_at` | timestamptz | not null, default `now()` | 由领域层传入同一时间点，配额窗口与页面展示共用 |

索引与约束：`tool_runs_user_created_idx (user_id, created_at)`；`tool_runs_status_check`。

四条必须一起看的规则：

1. **`tool_slug` 没有外键。** 工具目录不在数据库里：一个工具 = 元数据 + 一个纯函数，在 `packages/core/src/tools/registry.ts` 注册。所以删掉一个工具不会级联清理它的历史与收藏，**写入前必须由领域层校验 slug 在注册表里**（`isRegisteredToolSlug`）。取舍与代价见 [`spec/SPEC-tools.md`](spec/SPEC-tools.md) 第 2 节。
2. **不存原始输入输出，只存摘要。** 预览由 `buildRunSummary` 统一截断：输入 120 字符、输出 500 字符（`TOOL_RUN_INPUT_PREVIEW_CHARS` / `TOOL_RUN_OUTPUT_PREVIEW_CHARS`）。标记为 `sensitive` 的工具（`base64`、`hash`）连预览都不存——`input_summary` 只留字段名清单，`output_summary` 为 null。运行历史是「回看」用的，不是「重放」用的。这是 PRD 3.3 验收 2「不记录敏感内容」的落点。
3. **状态取值在两处同时约束。** 领域层用 `TOOL_RUN_STATUSES` 做类型，数据库用 `tool_runs_status_check` 兜底。加状态时两处必须一起改，否则写入会被数据库拒绝——这是有意的，静默写入未知状态更糟。
4. **归属判定在领域层，管理员也不放行。** `decideToolRunAccess` 只放行业主本人；PRD 3.3 验收 4「只能看到自己的运行历史」由此保证，跨用户访问在领域层拒绝并有测试覆盖（`packages/core/tests/tools.test.ts`）。

保留期：`TOOL_RUN_RETENTION_DAYS_DEFAULT = 30` 天，由 worker 的 `maintenance.cleanup` 任务按天删除（`deleteToolRunsOlderThan`）。

### 3.7 `tool_favorites`

定义：`packages/db/src/schema/tools.ts`。工具收藏（PRD 3.3）。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 由应用层生成 |
| `user_id` | text | not null, FK → `user.id` ON DELETE CASCADE | 归属（红线 6） |
| `tool_slug` | text | not null，**无外键** | 同 3.6 第 1 条 |
| `created_at` | timestamptz | not null, default `now()` | — |

索引：`tool_favorites_user_tool_idx (user_id, tool_slug)`，**唯一**。

两条规则：

1. **取消收藏是删行，不是置标志位。** 收藏没有历史语义，留一行 `favorited: false` 只会让「我的收藏」查询多一个过滤条件。
2. **重复收藏靠唯一索引挡，不靠「先查再插」。** 后者在并发下会留下两行；仓储用 `ON CONFLICT DO NOTHING`（`addToolFavorite`）。

---

## 4. 索引

| 索引 | 表 | 列 | 服务的查询 |
| --- | --- | --- | --- |
| `session_user_id_idx` | session | `user_id` | 列出 / 吊销某用户的会话 |
| `account_user_id_idx` | account | `user_id` | 个人资料页列出该用户的登录方式 |
| `account_provider_idx` | account | `provider_id, account_id` | OAuth 登录时精确定位绑定关系（不自动关联，见 3.3） |
| `verification_identifier_idx` | verification | `identifier` | 校验一次性令牌 |
| `invites_used_by_idx` | invites | `used_by` | 按使用者反查邀请码来源 |
| `tool_runs_user_created_idx` | tool_runs | `user_id, created_at` | 一个索引服务两件事：运行历史列表（按用户取、时间倒序）与配额窗口计数（`WHERE user_id = ? AND created_at >= ?`），两者都是「先定用户再切时间」 |
| `tool_favorites_user_tool_idx` | tool_favorites | `user_id, tool_slug`（唯一） | 「我的收藏」列表；同时挡重复收藏（`ON CONFLICT DO NOTHING`），不靠「先查再插」 |

另外由 `unique` 约束隐式建出的唯一索引：`user.email`、`session.token`、`invites.code`。

**不建 `invites.code` 之外的邀请码索引**：`code` 的 unique 索引同时服务等值查询与原子消费的 `WHERE code = ...`。

---

## 5. 迁移

### 5.1 流程

```powershell
# 改 schema 后生成迁移（产物必须提交）
pnpm --filter @xsu/db db:generate

# 应用迁移
pnpm --filter @xsu/db db:migrate

# 校验迁移与 snapshot 一致
pnpm --filter @xsu/db db:check
```

配置在 `packages/db/drizzle.config.ts`（dialect `postgresql`、schema `./src/schema/index.ts`、out `./migrations`、`strict` + `verbose`）。`drizzle.config.ts` 从仓库根 `.env` 读 `DATABASE_URL`。

### 5.2 纪律

1. **迁移产物提交进仓库。** 生产**不跑 `db:push`**，只跑已提交的迁移——`push` 直接改库、无记录、不可回滚，等于放弃可审计性。
2. **已应用的迁移不得修改。** 改错就再加一条迁移。`migrations/meta/` 已进 `.prettierignore`，格式由 `db:generate` 决定，不手工排版。
3. **迁移只做结构变更，不做数据搬运。** 需要搬运数据的迁移必须单独成一条、写清回滚方式，并在 PR 里说明。
4. **本机 Postgres 映射到 5433**，不是 5432（5432 被本机另一个项目占用）。见 `docker/docker-compose.yml` 与 `docker/.env`。

### 5.3 脚本（一次性操作）

`scripts/` 下的一次性脚本，跑法随脚本头部注释：

| 脚本 | 用途 | 状态 |
| --- | --- | --- |
| `scripts/grant-admin.mjs` | 把指定邮箱提升为 `admin`（首个管理员的唯一来源） | **未建 —— M1 计划内但未兑现** |
| `scripts/create-invites.mjs` | 手动发放邀请码 | **未建 —— M1 计划内但未兑现**（目前发码只能直接改库，或照 `apps/web/e2e/` 的夹具插一行一次性码） |
| `scripts/enqueue-manual-jobs.ts` | 手工把一条 `mail.send` 与一条 `maintenance.cleanup` 塞进 Redis 队列，配合 `pnpm --filter @xsu/web worker` 做队列与清理任务的手工回归 | 已建（M2） |

脚本直接连库，**不经过应用**，所以每次执行都会被记录在操作者自己的终端历史里；这不是审计日志，审计日志要求见红线 8，细则见 `docs/SECURITY.md`（**尚未创建**）。

---

## 怎么验证

- **迁移与 schema 一致**：`pnpm --filter @xsu/db db:check` 通过（无 drift）。
- **迁移可应用**：实跑 `pnpm --filter @xsu/db db:migrate`，随后
  `docker exec xsu-postgres psql -U xsu -d xsu -c "\dt"` 应列出 `user` / `session` / `account` / `verification` / `invites`（迁移 `0000`）与 `tool_runs` / `tool_favorites`（迁移 `0001`）共七张表，且 `drizzle.__drizzle_migrations` 有对应记录。**M1 实跑通过（2026-10-01，5 张表齐）；M2 的 `0001_tools_tables.sql` 已在本机实跑生效。**
- **本文件与代码一致**：逐列对照 `packages/db/src/schema/*.ts` 与 `packages/db/migrations/*.sql`。不一致即缺陷，改本文件。
- **领域层规则**：邀请码、角色与工具判定都有测试覆盖 —— `packages/core/tests/` 5 个文件 89 例（invites 14、tools 39、accounts 13、registration 14、access 9）、`packages/platform/tests/` 3 个文件 28 例、分层铁律 12 例，合计 **9 个文件 129 例，`pnpm test` 全通过（已实跑）**。`packages/core` 分支覆盖率 98%（门槛 80%，见 `vitest.config.ts`）。
- **归属**：新增业务表时逐表检查第 1.1 节，缺 `user_id` 且不属例外即阻断。

## 已知债务

- **`role` 是自由文本列，没有数据库级取值约束。** 只有 `default 'user'`，写入非法值（如 `'root'`）数据库不会拒绝。当前靠领域层 fail closed（无法识别的角色按未登录处理），但**脏角色会让人困惑**。可选方案是加 `CHECK (role IN ('user','admin'))`，留到引入第二种角色的需求出现时一并做。
- **`invites.code` 没有长度与字符集约束。** 生成逻辑在脚本里，靠脚本自律。若将来开放到别处生成，需要加约束。
- **`user` 表没有 `deleted_at` / 软删除。** PRD 4.4 要求账号注销入口，实现时需决定是硬删还是软删，以及删除后 `invites.used_by` 等外键的处置（当前都是 `SET NULL`，会丢「码被谁用了」的信息）。
- **`session` 表无过期行清理（M2 已解决）。** 原状：过期会话不会被自动删除，只在校验时不通过。M2 起由 worker 的 `maintenance.cleanup` 任务每天 UTC 04:00 删除（`deleteExpiredSessions`，实现见 `packages/platform/src/maintenance.ts`），手工回归步骤见 `docs/TESTING.md` 第 5 节。
- **审计日志表尚未建。** 红线 8 要求的「只追加不更新」表结构未定，与后台管理（M3）一起设计。
- **本文件的表结构描述是手工维护的。** 没有从 schema 自动生成表结构的工具链，改 schema 时容易忘记同步本文件——这是本文档最主要的风险。
- **`tool_runs` 未分区、未归档。** 保留期（缺省 30 天）内的运行历史与收藏都在单表里，量级上来后按时间删除会变慢。M2 的规模下无所谓；等历史量真正成为瓶颈时再谈分区或归档，现在加是过度设计。

- **没有任何受支持的途径创建第一个管理员。** `scripts/grant-admin.mjs` 在 M1 的计划内但没建（见 5.3），M1 的端到端只验了「非管理员被拒」这一侧，从未真的产出一个 `admin` 账号。M3 要落 `(admin)` 后台，开工前必须先补这个入口。这是一条**会阻塞下一个里程碑**的债务，不是可选项。
