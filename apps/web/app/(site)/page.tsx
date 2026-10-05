/**
 * 公开首页（落地页）。
 *
 * 服务端组件，不含任何请求期 API（`cookies` / `headers` / `searchParams`），因此
 * `next build` 会把它预渲染成静态 HTML——这是 `docs/ROADMAP.md` M1 退出标准 1 的直接
 * 证据。**不要**为了「顺便显示一下登录后的欢迎语」在这里读会话，那会把首页变成动态渲染，
 * 是 `docs/ARCHITECTURE.md` 7.1 红线 1 明确禁止的；登录态已经在顶栏由 `SessionBadge`
 * 以客户端方式表达。
 *
 * ## 结构对齐参考实现，内容只说真话
 *
 * 版式（hero → 能力网格 → 上手三步）取自 `DoulorCloud-main/src/pages/landing.tsx`，
 * 但**内容全部是本站已发货的事实**（M1 账号/双主题/PWA、M2 工具箱、M3 社区、M5 后台）。
 * 参考实现的文案里有一大批本站没有的功能（排行榜、积分、商店、签到、捐赠、客户端下载），
 * 照抄等于对用户谎报产品现状——版式可以学，功能清单不能编。
 *
 * 还有一条：这份清单**必须随里程碑更新**。它此前写着「社区」与「工具箱」尚未开放，
 * 而两者在 M3 / M2 就已落地，等于首页在否认自己的功能。新增模块时把入口加进
 * `SITE_NAV_ITEMS`（`(site)/layout.tsx`）与下面的 `FEATURES`，两处都要改。
 *
 * ## 卡片悬停位移
 *
 * `hover:-translate-y-1` 只在能悬停的精确指针设备上有意义，触屏下没有 hover 状态，
 * 不会误触发。`motion-reduce:` 关掉位移，尊重系统的减少动效偏好。
 */
import Link from 'next/link';
import { ArrowRight, Gauge, LayoutGrid, MessagesSquare, ShieldCheck, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { CONSOLE_HOME, SIGN_IN_PATH, SIGN_UP_PATH } from '@/features/auth/routes';
import { COMMUNITY_HOME } from '@/features/community/routes';
import { TOOLS_HOME } from '@/features/tools/routes';

/** 已发货的能力。`href` 必须是**确实存在**的页面。 */
const FEATURES: ReadonlyArray<{
  icon: LucideIcon;
  title: string;
  points: readonly string[];
  href: string;
  cta: string;
}> = [
  {
    icon: LayoutGrid,
    title: '账号与控制台',
    points: [
      '邮箱注册登录，邀请码准入',
      '浅色 / 深色双主题，跟随系统并可手动锁定',
      'PWA 可安装，移动端有独立导航壳',
    ],
    href: CONSOLE_HOME,
    cta: '进入控制台',
  },
  {
    icon: Wrench,
    title: '工具箱',
    points: [
      '一批不依赖外部服务的小工具，纯函数实现',
      '每次执行都在运行历史里留一条记录，只有本人可见',
      '每账号每小时有限额，超限返回明确错误码',
    ],
    href: TOOLS_HOME,
    cta: '打开工具箱',
  },
  {
    icon: MessagesSquare,
    title: '社区',
    points: [
      '发帖、评论、标签与搜索',
      '点赞计数走缓存，公开时间线按需渲染',
      '举报进入后台队列，由管理员确认后才下架',
    ],
    href: COMMUNITY_HOME,
    cta: '浏览社区',
  },
];

/** 已排期、尚未落地的模块。写在这里是为了让「还没有」成为一个明确的事实。 */
const PENDING_MODULES = [
  { name: '中转站', scope: '入口与控制台', milestone: 'M4' },
  { name: '生图工作台', scope: '任务提交与结果画廊', milestone: 'M6' },
];

/** 上手的三个台阶。第一条不登录也能做，所以它指公开页而不是账号页。 */
const STEPS = [
  {
    title: '先看公开部分',
    description: '工具箱清单与社区时间线不需要登录就能浏览。',
  },
  {
    title: '注册或登录',
    description: '注册需要邀请码——这个站是私有的，不对公网开放注册。',
  },
  {
    title: '进入控制台',
    description: '执行工具、发帖、查看只属于你的运行历史。',
  },
];

export default function SiteHomePage() {
  return (
    <>
      {/* Hero：居中、大标题、一对 CTA。`text-balance` 让两行标题的长度尽量均衡。 */}
      <section className="flex flex-col items-center gap-6 py-16 text-center sm:py-24">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs font-medium text-muted-foreground">
          <ShieldCheck aria-hidden className="size-3.5" />
          自托管 · 单机部署
        </span>
        <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          xsu-cloud
        </h1>
        <p className="max-w-2xl text-balance text-base text-muted-foreground sm:text-lg">
          一个个人云站：工具箱、社区与后台管理都在这里，数据留在自己的机器上。
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg">
            <Link href={SIGN_IN_PATH}>
              登录
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href={SIGN_UP_PATH}>注册</Link>
          </Button>
        </div>
      </section>

      {/* 能力网格：卡片带图标、要点列表与「进去看看」入口。 */}
      <section aria-labelledby="features-heading" className="py-12 sm:py-16">
        <div className="mb-10 text-center">
          <h2 id="features-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">
            已经能用的部分
          </h2>
          <p className="mx-auto mt-2 max-w-2xl text-muted-foreground">
            下面每一项都点得开。没做完的模块单独列在最下面，不会伪装成可用入口。
          </p>
        </div>

        {/* 移动端单列、宽屏三列：`docs/PRD.md` 4.1 要求 360px 无横向滚动。 */}
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <li
              key={feature.title}
              className="flex flex-col rounded-2xl border border-border bg-card/70 p-6 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-foreground/20 hover:shadow-xl motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            >
              <span className="mb-4 inline-flex w-fit rounded-md border border-border bg-background p-2">
                <feature.icon aria-hidden className="size-4 text-muted-foreground" />
              </span>
              <h3 className="mb-2 font-medium">{feature.title}</h3>
              <ul className="mb-4 flex flex-col gap-1.5">
                {feature.points.map((point) => (
                  <li key={point} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <span
                      aria-hidden
                      className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/60"
                    />
                    {point}
                  </li>
                ))}
              </ul>
              {/* `mt-auto` 让三张卡片的入口对齐在同一条基线上。 */}
              <Link
                href={feature.href}
                className="mt-auto inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
              >
                {feature.cta}
                <ArrowRight aria-hidden className="size-3.5" />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* 上手三步 */}
      <section aria-labelledby="how-heading" className="py-12 sm:py-16">
        <div className="mb-10 text-center">
          <h2 id="how-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">
            怎么开始
          </h2>
        </div>
        <ol className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className="rounded-2xl border border-border bg-card/70 p-6 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-foreground/20 hover:shadow-xl motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            >
              <span className="mb-3 inline-flex size-7 items-center justify-center rounded-full border border-border bg-background text-sm font-medium text-muted-foreground">
                {index + 1}
              </span>
              <h3 className="mb-1.5 font-medium">{step.title}</h3>
              <p className="text-sm text-muted-foreground">{step.description}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* 尚未落地：明确写出来，而不是留一个点进去 404 的入口。 */}
      <section aria-labelledby="pending-heading" className="pb-16 pt-12 sm:pt-16">
        <div className="rounded-2xl border border-dashed border-border p-6">
          <h2 id="pending-heading" className="mb-1 flex items-center gap-2 text-lg font-semibold">
            <Gauge aria-hidden className="size-4 text-muted-foreground" />
            排期中
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            这些模块还没写代码。导航里不会出现它们的入口——放一个点进去 404 的链接比少一个入口更糟。
          </p>
          <ul className="grid gap-3 sm:grid-cols-2">
            {PENDING_MODULES.map((module) => (
              <li key={module.name} className="rounded-md border border-border px-3 py-2">
                <p className="text-sm font-medium">{module.name}</p>
                <p className="text-xs text-muted-foreground">
                  {module.scope} · 计划 {module.milestone}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
