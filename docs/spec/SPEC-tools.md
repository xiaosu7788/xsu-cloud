# SPEC-tools — 工具箱（M2）

本文件是工具箱的可执行规格：范围、数据模型、领域规则、失败码、验收到哪一步。
范围与验收标准来自 [`PRD.md`](../PRD.md) 3.3，里程碑定义见 [`ROADMAP.md`](../ROADMAP.md) M2；
分层与边界见 [`ARCHITECTURE.md`](../ARCHITECTURE.md)。三者冲突时以本文件为准并立刻改它。

## 1. 做什么

- 工具清单（公开可读）与工具执行（需登录）。
- 运行历史：记录输入输出摘要与耗时，**只对归属者可见**。
- 收藏：把工具加入/移出「我的收藏」。
- 单用户单位时间调用次数受限，超限返回明确错误码。

**不做**（PRD 3.3「不做」）：需要重型运行时依赖的工具（ffmpeg、OCR、浏览器自动化）一律不做，
这类需求交 worker 且须单独立项。M2 的四个工具都是纯函数，不碰网络、不碰磁盘、不进队列。

## 2. 工具目录放在代码里，不建 `tools` 表

`docs/ARCHITECTURE.md` 第 5 节原先把 `tools` 列为核心表之一，M2 改为**目录在代码内注册**
（`packages/core/src/tools/registry.ts`）。理由：

1. 一个工具 = 元数据 + 一个纯函数。分成「数据库行」和「代码里的实现」两处，就会出现
   「有行没实现」这种只能靠运行时才发现的状态，而 M2 的工具集是编译期就定死的常量；
2. 目录进表之后必然要播种、要迁移、要处理禁用与删除语义，这些都是后台管理（M5）的议题，
   不是 M2 的最小业务量；
3. 代价只有一个，已经写进下文与 [`DATA-MODEL.md`](../DATA-MODEL.md)：`tool_runs.tool_slug` /
   `tool_favorites.tool_slug` 没有外键指向目录，写入前必须由领域层校验 slug 是否在注册表里。

M5 若要「后台可开关某个工具」，落点应是 `ops.settings`（开关），而不是把目录搬进表。

## 3. 数据模型

两张表，详细字段与索引以 `packages/db/src/schema/tools.ts` 为准（见 `DATA-MODEL.md` 第 3.6、3.7 节）。

| 表 | 归属 | 关键点 |
| --- | --- | --- |
| `tool_runs` | `user_id` | 一次执行的摘要与耗时；**不存原始输入输出**（见第 5 节）；失败也要落一行 |
| `tool_favorites` | `user_id` | `unique (user_id, tool_slug)` 防重复收藏；取消收藏是删除 |

## 4. 领域层规则与执行顺序

入口：`runTool(ports, request)`（`packages/core/src/tools/run-tool.ts`）。顺序**必须**是：

1. **查目录**：slug 不在注册表 → `toolNotFound`，不落运行历史（无法归属到一个工具）。
2. **校验输入**：必填、单字段长度、总长度。拒绝 → `inputInvalid` / `inputTooLarge`，落一行失败历史。
3. **配额**：`countRunsSince(userId, now - 1 小时)` ≥ 上限 → `quotaExceeded`，**不落历史**。
   配额拒绝本身不计数，否则「被拒 → 计数 +1 → 更容易被拒」会自我放大。
4. **执行**：工具函数抛错即翻译成 `runFailed`，原错误挂 `cause` 交给调用方记日志（领域层不写日志）。
5. **落历史**：成功与执行失败都落一行（`status` + `errorCode` + `durationMs` + 摘要）。
   返回结果在落历史之后，因此「有结果必有记录」。

配额上限来自配置（`TOOL_RUN_QUOTA_PER_HOUR`，缺省用领域层常量）。PRD 明确说配额数值
「尚未确定，需要在实际使用中定」，因此**不把数字写死在文档里当事实**。

### 4.1 归属与跨用户拒绝

`decideToolRunAccess({ viewerId, ownerId })`：只有 `ownerId === viewerId` 放行，其余一律
`runForbidden`。**M2 管理员也不放行**：PRD 3.3 验收 4 是「用户只能看到自己的运行历史」，
后台查看属于 M5，且必须带审计日志。列表查询在数据层就按 `user_id` 收窄（纵深防御），
单条读取走领域层判定。

### 4.2 失败码表（全站唯一来源）

`TOOL_FAILURE`：`toolNotFound` / `inputInvalid` / `inputTooLarge` / `quotaExceeded` /
`runFailed` / `runForbidden`。每个都有稳定 `code`、给用户看的中文 `message`、
以及翻译成 HTTP 用的 `status`（400 / 429 / 403 / 500）。新增失败原因加在这里，
不在调用点就地造文案——理由与 `ACCESS_DENIED` 相同（统一拒绝响应的形状）。

### 4.3 摘要与脱敏（PRD 3.3 验收 2）

工具声明 `sensitive`：

- `sensitive: false`（`json-format`、`text-stats`）：历史里存截断后的输入/输出预览
  （输入首 120 字符、输出首 500 字符），够回看，不存全文。
- `sensitive: true`（`base64`、`hash`）：输入可能是口令或密钥，**只存长度与字段名**，
  一个字符的预览都不存；输出同理只存长度与摘要。

截断与脱敏的唯一实现是 `buildRunSummary`——页面与仓储都不得自己截断。

## 5. 基础设施

- `packages/platform/src/queue.ts`：BullMQ 队列定义与入队函数；Redis 连接串来自 `REDIS_URL`。
- `apps/web/worker/`：worker 进程入口（与应用同代码不同入口，`ARCHITECTURE.md` 7.3）。
  M2 落两个真实任务：`mail.send`（注册验证邮件改为入队后发送）、
  `maintenance.cleanup`（重复任务：删过期 session、删超过保留期的 `tool_runs`）。
- 派生的一个行为变化：**邮件从「注册请求内同步发送」变成「入队后由 worker 发送」**。
  代价是注册成功不再意味着邮件已发出（由队列重试兜底），换到的是注册路径不再被邮件服务卡住。
  这条变化必须出现在 `CHANGELOG.md` 与 `INTEGRATIONS.md`。

## 6. 表现层

| 路由 | 分区 | 渲染 | 说明 |
| --- | --- | --- | --- |
| `/tools` | `(site)` | 静态 | 公开清单与说明，不含执行 |
| `/console/tools` | `(console)` | 动态 | 工具台：清单 + 收藏开关 + 入口 |
| `/console/tools/[slug]` | `(console)` | 动态 | 执行页：表单 → 结构化结果 |
| `/console/tools/runs` | `(console)` | 动态 | 我的运行历史（`ResponsiveTable`） |
| `/console/tools/runs/[id]` | `(console)` | 动态 | 单条记录；非归属者拿到统一拒绝视图 |

`(console)` 导航加一项「工具箱」；`(site)` 首页的「尚未开放的模块」里去掉工具箱、
补上 `/tools` 入口。路由常量集中在 `apps/web/features/tools/routes.ts`（与 auth 同一约定：
只放常量、不 import 任何东西）。

## 7. 验收 → 怎么验

| 验收（PRD 3.3） | 验证方式 |
| --- | --- |
| 1. 失败返回结构化错误，不吞异常、不伪成功 | `packages/core/tests/tools.test.ts`：每个失败码各有用例，含「工具函数抛错 → `runFailed` 且带 `cause`」 |
| 2. 历史记录摘要与耗时，不记录敏感内容 | 同上：`buildRunSummary` 对 `sensitive: true` 的工具不产生任何原文；端到端看到历史里出现耗时 |
| 3. 单位时间次数受限，超限有明确错误码 | 同上：边界值（等于上限放行 / 超一被拒）；端到端断言超限提示文案 |
| 4. 只能看到自己的运行历史 | `packages/core/tests/tools.test.ts` 的跨用户拒绝用例 + `/console/tools/runs/[id]` 的端到端用例 |
| 退出标准：`packages/core` 分支覆盖 ≥80% | `pnpm test` 带 `@vitest/coverage-v8` 门槛（`vitest.config.ts`） |
| 退出标准：跨用户访问被拒有测试覆盖 | 同上两处 |
| 公开清单页静态化（红线 1） | `apps/web/e2e/static-render.spec.ts` 的预渲染清单加 `/tools` |
| 移动端可用、360px 无横向滚动 | `apps/web/e2e/tools.spec.ts` 双视口 |

## 已知债务

- **配额按数据库计数**，不是 Redis。M2 的量级不需要 Redis 计数；上网后并发升高时改为
  `ARCHITECTURE.md` 第 4 节第 2 档（Redis + 时间窗），届时计数口径要一起改，不能只换存储。
- **没有工具执行的重试与补偿**：四个工具都是纯函数，失败即失败。将来若引入需要外部依赖的工具，
  必须走队列并补幂等键（`ARCHITECTURE.md` 7.3）。
- **`tool_slug` 无外键**，见第 2 节：删掉一个工具不会清理它的历史与收藏。M5 若需要，
  在删工具的同时加一条数据清理任务。
- **管理员看不到他人运行历史**，这是 M2 的有意限制，M5 需要时连同审计日志一起做。
- **`maintenance.cleanup` 的保留期是一个默认值**，不是经过容量评估的数字。
