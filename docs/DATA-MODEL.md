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
| [`posts`](#38-posts) | `author_id` | M3 | 已建（迁移 `0002`） |
| [`comments`](#39-comments) | `post_id` / `author_id` | M3 | 已建（迁移 `0002`） |
| [`reactions`](#310-reactions) | `post_id` / `user_id` | M3 | 已建（迁移 `0002`） |
| [`reports`](#311-reports) | `reporter_id` / `handled_by` | M3 | 已建（迁移 `0002`） |
 | [`audit_logs`](#312-audit_logs) | `actor_id`（见 3.12 第 3 条） | M3 | 已建（迁移 `0002`） |
 | [`site_config`](#313-site_config) | 站点配置本体（见 3.13 第 3 条） | M5 | 已建（迁移 `0003`） |
| [`notifications`](#314-notifications) | `recipient_id` / `actor_id` | 社交批 | 已建（迁移 `0004`） |
| [`direct_messages`](#315-direct_messages) | `from_user_id` / `to_user_id` | 社交批 | 已建（迁移 `0004`） |
| [`dm_contacts`](#316-dm_contacts) | `owner_id` / `peer_id` | 社交批 | 已建（迁移 `0004`） |
| [`user_spaces`](#317-user_spaces) | `user_id` | 社交批 | 已建（迁移 `0004`） |
| [`user_stats`](#318-user_stats) | `user_id` | 社交批 | 已建（迁移 `0004`） |
| [`user_points`](#319-user_points) | `user_id` | 社交批 | 已建（迁移 `0004`） |
| [`point_transactions`](#320-point_transactions) | `user_id` | 社交批 | 已建（迁移 `0004`） |
| [`daily_checkins`](#321-daily_checkins) | `user_id` | 社交批 | 已建（迁移 `0004`） |
| [`user_achievements`](#322-user_achievements) | `user_id`（见 3.22 第 3 条） | 社交批 | 已建（迁移 `0004`） |
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
 | `banned_at` | timestamptz | nullable | 非空即被封禁，语义见下 |
 | `ban_reason` | text | nullable | 封禁理由；上限 `BAN_REASON_MAX`（领域层） |

**`role` 的取值**由 `ROLES = ['user', 'admin'] as const` 定义，领域层从 `@xsu/db/schema` 导入后复用它（`packages/core/src/access.ts` 的 `Role`）。**不要在别处再写一份角色列表**，也不要写 `'admin'` 字面量——领域层导出了 `ADMIN_ROLE` 常量。

 **提升为 `admin` 只能由管理员在后台操作，且必须写审计日志**（红线 8）。首个管理员用脚本直接改库（`scripts/grant-admin.ts`，见第 5.3 节）；此后的角色变更走 `/admin/users`（M5 领域入口 `updateUserRole`：禁止改自己、最后一个 admin 不可降权，见 [`spec/SPEC-admin.md`](spec/SPEC-admin.md) 第 3 节）。
 **封禁（M5）**：`banned_at` 非空即被封禁。拦截不在登录端点，而在 Better Auth 的 `databaseHooks.session.create.before`——每次会话创建现查 `user.banned_at`，非空即拒绝建会话（`packages/platform/src/auth.ts`）；封禁事务内同时删除该用户全部 `session` 行，已有会话即时下线，解封后需重新登录。判定与审计（`user.ban` / `user.unban`）在 `packages/core/src/admin/`；禁止封自己与「最后一个 admin 不可封禁」也在这一层挡下（`selfBan` / `lastAdmin`）。

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

### 3.8 `posts`

定义：`packages/db/src/schema/community.ts`。社区帖子（PRD 3.2），Feed / 标签页 / 搜索与详情页的数据源。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 由应用层生成（`ports.newId()`） |
| `author_id` | text | not null, FK → `user.id` ON DELETE CASCADE | 归属（红线 6）。作者删号 → 帖子级联硬删，其下评论随之消失 |
| `title` / `body` | text | not null | 长度由领域层校验（`validatePostInput`），数据库不重复约束 |
| `tags` | `text[]` | not null, default `'{}'` | 已归一化的小写标签数组（切分 → trim → 转小写 → 去重），GIN 索引的服务对象 |
| `created_at` / `updated_at` | timestamptz | not null, default `now()` | 领域层取 `ports.now()`，一次操作只取一次——配额窗口与落库必须是同一时间点 |
| `deleted_at` | timestamptz | nullable | **软删除标记**：作者删帖或管理员下架写它，行本身保留 |

索引：`posts_feed_idx (created_at, id) WHERE deleted_at is null`、`posts_author_idx (author_id, created_at)`、`posts_tags_idx` GIN（部分索引，同 feed）。

四条必须一起看的规则：

1. **翻页游标是 `(created_at, id)` 两列一起比，不是单列。** 只按 `created_at` 排序时，同一毫秒（或同一次批量写入）里的多行次序不稳定，翻页就会重复或漏行。`posts_feed_idx` 建成两列复合并在仓储里两列一起比（`repositories/community.ts` 的 `listPosts`），「连续翻页不重复不遗漏」（PRD 3.2 验收 1）靠的是这个组合，不是单列索引。列表行自带 `createdAt`，所以列表项可以直接当游标点用（`posts.ts` 的 `cursorOf`）。
2. **删除是软删除，读路径分层过滤。** 数据层的列表查询带 `WHERE deleted_at is null`（三个索引都用部分索引只收活行）；单条读取**不过滤** `deleted_at`——`getPostById` 返回带 `deletedAt` 的行。这样做是因为「这个 id 不存在」与「存在但已被删除 / 下架」是两件事：前者 404，后者渲染统一的拒绝视图（`schema/community.ts` 的 `PostDetail` 注释）。**写路径的门在领域层**：`loadVisiblePost`（`posts.ts`）把已删行挡回 `null`，评论、点赞、举报全部先过它，否则「已下架的内容还能被点赞 / 评论 / 举报」这条路就留着。
3. **发帖顺序是 校验 → 配额 → 写入，配额拒绝既不落行也不计数。** 落了行，「被拒 → 计数 +1 → 更容易被拒」会自我放大，把配额变成越试越紧的惩罚（`tools/run-tool.ts` 是同一条取舍）。配额窗口按 `countPostsSince` 计（作者维度走 `posts_author_idx`）；配额值来自配置（`ports.postQuotaPerHour`），数据库不存。
4. **标签在写入前归一化、去重。** `normalizeTags`（`rules.ts`）按中英文逗号、顿号与空白切分，trim 后转小写、按序去重——`TypeScript` / `typescript` / `TYPESCRIPT` 收敛成一个；个数上限按**去重之后**算（独立失败码 `tagLimitExceeded`，与「某字段写长了」分开报，表单才能提示「删掉多余的标签」）。浏览页的匹配用 `tags @> array[?]` 包含查询（走 GIN），搜索关键词则不转小写（`ILIKE` 本身不区分大小写）。

### 3.9 `comments`

定义：`packages/db/src/schema/community.ts`。帖子下的评论（PRD 3.2）。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 由应用层生成 |
| `post_id` | text | not null, FK → `posts.id` ON DELETE CASCADE | 帖子级联硬删（作者删号）时评论跟着消失 |
| `author_id` | text | not null, FK → `user.id` ON DELETE CASCADE | 归属（红线 6） |
| `body` | text | not null | 长度由领域层校验（`validateCommentInput`） |
| `created_at` / `updated_at` | timestamptz | not null, default `now()` | 同 3.8 |
| `deleted_at` | timestamptz | nullable | 软删除标记（作者删评论 / 管理员下架） |

索引：`comments_post_idx (post_id, created_at, id) WHERE deleted_at is null`、`comments_author_idx (author_id, created_at)`。

三条规则：

1. **评论排序与帖子相反：正序，最早的在前。** 详情页从上往下读，会话顺序就是时间正序；`comments_post_idx` 的三列 `(post_id, created_at, id)` 与该查询同序——先定位帖子、再按时间读、同刻用 `id` 定序防重漏（同 3.8 第 1 条）。游标格式与帖子共用一套（`paginate` 两边通用），方向由查询决定。
2. **发评论顺序是 目标帖子还在 → 校验 → 配额 → 写入。** 目标检查放在校验之前是故意的：对一篇已下架的帖子，无论正文写得对不对，结论都是「这篇帖子不存在或已被删除」，先判这个能让失败原因贴近用户实际看到的东西。配额（`commentQuotaPerHour`）同样「拒绝不落行不计数」（`types.ts` 文件头第 3 条）。
3. **删评论不影响帖子与其它缓存。** 作者删自己的评论走 `decideCommentAccess`（只有作者本人，管理员不经此路径）+ 软删除。M3 没有评论计数、列表页不展示评论数，所以没有需要跟着失效的缓存；数据层列表查询的 `WHERE deleted_at is null` 负责把已删评论挡在列表外（纵深防御，单条的门在 `loadVisibleComment`）。

### 3.10 `reactions`

定义：`packages/db/src/schema/community.ts`。点赞（PRD 3.2）。**没有 `id` 列**——一行点赞由「谁赞了哪个帖子」唯一决定，代理主键只给查询增加一个无意义的唯一值。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `post_id` | text | not null, 复合 PK 之一, FK → `posts.id` ON DELETE CASCADE | 帖子消失 → 点赞行无意义，级联清理 |
| `user_id` | text | not null, 复合 PK 之一, FK → `user.id` ON DELETE CASCADE | 归属（红线 6） |
| `kind` | text | not null, default `'like'`, CHECK `in ('like')` | M3 只有一种反应；单值 CHECK 把「将来加第二种」留成显式迁移，而不是静默写出第三种值 |
| `created_at` | timestamptz | not null, default `now()` | — |

约束：`reactions_pk PRIMARY KEY (post_id, user_id)`——就是并发防线本体（见下第 1 条）；`reactions_kind_check`。**无二级索引**：主键索引已覆盖「按帖子计数」与「按用户反查」两类查询。

三条规则：

1. **重复点赞不是错误，唯一主键就是并发防线。** 并发两次点赞的坏结果有两种：第二次拿到「已存在」报错（用户看到莫名失败），或计数被加两次（缓存要等 60 秒重建才修得回来，那 60 秒里数字是错的）。两道防线一起挡：数据层 `addReaction` 用 `ON CONFLICT DO NOTHING` 把冲突变成「什么都没发生」（`reactions_pk` 兜底，不靠「先查再插」）；仓储返回 `boolean` 告诉领域层**是否真的插入了行**，只有 `inserted === true` 才去 `ports.reactions.increment(post.id)` 改计数缓存（`reactions.ts` 的 `likePost`）。于是「点两次」的结果是 `liked: true` 且计数为 1，幂等语义与 PRD 3.2 验收 2 一致。取消侧同理：`removeReaction` 删 0 行时**不减**计数，否则「取消两次」会把别人的点赞数减掉。
2. **计数缓存只负责快，不负责正确。** 点赞数落在 Redis（`packages/platform/src/cache.ts`，TTL 60 秒）；未命中回数据库算一遍并回填，`increment` / `decrement` 遇到「键不存在」什么都不做——防止把从未回填过的键从 0 改成 ±1 写出脏数。失效（回库重算）是唯一写路径。缓存的六条行为断言有手工回归脚本：`scripts/verify-reaction-cache.ts`（提交级测试不起 Redis，纪律见 [`TESTING.md`](TESTING.md)）。
3. **自己的帖子也能点赞。** M3 不做限制（SPEC 第 4 节），点赞只过 `loadVisiblePost` 这一道「帖子还活着」的门。

### 3.11 `reports`

定义：`packages/db/src/schema/community.ts`。举报与审核（PRD 3.2）。**举报目标不设外键**：目标类型是 `post` / `comment` 二选一的多态引用，外键表达不了「按类型指向两张表之一」，目标存在性与存活由领域层判定（见下第 2 条）。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 由应用层生成 |
| `reporter_id` | text | not null, FK → `user.id` ON DELETE CASCADE | 归属（红线 6） |
| `target_type` | text | not null, CHECK `in ('post','comment')` | 多态目标类型，**无外键**，见上 |
| `target_id` | text | not null | 目标 id；同 `audit_logs.target_id` 的语义——目标被删后举报行必须还在，审核页不能丢线索 |
| `reason` | text | not null | 举报理由，长度由领域层校验 |
| `status` | text | not null, default `'open'`, CHECK `in ('open','takedown','dismissed')` | `open` = 待处理；两个终态由 `auditActionFor` 映射审计动作 |
| `created_at` | timestamptz | not null, default `now()` | — |
| `handled_by` / `handled_at` | text / timestamptz | nullable; `handled_by` FK → `user.id` ON DELETE **SET NULL** | 处理人 / 处理时刻；`handled_by` SET NULL——管理员删号后举报的处理事实仍在，只是没了处理人档案 |

约束与索引：`reports_target_type_check`、`reports_status_check`、`reports_handled_check ((status='open') = (handled_at is null))`；唯一部分索引 `reports_open_unique_idx (reporter_id, target_type, target_id) WHERE status='open'`、`reports_status_created_idx (status, created_at)`。

四条必须一起看的规则：

1. **举报不自动下架内容，必须有管理员确认路径。** `createReport` **不改任何内容状态**——举报后内容照旧可见，这是 PRD 3.2 验收 4 的原话。内容下架只发生在管理员 `confirmTakedown`，且与举报置终态、写审计行**同事务**（红线 8）：不允许出现「内容已下架、审计没落」。举报自身同样软删目标（`deleted_at`），内容行保留。
2. **目标存活与「同一人重复举报」都在领域层/索引层解决。** 举报前先过 `loadVisiblePost` / `loadVisibleComment`——目标 id 没有外键，存在性只能由领域层判，且不能举报一条已经看不见的内容（否则管理员确认下架时目标早就没了）。同一人对同一目标已有未处理举报时幂等返回既有那条（常见路径靠回读，并发兜底靠 `reports_open_unique_idx` + `ON CONFLICT DO NOTHING`，收敛流程见 `reports.ts` 的 `createReport` 注释）。
3. **`reports_handled_check` 把「状态与处理时刻」锁成一个不变量。** `status = 'open'` ⇔ `handled_at IS NULL`，两列不可能出现「已处理但没时刻」或「open 却带处理时刻」的中间态；两列由领域层在同一事务里一起写。
4. **管理队列只扫 `open`。** `listPendingReports` 走 `reports_status_created_idx`（先定状态再按时间排）；终态行不进队列但保留——「这条举报当时怎么处理的」靠它与 `audit_logs` 的关联回答。

### 3.12 `audit_logs`

定义：`packages/db/src/schema/community.ts`。管理操作的只追加审计（PRD 4.4 / 红线 8）。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 由应用层生成 |
| `actor_id` | text | not null, FK → `user.id` ON DELETE **CASCADE** | 操作者（管理员）。见下第 3 条 |
| `action` | text | not null，**无 CHECK** | 取值是代码字面量 `AUDIT_ACTION`（`report.takedown` / `report.dismiss`），见下第 1 条 |
| `target_type` | text | not null, CHECK `in ('post','comment')` | 被操作对象的类型 |
| `target_id` | text | not null | 被操作对象的 id，**无外键**——内容被级联硬删后审计行必须还在 |
| `detail` | text | nullable | 补充说明 |
| `created_at` | timestamptz | not null, default `now()` | 管理动作发生时刻 |

索引：`audit_logs_created_idx (created_at)`、`audit_logs_actor_idx (actor_id, created_at)`、`audit_logs_target_idx (target_type, target_id, created_at)`。

三条必须一起看的规则：

1. **「只追加」由触发器兜底，行级与语句级各挡一道。** `BEFORE UPDATE OR DELETE`（行级）与 `BEFORE TRUNCATE`（语句级）都抛异常——TRUNCATE 不触发行级触发器，漏掉它就留了一条清空审计的路。drizzle-kit 不表达触发器，这两段是迁移 `0002_community_tables.sql` 里的手写 SQL，`OR REPLACE` / `IF EXISTS` 保证迁移被手工重放时也成立。本机已实测：UPDATE / DELETE 均被拒绝（见「怎么验证」）。
 2. **`action` 不加 CHECK 是有意的。** 要记的动作只会越来越多，每加一个动作就写一条迁移是过度约束；取值唯一来源是 `@xsu/core` 的 `AUDIT_ACTION` 字面量表。M3 只有管理员处理举报的两个动作；M5 扩到角色变更、封禁 / 解封、帖子与评论下架 / 恢复、站点配置，`target_type` 的 CHECK 随之扩为 `('post','comment','user','site_config')`（迁移 `0003` 里 DROP 旧约束再 ADD——drizzle 对 CHECK 变更的表达不完整，这条是生成后手工核对的）。写审计与业务变更同事务的纪律不变（红线 8）。
3. **`actor_id` 级联、`target_id` 无外键，是审计语义的直接推论。** 管理员账号消失时其操作记录跟着走；而被下架的内容可能随作者删除被级联硬删（删帖 → 评论级联消失），审计行若跟着内容走就查不到「当初谁下的架」——审计的义务是留住管理动作，不是替内容续命。

 
 ### 3.13 `site_config`
 
 定义：`packages/db/src/schema/admin.ts`。站点级配额覆盖（M5）——**整张表永远只有一行**，`id` 固定为 1。
 
 | 列 | 类型 | 约束 | 说明 |
 | --- | --- | --- | --- |
 | `id` | integer | PK，CHECK `id = 1` | 单行由数据库 CHECK 保证，不靠文档约定 |
 | `post_quota_per_hour` / `comment_quota_per_hour` / `tool_quota_per_hour` | integer | nullable，各自 CHECK `is null or (>= 0 and <= 1000000)` | 三项每小时配额的站点级覆盖 |
 | `updated_by` | text | nullable, FK → `user.id` ON DELETE SET NULL | 最后改动者 |
 | `updated_at` | timestamptz | not null, default `now()` | 最后改动时间 |
 
 无二级索引：单行表，主键即全部。
 
 三条必须一起看的规则：
 
 1. **单行由 CHECK 约束保证。** `site_config_id_check` 让第二行插不进去；领域层 upsert 走 `ON CONFLICT (id) DO UPDATE`（动作 `site.config.update`），读侧 `resolveQuotaOverrides`（`packages/platform/src/quota.ts`）在网关装配点现读这一行，优先级 `site_config` 覆盖 > env 默认 > core 常量。
 2. **`null` = 不覆盖，`0` = 关闭，两者语义必须分开。** null 回落到 env 默认，0 是管理员显式关闭该动作——把 null 当 0 处理等于悄悄关站，这是覆盖列必须 nullable 而不是 default 0 的原因。`updated_by` 用 SET NULL：管理员删号后配置事实仍在，只是没了改动者档案（同 3.11 `handled_by` 的取舍）。
 3. **为什么它没有 `user_id` 却不算违反红线 6（1.1 节）**：它是站点配置本体，不含用户数据；「谁在何时把什么改成什么」由 `audit_logs`（action `site.config.update`，target_type `site_config`）回答，配置变更与审计行同事务落盘。

### 3.14 `notifications`

定义：`packages/db/src/schema/social.ts`。站内消息箱（社交批第 1 项）。范围与领域规则见 [`spec/SPEC-social.md`](spec/SPEC-social.md) 3.1 与 4.2。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 由应用层生成 |
| `recipient_id` | text | not null, FK → `user.id` ON DELETE **CASCADE** | 收件人；账号删除后通知无意义 |
| `category` | text | not null, CHECK `in ('system','site','social')` | 三档粗分类，决定消息箱的 tab |
| `type` | text | not null，**无 CHECK** | 细粒度动作标识（`post_comment` / `dm_message`…），取值持续增加，见下第 2 条 |
| `actor_id` | text | nullable, FK → `user.id` ON DELETE **SET NULL** | 触发者；系统通知为 null |
| `post_id` / `comment_id` | text | nullable, FK → `posts.id` / `comments.id` ON DELETE **CASCADE** | 社交类通知的跳转目标 |
| `link` | text | nullable | 站内路径，页面不必再拼 URL |
| `title` / `body` | text | nullable | 展示文案 |
| `dedup_key` | text | nullable | 幂等键（`post_like:<postId>:<actorId>`）；null = 不去重 |
| `read` | boolean | not null, default `false` | 已读位 |
| `created_at` | timestamptz | not null, default `now()` | — |

索引：`notifications_recipient_idx (recipient_id, read, created_at)`（未读角标 + 列表排序）、`notifications_recipient_category_idx (recipient_id, category, created_at)`（按分类筛选）、`notifications_dedup_unique_idx` **部分**唯一 `(recipient_id, dedup_key) WHERE dedup_key is not null`（幂等去重；部分索引把不去重的行排除，广播类可有任意多条）。

两条必须一起看的规则：

1. **幂等由唯一索引保证，不靠「先查再插」。** 并发下先查再插会重复；仓储把唯一冲突翻译成幂等结果（`ON CONFLICT DO NOTHING`）。谓词必须与查询写法一致，否则规划器用不上这条索引。
2. **`category` 与 `type` 是两层，别合并。** `category` 决定「在哪一栏看」，`type` 决定「用什么图标与文案」。`type` 不加 CHECK 的理由同 3.12 的 `action`：它只会越来越多，唯一来源是领域层常量。

### 3.15 `direct_messages`

定义：`packages/db/src/schema/social.ts`。一对一私信（社交批第 2 项）。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 由应用层生成 |
| `from_user_id` / `to_user_id` | text | not null, FK → `user.id` ON DELETE CASCADE | 发件人 / 收件人 |
| `body` | text | not null | 正文；长度上限在领域层（`validateMessageInput`） |
| `created_at` | timestamptz | not null, default `now()` | — |
| `read_at` | timestamptz | nullable | 收件人读这条的时间；null = 未读 |

索引：`direct_messages_from_to_idx (from_user_id, to_user_id, created_at)`、`direct_messages_to_from_idx (to_user_id, from_user_id, created_at)`（会话翻页两个方向各一条）、`direct_messages_unread_idx (to_user_id, read_at, created_at)`（未读数与会话列表）。

**已读只有一个 `read_at`，不建位点表。** 一对一场景一条消息只需要一个「收件人读了吗」，未读数 = `to_user_id = 我 AND read_at is null`。这是有意的收敛，加位点表只会多一处可能与事实不符的状态。

### 3.16 `dm_contacts`

定义：`packages/db/src/schema/social.ts`。私信关系（防骚扰的「先申请」门槛，社交批第 2 项）。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `owner_id` | text | not null, FK → `user.id` ON DELETE CASCADE | **收到**申请的人 |
| `peer_id` | text | not null, FK → `user.id` ON DELETE CASCADE | **发起**申请的人 |
| `status` | text | not null, CHECK `in ('request','accepted','declined')` | 三态，见下第 1 条 |
| `created_at` / `updated_at` | timestamptz | not null, default `now()` | — |

主键 `dm_contacts_pk (owner_id, peer_id)`；索引 `dm_contacts_owner_status_idx (owner_id, status)`（我收到的待处理申请）、`dm_contacts_peer_idx (peer_id, status)`（反查是否已有关系）。

两条必须一起看的规则：

1. **方向是有意的**：`owner_id` = 收件人、`peer_id` = 发起者。三态语义为 `request`（等待 `owner` 处理，`peer` 不能再发）、`accepted`（自由互发）、`declined`（`peer` 不能再发）。
2. **主键即并发防线。** 「一对人只有一条关系」由主键保证：并发发首条消息时，第二个请求会撞主键并被翻译成「等待对方同意」，不依赖先查后写。**三种免申请情形不落这张表**（收件人是管理员 / 收件人是自己 / 已有 `accepted`），在领域层判断。

### 3.17 `user_spaces`

定义：`packages/db/src/schema/social.ts`。个人空间的**展示设置**（社交批第 3 项）。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `user_id` | text | PK, FK → `user.id` ON DELETE CASCADE | 归属；一人一行 |
| `show_stats` / `show_posts` / `show_achievements` | boolean | not null, default `true` | 三个分区开关 |
| `motto` | text | nullable | 一句话签名；null / 空串 = 不显示 |
| `updated_at` | timestamptz | not null, default `now()` | — |

无二级索引：主键即全部查询路径。

**只落用户的选择，不落可推导的数据。** 帖子、积分、成就全部实时从各业务表算出来；这张表存三个开关与签名——它们推不出来，才需要落库。关掉的分区**不下发数据**（不是 CSS 隐藏），见 SPEC 4.5。

### 3.18 `user_stats`

定义：`packages/db/src/schema/social.ts`。站点访问统计（成就进度用，社交批第 3 项）。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `user_id` | text | PK, FK → `user.id` ON DELETE CASCADE | 归属；一人一行 |
| `visit_count` | integer | not null, default 0 | 登录访问累计次数 |
| `last_visit_at` | timestamptz | nullable | 节流位点，见下 |

无二级索引。**必须落库**：`visit_count` 是累计量，没有别的表能推出来。节流靠 `last_visit_at`——同一用户 1 小时内只计一次（`shouldCountVisit`，窗口是领域层常量），否则每次请求都 +1 会变成无意义的数字。

### 3.19 `user_points`

定义：`packages/db/src/schema/social.ts`。积分余额（社交批第 5 项）。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `user_id` | text | PK, FK → `user.id` ON DELETE CASCADE | 归属；一人一行 |
| `balance` | integer | not null, default 0 | **积分事实来源** |
| `updated_at` | timestamptz | not null, default `now()` | — |

**单独一张窄表，不塞进 `user`。** 积分变动频繁，写 `user` 那张宽表会牵连其它字段的更新时间与缓存；窄表只有一个写入口（领域层 `applyPoints`，同时写本表与 `point_transactions`）。参考实现的迁移注释写了同一条理由。

### 3.20 `point_transactions`

定义：`packages/db/src/schema/social.ts`。积分流水（社交批第 5 项）。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | text | PK | 由应用层生成 |
| `user_id` | text | not null, FK → `user.id` ON DELETE CASCADE | 归属 |
| `delta` | integer | not null | 正数增加、负数减少 |
| `balance` | integer | not null | 变动**后**的余额快照 |
| `reason` | text | not null，**无 CHECK** | 来源（`checkin` / `admin`…），见下第 3 条 |
| `detail` | text | nullable | 展示文案 |
| `dedup_key` | text | nullable | 幂等键（`checkin:<date>`）；null = 不去重 |
| `created_by` | text | nullable, FK → `user.id` ON DELETE **SET NULL** | 管理员发放时记操作者；用户自发行为为 null |
| `created_at` | timestamptz | not null, default `now()` | — |

索引：`point_transactions_dedup_unique_idx` **部分**唯一 `(user_id, dedup_key) WHERE dedup_key is not null`（「同一次签到只发一次」）、`point_transactions_user_idx (user_id, created_at)`（最近流水）。

三条必须一起看的规则：

1. **`balance` 快照可能与真实余额差一笔，事实来源始终是 `user_points.balance`。** 并发下快照只用于对账展示。这是参考实现明确写下的取舍，别反过来把流水当账。
2. **`created_by` 用 SET NULL。** 管理员删号后「这笔分被发过」这个事实仍在，只是没了发放者档案（同 3.11 `handled_by` 的取舍）。
3. **`reason` 故意没有 `redeem`。** 参考实现的积分能兑换中转站余额；本站只记账本、没有兑换出口，因此枚举里没有它。该列无 CHECK，将来真有出口再加值不必改迁移。

### 3.21 `daily_checkins`

定义：`packages/db/src/schema/social.ts`。每日签到（社交批第 4 项）。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `user_id` | text | not null, FK → `user.id` ON DELETE CASCADE | 归属 |
| `checkin_date` | date | not null | **站点时区（UTC+8）的日历日** |
| `points` | integer | not null | 本次实际发放合计 |
| `base_points` | integer | not null | 基础奖励部分 |
| `bonus_points` | integer | not null, default 0 | 里程碑部分；本批不做梯度，恒为 0，列保留 |
| `streak` | integer | not null | 本次签到后的连续天数 |
| `created_at` | timestamptz | not null, default `now()` | — |

主键 `daily_checkins_pk (user_id, checkin_date)`；索引 `daily_checkins_user_idx (user_id, checkin_date)`（按日期倒序取最近一条算连续天数）。

三条必须一起看的规则：

1. **主键就是并发防线。** 重复签到变成一次唯一约束冲突，仓储用 `ON CONFLICT DO NOTHING` 翻译成「今天已签到」，不依赖先查后写。
2. **日期按站点时区的日历日，不是 UTC 日期。** 用 UTC 日期时，UTC+8 的用户晚上 8 点之后签到会被算成「第二天」。时区口径集中在领域层一个函数（`siteDateString` / `calendarDateOf`）里，不散落。
3. **`streak` 冗余存一列**（连续天数每次都要展示，实时算要扫全部历史）；`base_points` 与 `bonus_points` 分开存，便于将来加里程碑梯度时对账而不必回填历史行。

### 3.22 `user_achievements`

定义：`packages/db/src/schema/social.ts`。成就解锁记录（社交批第 6 项）。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `user_id` | text | not null, FK → `user.id` ON DELETE CASCADE | 归属 |
| `achievement_id` | text | not null，**无外键** | 成就定义在代码里（编译期常量，同 `tools` 注册表） |
| `level` | integer | not null | 达成时的等级 |
| `unlocked_at` | timestamptz | not null, default `now()` | 首次达成时刻 |

主键 `user_achievements_pk (user_id, achievement_id, level)`；索引 `user_achievements_user_idx (user_id)`。

两条必须一起看的规则：

1. **成就是纯计算的，这张表只记解锁时间。** 进度每次按当前数据实时算、不落库；主键让「同一成就同一等级只解锁一次」在并发下也成立。
2. **等级回落不删历史行。** 资源被删导致等级下降时，历史记录保留，页面展示「历史最高等级」与首次解锁时间；当前等级以实时计算为准。`achievement_id` 无外键是这一设计的代价：定义从代码里移除后旧解锁行成孤儿，已登记在 SPEC 已知债务里（同 `audit_logs.target_id` 无外键的思路：留住发生过的事，不跟着定义走）。
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
| `posts_feed_idx` | posts | `created_at, id`（部分索引：`WHERE deleted_at is null`） | Feed / 标签页 / 搜索的游标翻页——`(created_at, id)` 两列一起比才不重不漏（见 3.8 第 1 条） |
| `posts_author_idx` | posts | `author_id, created_at` | 「我的帖子」列表与配额窗口计数（先定作者再切时间） |
| `posts_tags_idx` | posts | GIN `tags`（部分索引：`WHERE deleted_at is null`） | 标签浏览的 `tags @> array[?]` 包含查询 |
| `comments_post_idx` | comments | `post_id, created_at, id`（部分索引：`WHERE deleted_at is null`） | 帖子详情页的评论列表 |
| `comments_author_idx` | comments | `author_id, created_at` | 按作者收集评论 |
| `reports_open_unique_idx` | reports | `reporter_id, target_type, target_id`（唯一，部分索引：`WHERE status = 'open'`） | 挡同一人对同一目标重复举报（`ON CONFLICT DO NOTHING`），见 3.11 第 2 条 |
| `reports_status_created_idx` | reports | `status, created_at` | 管理后台的待处理举报队列（`WHERE status = 'open'`） |
| `audit_logs_created_idx` | audit_logs | `created_at` | 审计页按时间浏览（见 3.12） |
| `audit_logs_actor_idx` | audit_logs | `actor_id, created_at` | 按操作者查审计 |
| `audit_logs_target_idx` | audit_logs | `target_type, target_id, created_at` | 按被操作对象反查审计 |
| `notifications_recipient_idx` | notifications | `recipient_id, read, created_at` | 未读角标（`WHERE recipient_id = ? AND read = false`）与消息箱列表，两者都是「先定收件人再切时间」 |
| `notifications_recipient_category_idx` | notifications | `recipient_id, category, created_at` | 消息箱按分类 tab 筛选 |
| `notifications_dedup_unique_idx` | notifications | `recipient_id, dedup_key`（唯一，部分索引：`WHERE dedup_key is not null`） | 通知幂等的落点（见 3.14 第 1 条）；`null` 被排除，系统广播不受限 |
| `direct_messages_from_to_idx` | direct_messages | `from_user_id, to_user_id, created_at` | 我发出的那条会话翻页 |
| `direct_messages_to_from_idx` | direct_messages | `to_user_id, from_user_id, created_at` | 我收到的那条会话翻页（两个方向排序不同，故各建一条） |
| `direct_messages_unread_idx` | direct_messages | `to_user_id, read_at, created_at` | 未读数与「有新消息的会话」列表 |
| `dm_contacts_owner_status_idx` | dm_contacts | `owner_id, status` | 「我收到的待处理申请」（`WHERE owner_id = ? AND status = 'request'`） |
| `dm_contacts_peer_idx` | dm_contacts | `peer_id, status` | 发消息前反查「我与某人是否已有关系」 |
| `user_points` 主键 | user_points | `user_id`（唯一） | 一人一行；`ON CONFLICT (user_id) DO UPDATE` 的落点 |
| `point_transactions_dedup_unique_idx` | point_transactions | `user_id, dedup_key`（唯一，部分索引：`WHERE dedup_key is not null`） | 「同一次签到只发一次」的落点（见 3.20 第 1 条） |
| `point_transactions_user_idx` | point_transactions | `user_id, created_at` | 「最近流水」列表 |
| `daily_checkins_user_idx` | daily_checkins | `user_id, checkin_date` | 按日期倒序取最近一条算连续天数 |
| `user_achievements_user_idx` | user_achievements | `user_id` | 空间页列出某人的解锁记录 |

 另外由 `unique` 约束与主键隐式建出的唯一索引：`user.email`、`session.token`、`invites.code`、`reactions` 的复合主键 `(post_id, user_id)`（`reactions_pk`——并发点赞不产生重复行的落点，见 3.10 第 1 条）与 `site_config` 的单列主键（单行表，见 3.13）。

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
| `scripts/grant-admin.ts` | 把指定邮箱提升为 `admin`（首个管理员的唯一来源） | 已建（M3，2026-10-04 实跑验证三条路径：提权 / 不存在 exit 1 / 幂等跳过） |
| `scripts/create-invites.mjs` | 手动发放邀请码 | **未建 —— M1 计划内但未兑现**（目前发码只能直接改库，或照 `apps/web/e2e/` 的夹具插一行一次性码） |
| `scripts/enqueue-manual-jobs.ts` | 手工把一条 `mail.send` 与一条 `maintenance.cleanup` 塞进 Redis 队列，配合 `pnpm --filter @xsu/web worker` 做队列与清理任务的手工回归 | 已建（M2） |
| `scripts/verify-reaction-cache.ts` | 点赞计数缓存（`packages/platform/src/cache.ts`）的手工回归：六条行为断言（回填命中 / 键在才改 / 减不破键 / 失效 / 连不上时 best-effort），其中「键不在时 increment 什么都不做」是防止计数被写坏的实测防线 | 已建（M3，2026-10-04 实跑验证 8 项断言全过） |

脚本直接连库，**不经过应用**，所以每次执行都会被记录在操作者自己的终端历史里；这不是审计日志，审计日志要求见红线 8，细则见 `docs/SECURITY.md`（**尚未创建**）。

---

## 怎么验证

- **迁移与 schema 一致**：`pnpm --filter @xsu/db db:check` 通过（无 drift）。
 - **迁移可应用**：实跑 `pnpm --filter @xsu/db db:migrate`，随后
   `docker exec xsu-postgres psql -U xsu -d xsu -c "\dt"` 应列出 `user` / `session` / `account` / `verification` / `invites`（迁移 `0000`）、`tool_runs` / `tool_favorites`（迁移 `0001`）、`posts` / `comments` / `reactions` / `reports` / `audit_logs`（迁移 `0002`）、`site_config`（迁移 `0003`）与社交批 9 张表（迁移 `0004`：`notifications` / `direct_messages` / `dm_contacts` / `user_spaces` / `user_stats` / `user_points` / `point_transactions` / `daily_checkins` / `user_achievements`）共 22 张表，且 `drizzle.__drizzle_migrations` 有对应记录。**M1 实跑通过（2026-10-01，5 张表齐）；M2 的 `0001_tools_tables.sql` 已在本机实跑生效（2026-10-03）；M3 的 `0002_community_tables.sql` 已在本机实跑生效（2026-10-04）；M5 的 `0003_admin_tables.sql` 已在本机实跑生效（2026-10-05：`site_config` 建表、`user` 加封禁两列、`audit_logs.target_type` CHECK 扩为四值）；社交批的 `0004_past_black_bird.sql` 已在本机实跑生效（2026-10-05：9 张表 + 2 枚 CHECK（`notifications_category_check`、`dm_contacts_status_check`）+ 9 个主键（其中 `daily_checkins_pk` / `dm_contacts_pk` / `user_achievements_pk` 是复合主键）+ 10 条普通 btree 索引 + 2 条部分唯一索引；实测 22 张表，两个部分唯一索引 `notifications_dedup_unique_idx` 与 `point_transactions_dedup_unique_idx` 的谓词都是 `WHERE dedup_key IS NOT NULL`）。`0004` 里另有三条 `site_config` 配额 CHECK 的 DROP + ADD：那是 drizzle-kit 把 `0003` 快照里的占位符 `$1` 归一化成字面量所致的一次性自愈（约束定义前后等价，已用 `pg_get_constraintdef` 核对 `site_config_*_quota_check` 三条俱在且语义相同），非本批功能改动。**
 - **本文件与代码一致**：逐列对照 `packages/db/src/schema/*.ts` 与 `packages/db/migrations/*.sql`。不一致即缺陷，改本文件。
 - **领域层规则**：邀请码、角色、工具、社区、管理员与社交判定都有测试覆盖 —— `packages/core/tests/` 8 个文件 195 例（invites 14、tools 39、accounts 13、registration 14、access 9、community 11、admin 21、social 74）、`packages/platform/tests/` 3 个文件 28 例、分层铁律 12 例，合计 **12 个文件 235 例，`pnpm test` 全通过（社交批，2026-10-05 已实跑）**。`packages/core` 分支覆盖率 98%（`src/social` 96.41% 语句 / 98.08% 分支；门槛 80%，见 `vitest.config.ts`）。
- **归属**：新增业务表时逐表检查第 1.1 节，缺 `user_id` 且不属例外即阻断。

## 已知债务

- **`role` 是自由文本列，没有数据库级取值约束。** 只有 `default 'user'`，写入非法值（如 `'root'`）数据库不会拒绝。当前靠领域层 fail closed（无法识别的角色按未登录处理），但**脏角色会让人困惑**。可选方案是加 `CHECK (role IN ('user','admin'))`，留到引入第二种角色的需求出现时一并做。
- **`invites.code` 没有长度与字符集约束。** 生成逻辑在脚本里，靠脚本自律。若将来开放到别处生成，需要加约束。
- **`user` 表没有 `deleted_at` / 软删除。** PRD 4.4 要求账号注销入口，实现时需决定是硬删还是软删，以及删除后 `invites.used_by` 等外键的处置（当前都是 `SET NULL`，会丢「码被谁用了」的信息）。
- **`session` 表无过期行清理（M2 已解决）。** 原状：过期会话不会被自动删除，只在校验时不通过。M2 起由 worker 的 `maintenance.cleanup` 任务每天 UTC 04:00 删除（`deleteExpiredSessions`，实现见 `packages/platform/src/maintenance.ts`），手工回归步骤见 `docs/TESTING.md` 第 5 节。
- **审计日志的「只追加」可以被同一套数据库凭据绕过。** 表已建（M3，见 3.12）：行级与语句级触发器拒绝 UPDATE / DELETE / TRUNCATE（已实测）。残余风险：同一凭据可以 `DISABLE TRIGGER` 或直接改表结构；真正不可篡改需要独立凭据或外部存储，见 `docs/spec/SPEC-community.md` 的已知债务。
- **本文件的表结构描述是手工维护的。** 没有从 schema 自动生成表结构的工具链，改 schema 时容易忘记同步本文件——这是本文档最主要的风险。
- **`user_achievements.achievement_id` 无外键。** 成就定义在代码里，删掉一个定义后旧解锁行成孤儿（查询侧忽略未知 id）。这是「等级回落保留历史」这一设计的代价，见 3.22 第 2 条与 [`spec/SPEC-social.md`](spec/SPEC-social.md) 第 6 节。
- **`point_transactions.balance` 快照在并发下可能与 `user_points.balance` 差一笔。** 事实来源是 `user_points`，流水只用于对账展示（3.20 第 1 条）。
- **`notifications` 与 `point_transactions` 的部分唯一索引谓词与查询写法必须一致。** 若将来改成 `dedup_key <> ''` 之类的写法，索引会被规划器忽略而幂等仍成立（约束在），但**性能会静默退化**，属易漏项。
- **`tool_runs` 未分区、未归档。** 保留期（缺省 30 天）内的运行历史与收藏都在单表里，量级上来后按时间删除会变慢。M2 的规模下无所谓；等历史量真正成为瓶颈时再谈分区或归档，现在加是过度设计。

 - **管理员入口欠账已补齐（M3，2026-10-04）。** 原 M1 债务：`scripts/grant-admin.mjs` 计划内但未建、M1 端到端只验了「非管理员被拒」一侧。现状：`scripts/grant-admin.ts` 已建并实跑验证三条路径（提权成功 / 用户不存在 exit 1 / 幂等跳过，见第 5.3 节）；e2e 的 `admin-seed.ts` 用内部适配器造管理员号，`/admin/reports` 后台已随 M3 落地，其余五个管理页与封禁 / 配置入口已随 M5 落地（见 [`spec/SPEC-admin.md`](spec/SPEC-admin.md)）。`create-invites.mjs` 是**仅剩的脚本欠账**——目前发码仍靠直接改库，随 M4 一并补。
