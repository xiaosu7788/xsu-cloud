# SPEC — 纯站内社交功能（通知 / 私信 / 个人空间 / 签到 / 积分 / 成就）

本文件是这一批功能的**可执行规格**。事实来源是参考实现 `DoulorCloud-main` 的
`worker/migrations/*.sql`（125 个迁移）与 `worker/src/handlers/`，**不是它的 UI 文案**。

**范围界定（用户 2026-10-05 选定）**：只做**不依赖外部系统**的那批。判定标准是「只用
Postgres + Redis + 现有 worker 就能完整实现」。凡是需要 DNS / SMTP+IMAP / S3 / AI 凭证 /
frps / 支付渠道的，都不在本批，仍留在 ROADMAP 的 M4 / M6 里。

---

## 1. 范围：做什么、不做什么

### 1.1 本批要做（依赖顺序）

| 序 | 功能 | 新表 | 依赖 |
| --- | --- | --- | --- |
| 1 | 通知（站内消息箱 + 未读角标） | `notifications` | 无 |
| 2 | 私信（一对一 + 防骚扰申请） | `direct_messages`、`dm_contacts` | 通知（入站时产生通知） |
| 3 | 个人空间页 `/space/[username]` | `user_spaces`、`user_stats` | 无（数据从现有表实时算） |
| 4 | 每日签到 | `daily_checkins` | 积分 |
| 5 | 积分（余额 + 流水） | `user_points`、`point_transactions` | 无 |
| 6 | 成就（实时计算 + 解锁时间） | `user_achievements` | `user_stats` |

顺序即依赖顺序：通知最先（私信要往里写），积分早于签到（签到要发积分）。

### 1.2 本批明确不做

| 不做 | 为什么 |
| --- | --- |
| 积分商城 / 商品 / 订单 / 售后 | 需要交付内容（中转站余额、订阅码），属 M4 的外部系统；本批只做**积分账本**，不做出入口 |
| 成就奖励换成外部订阅 | 参考实现的 `achievement_rewards` 发的是 NewAPI 订阅，xsu 没有该外部系统。本批成就不发实物奖励，只记解锁时间 |
| 活动系统（`events` / `event_claims`） | 管理员发放的奖励类型全部指向外部系统 |
| 排行榜 | 需要跨用户聚合查询与缓存策略，单独一批；等积分/成就落地后数据才有意义 |
| 捐献 / 反馈 / 举报之外的申诉 | 捐献需要支付渠道；反馈并入现有 `reports` 语义不同，单列 |
| 聊天室（公共房间） | 需要 WebSocket 或轮询 + 房间语义，与私信不是一回事 |
| 表情包 / 自定义称号 / 名片（profiles） | 名片是与空间并列的另一套展示页，各自独立；本批只做「空间」 |
| 签到里程碑的额外奖励梯度 | 参照实现有，但梯度值需要产品决策，先做基础奖励（见 4.3） |

---

## 2. 与参考实现的关键差异（**必读**）

参考实现是 **Cloudflare D1（SQLite）**，xsu 是 **Postgres 17**。以下不是风格差异，
是必须翻译的语义差异：

| 参考实现（SQLite / D1） | xsu（Postgres） | 理由 |
| --- | --- | --- |
| 主键用 `lower(hex(randomblob(16)))` | 领域层生成 uuid（现有约定） | 与 `posts` / `tools` 一致 |
| 时间存 `TEXT` ISO 串 | `timestamptz` + `defaultNow()` | 与现有表一致，可比较可索引 |
| 布尔用 `INTEGER 0/1` | `boolean` | 同上 |
| `INSERT OR IGNORE` 做幂等 | `ON CONFLICT DO NOTHING` + 主键/唯一索引 | 同上，幂等由约束保证而不是先查后写 |
| `randomblob` / `hex` | `gen_random_uuid()`（迁移里） | Postgres 原生 |
| 部分唯一索引写 `WHERE dedup_key IS NOT NULL` | 同语法，Postgres 支持 | 无差异 |
| 触发器手写 SQL | 同（drizzle-kit 不表达触发器） | 与 M3 的 `audit_logs` 触发器同一做法 |

**没有任何一处照抄参考实现的 UI 文案**：它的文案面向「多租户 SaaS + 捐献体系」，
本站是个人云站，文案按本站语义重写。

---

## 3. 表结构

### 3.1 `notifications`（通知，本批第 1 项）

```sql
notifications(
  id          text primary key,
  recipient_id text not null references user(id) on delete cascade,  -- 收件人
  category    text not null,   -- 'system' | 'site' | 'social'
  type        text not null,   -- 'post_comment' | 'comment_reply' | 'dm_request' | 'dm_message' | ...
  actor_id    text references user(id) on delete set null,  -- 触发者，系统通知为 null
  post_id     text references posts(id) on delete cascade,  -- 可空，社交类才有
  comment_id  text references comments(id) on delete cascade,
  link        text,            -- 站内跳转路径
  title       text,
  body        text,
  dedup_key   text,            -- 幂等键，null 表示不去重
  read        boolean not null default false,
  created_at  timestamptz not null default now()
)
```

索引与约束：

- `notifications_recipient_idx (recipient_id, read, created_at)` —— 未读角标与消息箱列表
- `notifications_recipient_category_idx (recipient_id, category, created_at)` —— 按分类筛选
- `notifications_dedup_unique_idx unique (recipient_id, dedup_key) where dedup_key is not null`

**设计理由**

1. **`category` 与 `type` 分开。** `category` 是三档粗分类（课程/系统/站内/社交），用于
   tab 切换；`type` 是细粒度动作标识，用于选图标与文案。参考实现也是这两层，但它把
   `category` 默认设成 `'social'` 再靠迁移回填——本站新建表，直接要求显式传值。
2. **`dedup_key` 是幂等的唯一手段。** 「同一个人对同一个帖子点赞一次只留一条通知」这类
   要求靠唯一索引实现，不靠「先查再插」——后者在并发下会重复。这是参考实现踩过的坑
   （它的迁移注释里写明「点赞从无到有只留一条」）。
3. **`actor_id` 用 `set null`。** 触发者注销后通知还在（收件人仍应看到「有人评论过你」），
   但不再显示具体是谁。与 `reports.handled_by` 同一取舍。
4. **`post_id` / `comment_id` 用 `cascade`。** 被评论的帖子硬删时，指向它的通知失去意义。
   注意 `posts` / `comments` 在本站是**软删除**（M3），所以正常路径下不会触发级联。

### 3.2 `direct_messages` / `dm_contacts`（私信，本批第 2 项）

```sql
direct_messages(
  id           text primary key,
  from_user_id text not null references user(id) on delete cascade,
  to_user_id   text not null references user(id) on delete cascade,
  body         text not null,
  created_at   timestamptz not null default now(),
  read_at      timestamptz     -- 收件人读这条的时间；null = 未读
)
```

索引：`(from_user_id, to_user_id, created_at)`、`(to_user_id, from_user_id, created_at)`、
`(to_user_id, read_at, created_at)`（未读数与会话列表）。

```sql
dm_contacts(
  owner_id   text not null references user(id) on delete cascade,  -- 收到申请的人
  peer_id    text not null references user(id) on delete cascade,  -- 发起申请的人
  status     text not null,   -- 'request' | 'accepted' | 'declined'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, peer_id)
)
```

索引：主键 `(owner_id, peer_id)`；`(owner_id, status)`（我收到的待处理申请）、
`(peer_id, status)`（反查「我与某人是否已有关系」）。

**设计理由（这是本批最需要解释的一块）**

1. **私信不复用 `notifications`。** 通知是**单向**的（收件人 + 触发者），没有「对话」
   概念。拿它做私聊会把系统消息与对话混在一起，且无法表达「这条读没读、对端是谁」。
   参考实现的迁移注释写了同一条理由。
2. **已读只用一个 `read_at`，不要位点表。** 一对一私聊，一条消息只需要一个「收件人读了
   吗」，未读数 = `to_user_id = 我 AND read_at is null`。参考实现试过单独的表，最后收敛到
   这一列。
3. **防骚扰：默认只允许发一条申请。** 这是参考实现上线后由站长要求补的（迁移
   `0091_dm_contacts.sql` 的注释），**本批直接内建**：`dm_contacts` 的方向是
   `owner_id = 收件人`、`peer_id = 发起者`。
   - 无关系 → 发第一条消息时原子地建 `status='request'` 行，且**只允许这一条**
   - `accepted` → 自由互发
   - `declined` → 发起者不能再发
4. **三种免申请情形**（在领域层判断，不落表）：① 收件人是管理员；② 收件人是自己
   （应当直接拒绝，见 4.4）；③ 双方已有 `accepted` 关系。交易关系（订单）不适用本站。

### 3.3 `user_spaces` / `user_stats`（个人空间，本批第 3 项）

```sql
user_spaces(
  user_id            text primary key references user(id) on delete cascade,
  show_stats         boolean not null default true,
  show_posts         boolean not null default true,
  show_achievements  boolean not null default true,
  motto              text,          -- 一句话签名，null/空 = 不显示
  updated_at         timestamptz not null default now()
)

user_stats(
  user_id        text primary key references user(id) on delete cascade,
  visit_count    integer not null default 0,   -- 登录访问累计次数
  last_visit_at  timestamptz                   -- 节流用：同一会话 1 小时内只计一次
)
```

**设计理由**

1. **空间页是「数据驱动」的，只有展示设置落库。** 帖子、积分、成就全部实时从各业务表
   算出来，不冗余存一份——冗余就会不一致。这与 M3 的标签取舍一致（能用实时算的就不落库）。
2. **`user_stats` 存在是必要的**：`visit_count` 是累计量，没有别的表能推出来。
   节流靠 `last_visit_at`（参考实现的做法），否则每次请求都 +1。
3. **`show_*` 三个开关默认全开。** 用户关掉后空间页对应分区消失。

### 3.4 `user_points` / `point_transactions`（积分，本批第 5 项）

```sql
user_points(
  user_id    text primary key references user(id) on delete cascade,
  balance    integer not null default 0,
  updated_at timestamptz not null default now()
)

point_transactions(
  id         text primary key,
  user_id    text not null references user(id) on delete cascade,
  delta      integer not null,          -- 正数加、负数减
  balance    integer not null,          -- 变动**后**的余额快照
  reason     text not null,             -- 'checkin' | 'admin' | ...
  detail     text,
  dedup_key  text,                      -- 幂等键，null 不去重
  created_by text references user(id) on delete set null,
  created_at timestamptz not null default now()
)
```

索引：`unique (user_id, dedup_key) where dedup_key is not null`、`(user_id, created_at desc)`。

**设计理由**

1. **余额单独一张窄表，不塞进 `user`。** 积分变动频繁；写 `user` 那张宽表会牵连其它字段的
   更新时间与缓存，而且「加积分」这件事会有多个入口。窄表单入口（`applyPoints`）更干净。
   参考实现的迁移注释写了这条。
2. **流水必须留痕且带幂等键。** 用户要能自查「我的积分去哪了」。`dedup_key` 让
   「同一次签到只发一次」在并发下也成立——参考实现用它做活动领取去重。
3. **`balance` 快照可能偏差，以 `user_points.balance` 为准。** 这是参考实现明确写下的
   取舍：并发下快照与真实余额可能差一笔，流水只用于对账展示，不作为事实来源。
4. **不发外部资产。** 参考实现的积分能兑换中转站余额；本站只记账本，没有兑换出口
   （见 1.2）。因此 `reason` 的枚举里**没有 `redeem`**。

### 3.5 `daily_checkins`（签到，本批第 4 项）

```sql
daily_checkins(
  user_id      text not null references user(id) on delete cascade,
  checkin_date date not null,       -- 站点时区（UTC+8）的日历日
  points       integer not null,    -- 本次实际发放合计
  base_points  integer not null,
  bonus_points integer not null default 0,
  streak       integer not null,    -- 本次签到后的连续天数
  created_at   timestamptz not null default now(),
  primary key (user_id, checkin_date)
)
```

索引：主键 `(user_id, checkin_date)`；`(user_id, checkin_date)` 普通索引（按日期倒序取
最近一条算连续天数）。

**设计理由**

1. **主键就是并发防线。** `(user_id, checkin_date)` 让重复签到变成一次唯一约束冲突，
   仓储用 `ON CONFLICT DO NOTHING` 翻译成「今天已签到」，不依赖先查后写。
2. **日期按站点时区的日历日，不是 UTC 日期。** 参考实现踩过这个坑（迁移注释原文：
   「否则中国用户晚上 8 点之后签到会被算成第二天」）。本站时区常量应与
   `docs/DATA-MODEL.md` 里的口径一致；实现时集中在领域层一个函数里，不散落。
3. **`streak` 冗余存一列。** 连续天数每次都要展示，实时算需要扫全部历史；存下来只多一列。
   参考实现也存。
4. **`base_points` 与 `bonus_points` 分开存。** 便于将来加里程碑梯度时对账，不必回填历史行。

### 3.6 `user_achievements`（成就，本批第 6 项）

```sql
user_achievements(
  user_id        text not null references user(id) on delete cascade,
  achievement_id text not null,
  level          integer not null,
  unlocked_at    timestamptz not null default now(),
  primary key (user_id, achievement_id, level)
)
```

索引：主键 `(user_id, achievement_id, level)`；`(user_id)` 普通索引（空间页列出某人的
解锁记录）。

**设计理由**

1. **成就是「纯计算」的，这张表只记解锁时间。** 进度每次按当前数据实时算（不落库），
   这张表记录「首次达成某成就某等级的时间」。参考实现的做法及其注释都指向这一点。
2. **等级回落不删历史行。** 资源被删导致等级下降时，历史记录保留，页面展示「历史最高
   等级」与首次解锁时间；当前等级以实时计算为准。这是参考实现明确的设计。
3. **`achievement_id` 无外键。** 成就定义在代码里（编译期常量，同 `tools` 注册表），
   不是数据库行。删掉一个成就定义后旧解锁行会成为孤儿——可接受，登记在已知债务里。

---

## 4. 领域规则（在 `packages/core`，判定与 IO 分离）

### 4.1 通用红线（沿用现有）

- 归属判定（红线 6）：私信只能读自己的会话；空间页的展示设置只有本人能改。
- 所有写操作的时间点由领域层传入，仓储不用 `$onUpdate`（与 `posts` 一致）。
- 配额类限制用现有 `site_config 覆盖 > env 默认 > core 常量` 优先级。

### 4.2 通知

- 创建通知时**必须**给 `dedup_key`（除系统广播类），否则幂等无法保证。
- 不给自己发通知：`actor_id === recipient_id` 时直接跳过（同 M3 的评论通知思路）。
- 未读数只算 `read = false`。

### 4.3 签到与积分

- **一天只能签一次**（主键保证），重复签到返回幂等结果而不是错误。
- 基础奖励：`CHECKIN_BASE_POINTS` 常量（初值 5）。
- 连续天数：与昨日签到相邻则 `streak + 1`，否则重置为 1。跨月/跨年按日期差算，
  不按「月份」算。
- 里程碑奖励：本批**不做梯度**（见 1.2），`bonus_points` 恒为 0，但列保留。
- 发放积分与写签到行**必须在同一事务**里：否则会出现「签到成功但没拿到分」。
- `applyPoints` 是唯一的积分入口，必须同时写 `user_points` 与 `point_transactions`。

### 4.4 私信

- 不能给自己发（`from === to` 直接拒绝）。
- 首条消息的原子性：在没有 `accepted` 关系时，发第一条消息必须
  **同时**建 `dm_contacts(status='request')` 并插入消息；第二个请求应当被
  `dm_contacts` 主键挡下并返回「等待对方同意」。
- 被拒（`declined`）后不能再发。
- 读会话时把该会话内 `to_user_id = 我 AND read_at is null` 的行标记为已读。
- 管理员豁免：收件人是管理员时不受「先申请」限制。

### 4.5 个人空间

- 访问自己：全部展示（无视开关）。
- 访问他人：按对方开关裁剪；关掉的分区**不下发数据**（不是 CSS 隐藏）。
- `visit_count` 节流：同一用户 1 小时内只 +1。

---

## 5. 怎么验证

1. **领域层单测**（`packages/core/tests/`）：签到跨日/连续天数、积分幂等与事务、
   私信申请三态流转、通知去重、空间开关裁剪。按现有门槛，
   `packages/core` 分支覆盖率 **≥ 80%**。
2. **迁移实跑**：`pnpm --filter @xsu/db db:check` 无 drift，`db:migrate` 后表数与
   索引数用 `psql` 核对。
3. **端到端**（`apps/web/e2e/`）：签到 → 积分余额变化 → 流水可见；私信申请 →
   对方同意 → 双向发送；通知未读角标进入后归零；空间页开关生效。
   双视口，沿用现有 44px / 无横向滚动 / axe 断言。
4. **不变量**：积分余额 = 所有流水 `delta` 之和（单测里对拍）。

---

## 6. 已知债务（开工前就登记）

- `achievement_id` 无外键，成就定义从代码里移除后解锁行成孤儿。
- 积分流水里的 `balance` 快照在并发下可能偏差一笔（以 `user_points.balance` 为准）。
- 没有积分兑换出口：账本只进不出，`reason` 里没有 `redeem`。
- 签到里程碑梯度、排行榜、积分商城、聊天室、名片（profiles）都不在本批。
- 私信的免申请规则只实现「管理员豁免」与「已 accepted」，没有交易关系豁免
  （本站没有订单系统）。
- 通知的 `category` 只有三档；参考实现的四档里有「活动」一档，本站没有活动系统。
