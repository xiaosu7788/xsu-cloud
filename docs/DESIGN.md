# DESIGN — xsu-cloud

本文件回答「视觉与交互的基线是什么、为什么这么定、哪些地方**刻意不照抄**参考实现」。**A 级文档：设计 token、
共享组件契约或对比度结论变化时不同步就阻断合并。**

范围与验收标准见 [`PRD.md`](PRD.md)，模块边界见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，
强制约束与红线见 [`../AGENTS.md`](../AGENTS.md)。参考实现是 `DoulorCloud-main`（仓库外，只读对照）。

---

## 1. 基线来源与对齐方式

设计系统基线对齐 `DoulorCloud-main/src/index.css` 与它的共享组件。对齐的口径是**语义与结构**，不是像素复制：
同一个位置的元素、同一套间距与层级语义照搬，值按本站的可访问性红线重算。

实现落在两处：

| 位置 | 内容 |
| --- | --- |
| `apps/web/app/globals.css` | 设计 token 的值（`:root` / `.dark`）、`@theme inline` 命名空间、`@utility` 工具类、关键帧 |
| `apps/web/components/*.tsx` | 共享表现组件（`page-header` / `empty-state` / `page-enter` / `data-fade` / `cursor-effect` 等） |

## 2. 三处刻意不照抄（对比度实算）

三处偏离都是为了过 WCAG 门槛，属于**有意差异**：照抄会直接触发 axe 的 serious 违规，或让焦点指示器不可见。
数值口径为 WCAG 2.x 相对亮度对比度，实算而非估算。

| token | 参考实现 | 本站 | 实算结果 | 结论 |
| --- | --- | --- | --- | --- |
| `--muted-foreground` | `0.556` | `0.505` | 参考实现落在 `--muted`（0.97）上仅 **4.34:1**，低于正文 AA 的 4.5:1 | 保留 `0.505` |
| `--destructive` | `0.577 0.245 27.325` | `0.505 0.213 27.518` | 同上，参考实现的对比度不达标 | 保留本站色 |
| `--ring`（浅色） | `0.708`（约 `#a1a1a1`） | `0.556` | 参考实现白底 **2.59:1**，低于 WCAG 1.4.11 对非文本对比度的 3:1 | 保留 `0.556` |

`--ring` 是键盘焦点的唯一可见指示：它低于 3:1 时，纯键盘用户在白底上看不清焦点落在哪。
换掉 `--muted-foreground` 则会连带影响全站的次要文字（说明文字、表格副行、placeholder）。

`Badge` 的 `success` 变体同样按此口径偏离参考实现：`text-emerald-700`（约 4.6:1）而不是 `text-emerald-600`
（在 15% emerald-500 底上约 4.0:1，低于 AA）；深色档 `dark:text-emerald-400`（约 6.2:1）。
emerald 是全项目唯一硬编码色相——只此一处，不进 token。

## 3. 字体

全站正文用 **Outfit**，自托管可变字体（`apps/web/public/fonts/outfit-var.woff2`，32 KB，一个文件覆盖
100–900 全部字重）。字体栈的唯一来源是 `--font-app`，`@theme inline` 与 `html` 都从它取值，改字体只改一处。

**`@font-face` 的 `unicode-range` 只含拉丁字符集，不能删。** 中文不在范围内，会自动回退到系统字体栈
（苹方 / 微软雅黑 / Noto Sans SC）。删掉 `unicode-range` 后浏览器会把中文也交给 Outfit，而 Outfit 没有中文字形
⇒ 中文整片变豆腐块。收益是拿到自定义字体的观感，同时不必背负几 MB 的中文字体。

## 4. 层次：玻璃面板与云纹底纹

### 4.1 三档 `glass-*`

外壳（顶栏 / 侧边栏 / 卡片）用半透明面板，透明度由 `color-mix` 从 `--card` 派生，因此明暗主题自动适配，
不需要两处硬编码的百分比：

| 工具类 | 派生比例 | 模糊 / 饱和 | 用在哪 |
| --- | --- | --- | --- |
| `glass-panel` | `--card` 68% | `blur(14px) saturate(1.5)` | 公开站顶栏、移动底部 Tab |
| `glass-sidebar` | `--card` 86% | `blur(10px) saturate(1.3)` | 控制台 / 后台桌面侧边栏（面积大，模糊要给足） |
| `glass-card` | `--card` 86% | `blur(6px) saturate(1.2)` | 浮在底纹上的内容卡片 |

`.dark` 下三档各加一道 inset 高光描边——深色里半透明面板与背景的明度差很小，没有这道描边就看不出边界。

**Tailwind 4 会 tree-shake 未被引用的 `@utility`。** `glass-*` 与 `shimmer` 只在源文件里出现才会产出到
产物 CSS；改完这些类名后如果图标「突然不糊了」，先查引用而不是查 CSS。

### 4.2 云纹底纹的两条红线

`body::before` 铺一层云纹 SVG mask 作为全站底纹（`z-index: -1`、`pointer-events: none`）。它靠
「body 背景色传播到画布」这条 CSS 规则维持可见，因此：

1. **绝不给 `html` 设 background。** 一旦设了，body 的背景不再传播到画布，`z-index: -1` 的 `::before`
   会被压住而整片消失。
2. **不要再给 body 叠一层不透明背景**，同上理。

这两条在运行时探针里有对应断言（`html` 计算背景为 `rgba(0, 0, 0, 0)` 且 `background-image: none`）。

## 5. 动效

| 名称 | 位置 | 用途与约束 |
| --- | --- | --- |
| `page-enter` | `globals.css` `.page-enter > * > *` | 切页时页面区块依次淡入（0.42s，`cubic-bezier(0.16, 1, 0.3, 1)`），nth-child 1–8 递增、`n+9` 停住（再往后拖会让底部内容等太久） |
| `data-fade` | `.data-fade` + `DataFade` | 「骨架 → 内容」交叉淡化。叠放靠 CSS grid 的同一格（`grid-area: 1/1`），不用绝对定位（后者会让容器高度塌成 0） |
| `cursor-glow` | `.cursor-glow` + `CursorGlow` | 深色下的光标光晕。仅「精确指针 **且** 深色」时挂载，浅色与触屏下整条 rAF 循环不启动 |

**外壳不参与入场动画。** `PageEnter` 只包内容区，顶栏 / 侧边栏 / 底部 Tab 留在它外面：包进去的话点一次导航
整个外壳都会跟着闪一下——外壳不变，变的是内容。

`prefers-reduced-motion: reduce` 下全部动效降级为瞬时（`globals.css` 末尾统一收口）。

## 6. 组件契约

- **`PageHeader`**（`components/page-header.tsx`）：`title: string` + `description?: ReactNode` + `actions?: ReactNode`。
  `title` 收 `string` 不收节点——收节点会让 `<h1>` 里塞进徽章与按钮，那些东西的可访问名称会并进标题文本里。
  `description` 相反地收 `ReactNode`：它渲染在 `<p>` 里，进不去可访问名称，而站内确有说明文字中间嵌链接。
  **不自带外边距**：页面容器一律是 `flex flex-col gap-6`，组件自带的 `mb-*` 会与 `gap-6` 叠加成 56px，
  于是「用组件的页面」和「不用的页面」间距不一致——而统一间距正是这个组件存在的理由。
- **`EmptyState`**（`components/empty-state.tsx`）：`title` + `description?` + `action?` + `icon?`。
  空态要同时回答「这里本来是干什么的」「为什么现在是空的」「下一步能做什么」，只写一行「暂无数据」
  等于把前两个问题丢给用户猜。虚线边框而不是实线卡片：空态不是内容，实线卡片会被当成加载失败的数据卡。

## 7. 移植状态：已落地 / 待接线

从参考实现移植了 7 个共享组件。**接线状态必须诚实记录**，否则未使用的组件会静默腐烂：

| 组件 | 状态 | 说明 |
| --- | --- | --- |
| `page-header` | 已接线 | 19 个页面 |
| `empty-state` | 已接线 | 公开社区索引 / 标签页 / 搜索页、控制台「我的帖子」 |
| `page-enter` | 已接线 | `(site)` 与控制台外壳的内容区 |
| `cursor-effect` | 已接线 | 根布局，仅深色 + 精确指针下挂载 |
| `badge` | **待接线** | 本站已有自己的状态徽章约定 `adminStatusBadge(tone)`（`features/admin/view.tsx`），三个后台页在用它。接线前必须先统一到一处，否则会出现两套状态样式——正好违背 `PageHeader` 想解决的问题 |
| `skeleton` | **待接线** | 与 `DataFade` 成对使用 |
| `data-fade` | **待接线** | 当前架构下没有调用点：全部页面服务端渲染，唯一的客户端取数是 `like-button`，而它按自己的注释刻意不做 loading（「点赞是最轻的写操作，为它转一圈 loading 不值得」）。等出现真正的客户端分页 / 异步区块时接线 |

**明确不移植**：参考实现的 `role-sheen` / `role-ring` / `title-ring` 与 `.markdown-body`。前三个是它
「自定义称号」功能专用的装饰，本站没有该功能；`.markdown-body` 等本站真的引入 markdown 渲染时再补。

## 8. 验证方式

设计系统不是靠肉眼确认的，靠两条可重跑的证据：

1. **产物 CSS 存在性**：Tailwind 4 会 tree-shake 未引用的 `@utility`，所以必须验证 `glass-panel` /
   `glass-sidebar` / `glass-card` 与 `page-enter` / `data-fade-in` 关键帧**真的进了产物**，而不是被摇掉。
2. **运行时计算值**：`color-mix` 的透明度、`backdrop-filter`、`body::before` 的 mask 与 `z-index`、
   `CursorGlow` 的挂载条件与 `z-index`，都按真实浏览器的 `getComputedStyle` 断言。

注意：Chromium 会把 `color-mix(in oklab, …)` 序列化成 `oklab(l a b / 0.68)` 而不是 `rgba(...)`，
解析透明度的断言必须同时支持两种格式，否则会把「玻璃生效」误判为失败。

**对比度**由 e2e 的 axe 用例守住（`public-pages.spec.ts`，`/` 与 `/sign-in` 各一条，门槛为无
serious / critical 违规）。改 token 后先跑这两条。

## 9. 已知债务

- **`badge` / `skeleton` / `data-fade` 三个组件已移植但未接线**（见第 7 节）。当前架构下它们没有调用点，
  属于「先落组件、后落用法」。在出现真实调用点之前，它们不受任何 e2e 覆盖——改这三个文件不会让任何用例变红。
- **`badge` 与既有的 `adminStatusBadge` 是两套状态样式。** 接线前必须先统一：否则同一个后台页面里
  会出现两种状态徽章外观，而这正是 `PageHeader` 当初要消除的那类分叉。统一方案未定。
- **`glass-card` 目前无引用者。** 它和 `glass-panel` / `glass-sidebar` 一起写在 `globals.css`，
  但没有任何源文件用它；按 Tailwind 4 的行为，它只因为同组规则被引用而留在产物里（运行时探针确认为
  `.dark .glass-card` 命中）。如果将来清掉 `.dark` 档的引用，浅色档会一起被摇掉。
- **设计 token 的对比度结论是手工实算，不随 CI 自动重算。** e2e 的 axe 用例守的是「当前渲染结果」，
  它不会在有人改动 `--ring` 的 oklch 数值后主动报错——除非该改动造成实际违规。改这三个 token 时
  必须重跑 axe 两条用例，并手动复核第 2 节的数字。
- **没有视觉回归快照。** 玻璃、底纹、动效的「观感」只在计算值层面被断言（透明度、模糊、z-index、
  挂载条件），没有任何像素级或截图对比。跨浏览器的观感差异（尤其是 Safari 的 `backdrop-filter`
  与 `color-mix` 渲染）没有在本机验证过。
