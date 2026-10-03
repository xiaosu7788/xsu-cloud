# TESTING — xsu-cloud

本文件回答三件事：**怎么验、验什么、覆盖线划在哪**。

分层职责见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 第 2 节，模块范围与验收标准见 [`PRD.md`](PRD.md) 第 3 节，
各档命令与红线见 [`../AGENTS.md`](../AGENTS.md) 第 7 节。本文件只写「怎么验」这一件事，
**不复制别处的验收条款**——要判「做到没做到」去 PRD，要判「该怎么分层验」才来这。

**数字会过期。** 本文出现的百分比、用例数、延迟都是某次实跑的快照，每处都注明了日期与来源；
与 `pnpm test` 的实际输出不一致时，以实际输出为准并立刻改本文件。

---

## 1. 四档验证

对应 `AGENTS.md` 第 7 节，四档的责任不同，**不要互相替代**：

| 档 | 什么时候跑 | 命令 | 卡住什么 |
| --- | --- | --- | --- |
| 提交级 | 每次提交（本机 + CI `checks` job） | `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test` | 类型、分层铁律、格式、单元用例与 `packages/core` 分支覆盖 ≥80% |
| PR 级 | 提 PR（CI `e2e` job） | `pnpm --filter @xsu/web test:e2e` | 主流程可用性、可访问性、两套视口下的布局、权限拒绝一致性 |
| 周期级 | 每周 | 依赖漏洞扫描（`AGENTS.md` 第 7 节） | 已知漏洞 |
| 里程碑级 | 每个里程碑收尾 | k6 压测 | 容量数字，结果**写回** [`ARCHITECTURE.md`](ARCHITECTURE.md) 第 8 节 |

提交级与 PR 级都不连真实外部系统、不起 Redis；**需要外部依赖的验证一律进第 5 节的手工清单**，
不给它们加「环境不具备就跳过」的开关——跳过等于把现场状态藏起来，跑出来的是绿色的假象。

---

## 2. 提交级

### 2.1 命令

```powershell
pnpm typecheck      # tsc --noEmit：根 + 各包（含 apps/web，e2e 目录也在其中）
pnpm lint           # ESLint：含分层铁律 no-restricted-imports
pnpm format:check   # Prettier（Markdown 与迁移产物在 .prettierignore 里）
pnpm test           # Vitest + v8 覆盖率
```

### 2.2 覆盖线

**只对 `packages/core` 卡门槛，且只卡分支（≥80%）。** 配置唯一来源是 `vitest.config.ts` 的
`coverage.thresholds`，理由也写在那里：数据层与平台层的判定逻辑都应落在领域层，用行覆盖率去卡
`apps/web` 只会得到好看的数字。门槛一旦启用不再下调：不够就补测试，确有留白就在用例文件头写明哪一档是有意留白的。

### 2.3 现有用例（2026-10-03 实测）

| 文件 | 用例数 | 锁的是什么 |
| --- | --- | --- |
| `packages/config/eslint/tests/layering.test.ts` | 12 | 分层铁律：既覆盖「必须报错」，也覆盖「不得误伤」（`@xsu/db`、`zod`、S3 SDK 等负向对照） |
| `packages/core/tests/access.test.ts` | 9 | 角色到权限的判定，含无法识别角色 fail closed |
| `packages/core/tests/accounts.test.ts` | 13 | 登录方式（`account`）的解绑前置条件与不自动关联 |
| `packages/core/tests/invites.test.ts` | 14 | 邀请码可用性、脏数据 fail closed、归一化 |
| `packages/core/tests/registration.test.ts` | 14 | 注册编排的判定顺序与失败分支 |
| `packages/core/tests/tools.test.ts` | 39 | 工具箱领域层：输入校验、配额窗口、摘要截断与脱敏、跨用户访问拒绝、失败码 |
| `packages/platform/tests/env.test.ts` | 20 | 配置校验：必填、范围、缺省回退 |
| `packages/platform/tests/mail.test.ts` | 3 | 控制台邮件传输的产出与生产环境拒绝 |
| `packages/platform/tests/queue.test.ts` | 5 | `dispatchJob` 分派与失败计数（**刻意不连 Redis**，理由写在文件头） |

**实测（2026-10-03）：`pnpm test` = 9 个文件 129 个用例全通过。**

### 2.4 覆盖率现状（2026-10-03，`vitest run --coverage`）

| 范围 | 语句 | 分支 | 函数 | 行 |
| --- | --- | --- | --- | --- |
| `packages/core` 合计 | 99.48% | **98%** | 100% | 99.45% |
| `packages/core/src/tools` | 99.21% | 96.42% | 100% | 99.16% |

未覆盖的两处分支：`src/tools/registry.ts:32`（模块加载时抛「重复 slug」，代价是污染模块级注册表）与
`src/tools/types.ts:62`。两个 `index.ts` 桶文件是 0%，它们是纯 re-export，没有可执行分支。

---

## 3. PR 级：Playwright 端到端

```powershell
pnpm --filter @xsu/web test:e2e
```

前置：本地 Postgres 已启动（`docker/docker-compose.yml`，宿主端口 5433）且已跑过迁移。
`playwright.config.ts` 的 `webServer` 会**先 `next build` 再 `next start`**——这不是「页面能打开」的冒烟，
静态预渲染这类事实在 `next dev` 下根本无从判断。

配置的四件关键事（理由写在 `apps/web/playwright.config.ts` 与 `apps/web/e2e/env.ts` 的文件头，此处不复制）：
两套视口做成两个 project 而不是用例里 `setViewportSize()`；`setup` project 只跑夹具；
端到端里屏蔽 Service Worker；环境基线（浏览器缓存目录与 `BETTER_AUTH_URL`）由 `e2e/env.ts` 一处设定，
它同时作用于夹具所在的 Playwright 进程与被测服务——CI 上没有根 `.env`，这一项不可省。

### 3.1 用例清单

| 文件 | 覆盖什么 |
| --- | --- |
| `e2e/auth.setup.ts` | 夹具：造账号并登录，结果落盘给两个 project 复用 |
| `e2e/tools.setup.ts` | 夹具：造一条**他人**的运行记录（跨用户访问要有真实对手） |
| `e2e/public-pages.spec.ts` | 首页标题与入口、顶栏两套视口可用、360px 无横向滚动、移动端可点项 ≥44px、axe 无 serious/critical、主题切换落盘并保持 |
| `e2e/static-render.spec.ts` | 公开页在构建期预渲染（含例外表）、控制台与后台一律不得预渲染、例外页在运行期按请求渲染 |
| `e2e/admin-access.spec.ts` | 匿名访问三条受保护路由得到**同一种**响应、非管理员渲染统一拒绝视图、同一账号访问控制台不被拒 |
| `e2e/tools.spec.ts` | 未登录访问带参数页重定向、公开清单页不含执行入口、工具台写明配额、执行成功并能在历史里打开、坏输入得结构化错误并留失败历史、敏感工具历史无原文、他人的记录打不开且与不存在的 id 同视图、自己的历史不含他人记录、收藏与取消收藏 |

**实测（2026-10-03，生产构建 + 真实库 + 真实会话，双视口）：56 个用例，50 通过 / 6 跳过 / 0 失败。**

6 条跳过都是**按视口去重**，不是环境不具备：`static-render.spec.ts` 的 4 条与
`tools.spec.ts` 的收藏用例只跑 desktop（它们改写共享状态或与视口无关），
`public-pages.spec.ts` 的 44px 触控目标用例只跑 mobile（桌面按鼠标密度取 36px，见 `PRD.md` 4.1）。

### 3.2 覆盖边界

端到端**不覆盖**：OAuth 回调（本机无提供方凭证）、真实 SMTP 投递、邮箱验证链接的完整往返、
PWA 更新提示（Service Worker 被刻意屏蔽，理由见 `playwright.config.ts`）。
axe 只跑公开页两页 × 两视口的 serious/critical 档，不是全站无障碍审计。

---

## 4. 集成层怎么验（M2 定下的形态）

`INTEGRATIONS.md` 的已知债务曾把这件事挂到「`docs/TESTING.md` 建立时一并决定」，这里就是那个决定。

**形态三条：**

1. **不 mock 第三方 SDK，不做录制回放（VCR）。** 录制的响应会随提供方改版过期，而凭证与真实数据
   不该进仓库；一条假的录制比没有测试更糟，因为它会让人以为集成是验过的。
2. **适配器只暴露最小接口，本项目侧的翻译与失败处理用可注入的替身在单测里验。**
   已落地的例子是邮件：`MailTransport` 是一个只有一个方法的端口，
   `createConsoleMailTransport` 的产出与「生产环境必须抛错」由 `packages/platform/tests/mail.test.ts` 锁定。
3. **真实外部调用的验证是「人工现场跑一次 + 留证据」，不是自动化。** 证据写进本文件对应小节，
   并登记到 [`ROADMAP.md`](ROADMAP.md) 第 5 节的未验证清单；没跑过就写「未验证」，
   不许用「应该没问题」结案。

**现状：** 除 I2 邮件端口外，全部集成点为 0 行实现，因此没有可验的对象。真实 SMTP 传输落地时，
按第 1 条它会是一个新的 `MailTransport` 实现——单测仍是验「本项目侧怎么用它」，
而「信到底发出去没有」只能现场跑一次并留证。

---

## 5. 手工回归：队列与清理任务

队列的自动化测试只覆盖 `dispatchJob` 的分派逻辑（提交级不起 Redis）。**「任务确实被 worker 取走并处理了」
连着真实 Redis 才验得了**，所以这是一步手工回归，每次改动 `queue.ts`、`maintenance.ts` 或
worker 入口后都该重跑一次。

### 5.1 前置

```powershell
docker compose -f docker/docker-compose.yml up -d postgres redis
pnpm --filter @xsu/db db:migrate
```

### 5.2 步骤

两个终端（或把消费者放到后台，日志重定向到文件）：

```powershell
# 终端 1 —— 消费者进程
pnpm --filter @xsu/web worker

# 终端 2 —— 生产者：入队一条邮件任务与一条清理任务
pnpm exec tsx scripts/enqueue-manual-jobs.ts
```

**期望**：终端 1 出现邮件正文预览、`[queue] mail.send 完成：…`，随后
`[maintenance] 清理完成：过期会话 N 行、运行历史 M 行（保留 30 天）` 与 `[queue] maintenance.cleanup 完成`。
启动时还应先出现 `[queue] 已注册 maintenance.cleanup：0 4 * * *（UTC）`。
任一条进 `[queue] 任务失败：…` 就是回归失败——**失败要留着现场排查，不要靠加大重试次数掩盖**。

**实测（2026-10-03）**：`mail.send` 与 `maintenance.cleanup` 都被 worker 取走并处理完成；
注册流程产生的验证邮件在同一个进程里由控制台传输打印出来。同一次回归里，
清理删掉了夹具中该删的 1 行过期会话与 1 行 40 天前的运行历史，1 天前的那行仍在。

### 5.3 清理的可断言夹具

清理要验的是「删该删的、留该留的」，光看「删了 0 行」是验不出东西的。往真实库种三行再跑一次清理：

```sql
-- 三行夹具：40 天前的运行历史（该删）、1 天前的运行历史（不该删）、已过期的会话（该删）
insert into tool_runs (id, user_id, tool_slug, status, input_bytes, output_bytes, duration_ms,
                       input_summary, output_summary, created_at)
select 'diag-cleanup-old-run', u.id, 'hash-text', 'succeeded', 12, 64, 3, 'text=diag', 'diag',
       now() - interval '40 days'
from (select id from "user" limit 1) as u;

insert into tool_runs (id, user_id, tool_slug, status, input_bytes, output_bytes, duration_ms,
                       input_summary, output_summary, created_at)
select 'diag-cleanup-fresh-run', u.id, 'hash-text', 'succeeded', 12, 64, 3, 'text=diag', 'diag',
       now() - interval '1 day'
from (select id from "user" limit 1) as u;

insert into session (id, token, expires_at, user_id, created_at, updated_at)
select 'diag-cleanup-expired-session', 'diag-expired-token', now() - interval '1 day', u.id,
       now() - interval '2 days', now() - interval '2 days'
from (select id from "user" limit 1) as u;
```

期望：清理日志为「过期会话 1 行、运行历史 1 行」，且 `diag-cleanup-fresh-run` 仍在表里。
清完记得删掉夹具行（`delete from tool_runs where id like 'diag-cleanup-%'`、
`delete from session where id = 'diag-cleanup-expired-session'`）。

**这两条删除语句曾在真实库上失败过，而且是两个缺陷叠在一起**：裸 `Date` 插进 `sql` 模板时
`postgres.js` 在 Bind 阶段抛 `ERR_INVALID_ARG_TYPE`，它把紧随其后的 `syntax error`（CTE 少一个闭合括号）
挡住了，于是「只修类型映射仍然失败」。两个根因与约定写在 `packages/db/src/repositories/tools.ts` 的文件头。
**裸模板躲得过编译器和单测，只有对着真实库实跑才会露出来**——这就是本条必须留在手工清单里的原因。

---

## 6. 里程碑级：k6 压测

跑法与数字归属：

- **怎么跑**：起 `next build` 产物（`next start`），真实登录拿会话 cookie，再按场景压；
  脚本编排（起服 → 取 cookie → 跑 k6 → 采样内存与库连接 → 停服）与场景定义同源，见下条。
- **数字写回哪里**：[`ARCHITECTURE.md`](ARCHITECTURE.md) 第 8 节。**本文件不复制数字**，
  同一事实只写一处。
- **压的是什么**：生产构建，不是 `next dev`；只压读路径（写路径的 Server Action 未压）。
- **一定要一并声明局限**：单机、本机压本机（不经真实网络）、无 CDN、单应用副本、只读路径。
  不写局限的容量数字等于编造。

**已知缺口**：压测脚本目前是 `Temp/` 下的草稿，**没有入库**，见第 8 节。

---

## 7. 怎么验证本文件

- **用例数与覆盖率**：跑 `pnpm test`，把输出里的「Test Files / Tests」与覆盖率表和本文第 2.3、2.4 节对照；
  不一致即本文件过期，改本文件。
- **端到端数字**：跑 `pnpm --filter @xsu/web test:e2e`，与第 3.1 节的 56 / 50 / 6 / 0 对照。
- **手工回归步骤仍然可执行**：按第 5 节跑一遍，日志形态与实测描述一致。
- **不复制事实**：本文件里任何一条验收条款都应在 `PRD.md` 找到出处，命令应在 `AGENTS.md` 第 7 节找到出处；
  发现本文成了第二份事实来源，就是缺陷。
- **实测记录**：第 2.3 / 2.4 / 3.1 / 5.2 节的数字取自 2026-10-03 的三次实跑
  （`pnpm test`、`pnpm --filter @xsu/web test:e2e`、真实 Redis 上的队列回归），原始输出留在 `Temp/out/`（不入库）。

## 已知债务

- **数据层仓储没有自动化测试。** 仓储的 SQL、并发正确性与「清理删对了哪些行」目前只靠真实库手工验
  （第 5 节）。补自动化需要一套能起临时库的集成测试形态，M2 不做；风险是 SQL 缺陷只有现场验证才抓得到——
  这一点已经被两条清理语句的失败证实过一次。
- **清理任务的回归流程是人工步骤，不是用例。** 它需要一个真实 Redis + 真实库 + 两个进程，
  塞进 `pnpm test` 会把提交级检查变重。代价是「有人改了清理却忘记跑」不会被任何自动检查拦住。
- **压测脚本未入库。** k6 场景与编排脚本现在是 `Temp/` 下的草稿，`Temp/` 不进仓库，
  即别人（以及未来的自己）无法按第 6 节复跑。M7 复跑压测之前必须把它落到 `scripts/`。
- **压测不在 CI 里。** 只在里程碑手工跑，所以「容量数字随代码漂移」不会被发现。
- **端到端的覆盖边界**（第 3.2 节）：OAuth 回调、真实 SMTP、邮箱验证链接往返、PWA 更新提示、
  全站无障碍审计都不在覆盖范围内。前两项需要外部凭证，第三项缺一个能收信的邮箱，第四项与
  Service Worker 的屏蔽策略冲突，第五项只做了公开页的 serious/critical 档。
- **`apps/web` 没有单元测试，只有端到端。** 组件与 Server Action 的细粒度分支（例如表单的边界状态）
  只能靠端到端粗粒度覆盖，失败时报错位置不如单测精确。这是有意取舍，不是遗漏。
