# SPEC-admin — 后台管理（M5）

本文件是后台管理的可执行规格：范围、数据模型、领域规则、失败码、防自锁、幂等与配额覆盖语义、验收到哪一步。
范围与验收标准来自 [`PRD.md`](../PRD.md)，里程碑定义见 [`ROADMAP.md`](../ROADMAP.md) M5；
社区侧的审核样板见 [`SPEC-community.md`](SPEC-community.md)。冲突时以本文件为准并立刻改它。

## 1. 做什么

`(admin)` 分区在既有 `/admin/reports` 之外新增六个页面：

| 页面 | 路由 | 能做什么 |
| --- | --- | --- |
| 后台概览 | `/admin` | 用户 / 帖子 / 评论 / 待处理举报 / 任务运行的计数总览（读聚合，无操作） |
| 用户管理 | `/admin/users` | 搜索（邮箱 / 名称子串）、改角色、封禁、解封 |
| 内容管理 | `/admin/content` | 帖子与评论全状态列表（含已下架 / 已删除）、下架、恢复 |
| 任务管理 | `/admin/tasks` | `tool_runs` **只读**统计与最近运行列表 |
| 站点配置 | `/admin/config` | 发文 / 评论 / 工具三项每小时配额的站点级覆盖 |
| 审计日志 | `/admin/audit` | 全站审计行倒序列表（只读） |

**不做**：任务重试与取消（M6 任务语义）、成本看板（成本数据源在 M4/M6，`/admin/tasks` 只放占位说明）、
标签改名 / 合并 / 计数榜（等真需求加迁移）、配额以外的站点配置（Better Auth 限流与 `tool_run_retention_days` 维持 env）。

## 2. 数据模型（迁移 `0003_admin_tables.sql`）

### 2.1 `user` 表新增两列（封禁自研，不引 Better Auth admin 插件）

| 列 | 类型 | 语义 |
| --- | --- | --- |
| `banned_at` | `timestamptz` null | 非空即被封禁；封禁时间与操作者在审计行里 |
| `ban_reason` | `text` null | 封禁理由；长度上限 `BAN_REASON_MAX`（领域层） |

登录拦截走 `databaseHooks.session.create.before`：按 `session.userId` 现查 `user.banned_at`，
非空 → 返回 `false` 阻断会话创建。**封禁事务内同时删除该用户全部 `session` 行**。
本项目不开 cookieCache，角色与封禁每请求见库，解封与降权立即生效。

### 2.2 `site_config` 单例行（新表，`schema/admin.ts`）

| 列 | 类型 | 语义 |
| --- | --- | --- |
| `id` | `integer` PK，`CHECK (id = 1)` | 永远只有一行 |
| `post_quota_per_hour` | `integer` null | null = 不覆盖；0 = 关闭；≤ 1,000,000 |
| `comment_quota_per_hour` | `integer` null | 同上 |
| `tool_quota_per_hour` | `integer` null | 同上 |
| `updated_by` | `text` FK → `user.id` ON DELETE SET NULL | 最后改动者 |
| `updated_at` | `timestamptz` not null default now() | 最后改动时间 |

CHECK 约束：三列各自 `(col IS NULL) OR (col >= 0 AND col <= 1000000)`。

### 2.3 审计日志的目标类型扩展

`audit_logs.target_type` 由 `('post','comment')` 扩为 `('post','comment','user','site_config')`：
迁移里 DROP 旧 `audit_logs_target_type_check` 再 ADD 新的；drizzle-kit 生成后**必须手工核对**这条变更
（drizzle 对 check 变更的表达不完整）。schema 侧新增导出 `AUDIT_TARGET_TYPES`，
`AuditLogListItem.targetType` 类型随之放宽。审计仍只追加（触发器不动）。

## 3. 领域层规则（`packages/core/src/admin/`）

入口六组，端口注入（同 `community/`、`tools/` 的写法）。管理员判定复用 `ADMIN_ROLE` 与
`decideAdminAccess`（未登录 `UNAUTHENTICATED`，非管理员 `FORBIDDEN`，**每个入口第一步**）。

- **`updateUserRole`**：① 管理员 → ② **禁止改自己**（`selfRoleChange`）→ ③ 用户存在（`userNotFound`）
  → ④ 已在目标角色 → 幂等 `ok, changed:false`（**不写审计行**）→ ⑤ 最后 admin 保护：事务内条件
  `UPDATE ... WHERE id=$1 AND ($2='admin' OR EXISTS(SELECT 1 FROM "user" o WHERE o.role='admin' AND o.id<>$1))`
  → 0 行回读区分 `userNotFound` / `lastAdmin` → ⑥ 同事务写审计 `user.role.update`。
- **`banUser` / `unbanUser`**：① 管理员 → ② **禁止封自己**（`selfBan`）→ ③ 存在性 + 状态判定：
  已封禁再封 = 幂等 `changed:false`；未封禁解封 = 幂等 `changed:false`（均不写审计行）→
  ④ 事务：条件 `UPDATE user SET banned_at=now(), ban_reason=? WHERE id=? AND banned_at IS NULL AND (最后 admin 保护同上)`
  + `DELETE FROM session WHERE user_id=?` + 审计 `user.ban` / 解封是
  `UPDATE ... SET banned_at=NULL, ban_reason=NULL WHERE id=? AND banned_at IS NOT NULL` + 审计 `user.unban`
  → 0 行回读区分 `userNotFound` / `lastAdmin`。
- **`adminTakedownPost` / `adminRestorePost`**：管理员 + 帖子存在（含软删行，读详情不过滤）；
  已下架再下架 / 未下架再恢复 = 幂等；下架 = 置 `deleted_at` + 审计 `admin.post.takedown`；
  恢复 = 清 `deleted_at`（**父帖已删时评论不得恢复**，`parentPostDeleted`）+ 审计 `admin.post.restore`。
- **`adminTakedownComment` / `adminRestoreComment`**：同上形状，动作 `admin.comment.takedown` / `admin.comment.restore`。
- **`updateSiteConfig`**：管理员 → 校验（null / 0..1000000）→ upsert `site_config`（`ON CONFLICT (id) DO UPDATE`）+ 审计 `site.config.update` 同事务。
- **只读组**：`getAdminOverview`（计数聚合）、`listUsersForAdmin`（搜索 + 偏移分页）、
  `listPostsForAdmin` / `listCommentsForAdmin`（全状态 + 偏移分页）、`listToolRunStats`（只读统计）、
  `listAuditLogsForAdmin`。只读入口同样第一步判管理员。

**幂等语义（文档化）**：目标已处于目标状态（已在目标角色 / 已封禁 / 已下架等）返回成功且
`changed:false`，**不写审计行**——审计记录的是「发生了变化」这件事。

**审计单一写入路径**：所有审计行只能由领域入口经端口 `appendAuditLog` 写，仓储事务模板同
`resolveReport`（条件 UPDATE + INSERT audit_logs 同事务）。

### 3.1 失败码表（`ADMIN_FAILURE`，全站唯一来源）

`notAdmin` / `userNotFound` / `selfRoleChange` / `selfBan` / `lastAdmin` / `postNotFound` /
`commentNotFound` / `parentPostDeleted` / `inputInvalid`。

每个都有稳定 `code`、中文 `message`、HTTP `status`（401 / 403 / 404 / 400 / 500），形状与
`CONTENT_FAILURE` / `TOOL_FAILURE` / `ACCESS_DENIED` 一致，不造第二套。

## 4. 配额覆盖语义

生效优先级：**`site_config` DB 覆盖 > env 默认 > core 常量**。

- 读取点在 `packages/platform`：`resolveQuotaOverrides(db, env)` 返回三项有效值，每次
  `createCommunityPorts` / `createToolPorts` 构造时现读（配置变更对下一次请求生效，可接受）。
- **工厂因此改为异步**（返回 `Promise`），apps 内全部调用点补 `await`。
- core 端口契约不变：网关上的配额仍是同步数值属性，覆盖发生在装配层。

## 5. 页面与反馈

- 守卫：`readAdminAccess()` 每页自守（布局守直接访问，内跳可能复用缓存布局段）。
- 反馈：Server Action 返回 void + `redirect('./?ok=…' / '?error=…')`，页面读 `searchParams`
  渲染横幅（复用 M3 reports 页模式），不引入客户端组件。
- 导航：`(admin)/layout.tsx` 的 `ADMIN_NAV_ITEMS` 增加六项（lucide 图标）。

## 6. 验收与测试

对应 ROADMAP M5 四条退出标准：

1. **敏感操作有审计行**：领域层单测逐动作断言（角色 / 封禁 / 解封 / 帖子与评论下架恢复 / 配置）；
   e2e 走真实库断言 `audit_logs` 出现对应 action。
2. **审计无 UPDATE/DELETE 路径**：触发器继续存在（迁移核对断言），仓储无 update/delete 审计的代码路径；
   `listAuditLogsForAdmin` 只读。
3. **越权被领域层拒绝且有测试**：`decideAdminAccess` 单测（未登录 / 非管理员）；每个写入口第一步的
   管理员判定都有单测；e2e 非管理员访问六个新页面得统一拒绝视图（`admin-access.spec.ts` 的
   `GUARDED_PATHS` / `ADMIN_PATHS` 数组随新页扩充）。
4. **公开页静态化不受影响**：`static-render.spec.ts` 继续守住（后台全部动态，属预期）。

**防自锁有专项测试**：最后一个 admin 无法被降权 / 封禁（`lastAdmin`），不能改自己的角色 / 封禁自己
（`selfRoleChange` / `selfBan`）。e2e 封禁目标用 `e2e-other@example.com`，跑完解封保持幂等。

**as-built（2026-10-05 实测）**：`pnpm test` 11 个文件 161 个用例全过（`admin.test.ts` 21 例），`src/admin` 覆盖率 98.41 / 96.92 / 96.42 / 98.4（行 / 分支 / 函数 / 行），未覆盖分支为 `content.ts` 158、177 与 `rules.ts` 139 的防御分支。`pnpm --filter @xsu/web test:e2e` 93 个用例 87 passed / 6 skipped / 0 failed（跑的是生产构建 + 真实库）。迁移实跑后库里 13 张表含 `site_config`，`pnpm db:check` 无 drift；`pg_trigger` 复核 `audit_logs` 上 `append_only` 与 `no_truncate` 两枚触发器仍在。

## 7. 已知债务

- `audit_logs` 目标无外键（多态），`user` 删除会级联掉以其为 target 的审计行——与 M3 同一取舍。
- 配额覆盖每次网关构造现读 DB，高频路径多一次查询；可接受（构造点不在请求热路径的每次
  `getAuth` 上，而在端口装配点）。
- 会话失效依赖 cookieCache 关闭 + 封禁事务删行；若未来开启 cookieCache 必须重估封禁即时性。
- 成本看板占位在 `/admin/tasks`，M4/M6 落数据源后回填。
