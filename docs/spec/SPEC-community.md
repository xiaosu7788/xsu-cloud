# SPEC-community — 社区（M3）

本文件是社区的可执行规格：范围、数据模型、领域规则、失败码、验收到哪一步。
范围与验收标准来自 [`PRD.md`](../PRD.md) 3.2，里程碑定义见 [`ROADMAP.md`](../ROADMAP.md) M3；
分层与边界见 [`ARCHITECTURE.md`](../ARCHITECTURE.md)。三者冲突时以本文件为准并立刻改它。

## 1. 做什么

- 发帖、编辑、删除（软删除）、评论、点赞、标签。
- 列表（游标分页）、详情、按标签浏览、搜索。
- 举报 + **管理员确认路径**（举报不自动下架）。
- 发文与评论受配额限制，超限返回明确错误码。

**不做**（PRD 3.2「不做」）：IM / 私信、富文本协同编辑、关注流 / 推荐算法。

**M3 再收窄的**（本文件的决定，理由是只保留能验证工程链的最小业务量）：

- **阅读数**。PRD 未要求；点赞数已经能验证「计数走 Redis」这条链路，再加一个计数器不增加信息量。
- **标签的改名 / 合并 / 计数榜**。这三件事都是后台管理（M5）的议题，见第 2 节。
- **举报的通知与申诉**。举报只有「待处理 → 确认下架 / 驳回」两个终态。

## 2. 标签用 `posts.tags` 数组，不建 `tags` 表

`docs/ARCHITECTURE.md` 第 5 节把 `tags` 列进了 `community` 域的规划表。M3 改为
**`posts.tags text[]` + GIN 索引**，不建 `tags` / `post_tags`：

1. M3 需要的只有「打标签」与「按标签浏览」，`text[]` + GIN 直接满足；
2. 关系表多出来的能力是改名、合并、每标签计数——都没有需求，且都落在后台管理（M5）；
3. 代价：标签没有稳定 id，改名等于一次全表 `UPDATE`。**真出现改名 / 合并需求时**加一条迁移
   建 `tags` 表并从数组回填，本文件的表结构随之改写。

这条偏离要同步到 `ARCHITECTURE.md` 第 5 节（本文件为准）。

## 3. 数据模型

五张表，字段与索引以 `packages/db/src/schema/community.ts` 为准（`DATA-MODEL.md` 第 3.8–3.12 节）。

| 表 | 归属 | 关键点 |
| --- | --- | --- |
| `posts` | `author_id` | `deleted_at` 软删除；`tags text[]`；列表索引 `(created_at DESC, id DESC) WHERE deleted_at IS NULL` |
| `comments` | `author_id` | 同软删除；索引 `(post_id, created_at, id) WHERE deleted_at IS NULL` |
| `reactions` | `user_id` | 主键 `(post_id, user_id)`：**唯一约束就是并发点赞的防线**；`kind` 默认 `'like'`，为将来的表情留位 |
| `reports` | `reporter_id` | 多态目标 `(target_type, target_id)`；`status` 三态；同一举报人对同一目标**最多一条未处理举报**（部分唯一索引） |
| `audit_logs` | `actor_id` | **只追加**：迁移里加 `BEFORE UPDATE OR DELETE` 触发器直接 `RAISE EXCEPTION` |

`reports` 与 `audit_logs` 的目标 id 不设外键（多态 / 审计要活得比被引用行久），由领域层校验目标存在；
与 `tool_runs.tool_slug` 无外键是同一类取舍，代价写在第 10 节。

## 4. 领域层规则与执行顺序

入口在 `packages/core/src/community/`，端口由调用方注入（同 `run-tool.ts` 的写法）。

- **发帖 `createPost`**：① 校验输入 → ② 配额 `countPostsSince(userId, now - 1h)` → ③ 写入。
  配额拒绝**不落任何行、也不计数**（与工具箱同一理由：否则「被拒 → 计数 +1 → 更容易被拒」会自我放大）。
- **评论 `createComment`**：① 目标帖子存在且未删除 → ② 校验 → ③ 配额 → ④ 写入。
- **点赞 `likePost` / `unlikePost`**：目标帖子存在且未删除（**自己的帖子也能点赞**，M3 不做限制）；
  重复点赞**不是错误**，返回 `liked: true` 的当前状态——唯一约束冲突被翻译成幂等结果而非失败。
- **删除（作者）**：只写 `deleted_at`，不删行。
- **举报 `createReport`**：① 目标存在且未删除 → ② 同一举报人对同一目标已有未处理举报则幂等返回既有举报
  → ③ 写入。**只落库，不改任何内容状态**（PRD 3.2 验收 4）。
- **审核 `confirmTakedown` / `dismissReport`**：① **要求管理员**（`ADMIN_ROLE`）→ ② 举报必须处于 `open`
  → ③ 确认下架时软删除目标 → ④ 举报置终态并记 `handled_by` / `handled_at`
  → ⑤ **写一条 `audit_logs`**。顺序固定：**审计行与业务状态在同一次调用里成对出现**，
  不允许「先下架、审计失败就算了」。

### 4.1 归属与跨用户拒绝

`decidePostAccess({ viewerId, authorId })`：作者放行编辑 / 删除；**管理员在这里不放行**——管理员只有
审核这条路径（`confirmTakedown`），它带审计日志。这样「作者删除」与「管理员下架」在代码里始终是两条
不同的路径，不会因为角色判定而被悄悄合并。列表与详情查询在数据层就按 `deleted_at IS NULL` 收窄
（纵深防御），单条读取走领域层判定。`listAuditLogs` 仅管理员可用。

### 4.2 失败码表（全站唯一来源）

`CONTENT_FAILURE`：`postNotFound` / `commentNotFound` / `postForbidden` / `commentForbidden` /
`inputInvalid` / `inputTooLarge` / `tagLimitExceeded` / `quotaExceeded` / `reportNotFound` /
`reportAlreadyHandled` / `notAdmin`。

每个都有稳定 `code`、给用户看的中文 `message`、翻译成 HTTP 的 `status`（400 / 403 / 404 / 429 / 500）。
形状与 `TOOL_FAILURE`、`ACCESS_DENIED` 一致，**不造第二套**。

### 4.3 输入约束

| 字段 | 约束 |
| --- | --- |
| 帖子标题 | 1–120 字符 |
| 帖子正文 | 1–20000 字符 |
| 评论正文 | 1–2000 字符 |
| 标签 | 最多 5 个，单个 1–24 字符；trim + 转小写 + 去重后入库 |
| 举报理由 | 1–500 字符 |

长度按**码点**计（`Array.from`），不用 `.length`——与工具箱 `text-stats` 同一口径。

## 5. 计数走 Redis（`ARCHITECTURE.md` 第 4 节第 2 档）

`packages/platform/src/cache.ts`：键 `community:post:{id}:likes`，**写时直改**（点赞 `INCR`、
取消 `DECR`），读缺失时从数据库 `COUNT(*)` 重建再 `SET ... EX`（TTL 60 秒，计数值容忍短暂不一致）；
帖子被删除时 `DEL`。列表页一次 `MGET` 取整页计数，缺失项批量重建。

**点赞与计数不走页面 SSR**：`POST|DELETE /api/community/posts/[id]/like` 是独立轻量接口（红线 2），
页面只渲染初始值，客户端点完就地更新。`ARCHITECTURE.md` 第 7.2 节「列表与计数」那一行由
「未实现」改为 M3 的现状。

## 6. 游标分页

游标 = `base64url(JSON.stringify({ t: created_at.toISOString(), i: id }))`；排序固定
`created_at DESC, id DESC`，取下一页用 `(created_at, id) < (t, i)` 的行值比较，与复合索引同序。
页大小默认 20、上限 50，**不使用 `OFFSET`**；列表、评论、按标签浏览、搜索共用同一套游标。
游标解码失败 → `inputInvalid`，**不静默回落到第一页**（否则「翻页不重不漏」无法证伪）。

## 7. 表现层

| 路由 | 分区 | 渲染 | 说明 |
| --- | --- | --- | --- |
| `/community` | `(site)` | ISR 30s | 公开列表：卡片 + 标签 + 点赞数 |
| `/community/[id]` | `(site)` | ISR 15s | 详情 + 评论；登录后才渲染点赞 / 举报按钮。构建期 `generateStaticParams` 预渲染最近 20 帖（`STATIC_PARAMS_POST_LIMIT`），之后的新帖走 ISR 按需生成（进 `prerender-manifest.json` 的 `dynamicRoutes` 兜底） |
| `/community/tags/[tag]` | `(site)` | ISR 30s | 按标签浏览。构建期 `generateStaticParams` 返回已知标签列表（`listFeedTags`：未删帖标签 + 确定性排序），新标签走 ISR 按需生成（进 `dynamicRoutes`） |
| `/community/search` | `(site)` | 动态 | 按查询串搜索；动态渲染是例外且理由明确：结果随查询变化 |
| `/console/community` | `(console)` | 动态 | 我的帖子：新建、编辑、删除 |
| `/console/community/[id]/edit` | `(console)` | 动态 | 编辑页；非作者拿到统一拒绝视图 |
| `/admin/reports` | `(admin)` | 动态 | **管理员确认路径**：待处理举报列表 + 确认下架 / 驳回 |
| `/api/community/posts/[id]/like` | — | — | `POST` 点赞 / `DELETE` 取消，JSON |
| `/api/community/posts/likes?ids=` | — | — | 批量取计数，供客户端刷新 |
| `/api/community/reports` | — | — | `POST` 举报 |

`(site)` 导航加「社区」，`(console)` 导航加「我的帖子」。路由常量集中在
`apps/web/features/community/routes.ts`（只放常量、不 import 任何东西，同 `auth` / `tools` 的约定）。
写操作走 Server Action（薄壳 ≤30 行）；360px 下卡片不得横向滚动（PRD 4.1）。

## 8. 配置

`POST_QUOTA_PER_HOUR`、`COMMENT_QUOTA_PER_HOUR` 进 `packages/platform/src/env.ts`（可选，
缺省用领域层常量）。**不把具体数字当事实写进文档**——PRD 明确说配额数值待实际使用中定。

## 9. 验收 → 怎么验

| 验收 | 验证方式 |
| --- | --- |
| PRD 3.2-1 游标分页不重不漏 | `packages/core/tests/community.test.ts` 用内存假仓储翻满 3 页 + 边界；e2e 造 25 帖真翻页 |
| PRD 3.2-2 重复点赞被唯一约束拦住、并发不产生重复行 | 核心单测（幂等语义）+ e2e 两个上下文并发点赞后断言 `reactions` 仅一行、计数为 1 |
| PRD 3.2-3 软删除从列表与搜索同时消失 | 单测 + e2e：删除后列表页与搜索页都找不到，详情页统一拒绝视图 |
| PRD 3.2-4 举报不自动下架、必须有管理员确认路径 | 单测（举报后内容状态不变）+ e2e：举报 → `/admin/reports` 确认下架 → 内容消失、`audit_logs` 多一行 |
| PRD 3.2-5 配额超限有明确错误码 | 单测边界值（等于上限放行 / 超一被拒）+ e2e 断言提示文案 |
| ROADMAP M3 退出标准 1、2 | 前两行 |
| ROADMAP M3 退出标准 3、4 | 软删除行 + 举报确认行 |
| 红线 8：敏感操作写审计日志、只追加 | 单测：确认下架必产生审计行；`audit_logs` 的 `UPDATE` / `DELETE` 被触发器拒绝 |
| 红线 2：点赞不走页面 SSR | e2e 在列表页点赞，断言发出的是 `/api/community/posts/*/like` 请求 |
| 列表计数走 Redis | `packages/platform/src/cache.ts` 的手工回归：`pnpm exec tsx scripts/verify-reaction-cache.ts`（回填命中 / 键在才改 / 减不破键 / 失效 / 连不上时 best-effort；提交级测试不起 Redis，见 [`TESTING.md`](../TESTING.md) 第 5 节的同一纪律） |
| 公开页静态化不受影响 | `apps/web/e2e/static-render.spec.ts` 的预渲染清单加 `/community`；`/community/[id]` 与 `/community/tags/[tag]` 必须出现在 `.next/prerender-manifest.json` 的 `dynamicRoutes`（ISR 动态路由的静态化证据，已实测） |
| 移动端 360px 无横向滚动 | `apps/web/e2e/community.spec.ts` 双视口 |

## 已知债务

- **搜索是 `ILIKE` 顺序扫描**，没有全文索引、没装 `pg_trgm`。M3 的量级够用；内容量上来后单独评估
  （`ARCHITECTURE.md` 第 4 节第 3 档）。
- **`reports` / `audit_logs` 的目标 id 无外键**，被引用行硬删时不会级联，会留下悬空 id。
  这是「审计优先」的有意取舍。
- **`audit_logs` 只做到了库内防改**：触发器挡得住 `UPDATE` / `DELETE`，但用同一套凭据能
  `DISABLE TRIGGER`。真正不可篡改需要独立凭据或外部存储，不在 M3 范围。
- **`reactions` 的唯一约束按 `(post_id, user_id)` 定**（`kind` 只有 `'like'`），加第二种表情时
  要改成 `(post_id, user_id, kind)`。
- **`posts.tags` 没有标签字典**（见第 2 节）：改名 / 合并需求出现时加表。
- **配额按数据库计数**（同 M2 的取舍），M3 量级不需要 Redis 时间窗。计数口径将来若改存储，要一起改。
- **`audit_logs` 的 actor 级联与追加只读触发器互相冲突。** `actor_id` 外键是 `ON DELETE CASCADE`（DATA-MODEL 3.12 第 3 条的语义「管理员账号消失时操作记录跟着走」），但触发器禁止删审计行——于是「删除带审计行的管理员账号」在数据库层整条失败。e2e 夹具 `admin-seed.ts` 是第一个撞上它的地方（已改为复用账号）。M3 没有删除账号的用户路径，冲突暂时只是理论上的；真要支持注销，把该外键改成 `SET NULL` 或提供受控的审计归档路径。
- **审核界面只有「待处理举报列表 + 单条确认」**，没有批量操作、没有筛选与分页；后台的用户管理、
  内容管理、任务管理、配额调整、审计日志查看都留给 M5。
