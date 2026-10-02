'use client';

/**
 * 公开页顶栏里的登录态入口。
 *
 * ## 为什么公开页的登录态走客户端
 *
 * 服务端读会话意味着调用 `cookies()`，那会让**整个分区**变成动态渲染，直接违反
 * `docs/ARCHITECTURE.md` 7.1 红线 1 与 `docs/ROADMAP.md` M1 退出标准 1。所以公开页顶栏
 * 读的是 `/api/auth/get-session`（由 `./client` 的 `useSession` 发起），首屏先渲染成
 * 「未登录」的形态，挂载后修正。代价是登录用户会看到一次从「登录」到「我的控制台」的
 * 变化，换来的是公开页保持静态。
 *
 * ## 加载态为什么必须有
 *
 * 没有加载态就只能在「未登录」与「已登录」之间二选一渲染首屏，两种都是有代价的：
 * 渲染「登录」会让已登录用户看到一次闪烁并可点到错误的链接；渲染空则会让顶栏高度
 * 在挂载瞬间跳一下。这里渲染一个与按钮等高的占位块，位置与尺寸都不变。
 *
 * ## 为什么不解析成 `{ name: string | null }`
 *
 * `useSession()` 的返回类型由库按客户端选项推断，这里只依赖「响应体里可能有一个
 * `user.name`」。因此做一次结构化读取（与 `sign-in-form.tsx` 的 `readFailureCode` 同一
 * 思路）：字段缺失或不是字符串时**不猜测**，但「有会话」这个事实仍然被承认——
 * `name` 取不到就退回一个固定标签，而不是把已登录用户当成未登录。
 */
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { cn } from '@/components/utils';

import { useSession } from './client';
import { CONSOLE_HOME, SIGN_IN_PATH } from './routes';

/** 会话字段缺失时的兜底标签，也用于 `name` 为空的账号。 */
const CONSOLE_LABEL = '我的控制台';

type SessionView = { signedIn: false } | { signedIn: true; name: string | null };

/**
 * 从会话响应里读出「是否已登录」与可展示的名字。
 *
 * 只走结构判断，不做 `as` 断言：这个形状来自网络响应，运行时未必符合类型。
 */
function readSessionView(data: unknown): SessionView {
  if (typeof data !== 'object' || data === null) return { signedIn: false };

  const { user } = data as { user?: unknown };
  if (typeof user !== 'object' || user === null) return { signedIn: false };

  const { name } = user as { name?: unknown };
  const trimmed = typeof name === 'string' ? name.trim() : '';

  return { signedIn: true, name: trimmed === '' ? null : trimmed };
}

export function SessionBadge({ className }: { className?: string }) {
  const { data, isPending } = useSession();

  if (isPending) {
    /*
     * 占位块的高度按 `Button` 的 `sm` 尺寸取（手机 44px、桌面 36px），宽度按最短的
     * 「登录」二字估。它是纯装饰，`aria-hidden` 掉，避免读屏器念出一个空元素。
     */
    return (
      <span aria-hidden className={cn('block h-11 w-16 rounded-md bg-muted md:h-9', className)} />
    );
  }

  const view = readSessionView(data);

  if (!view.signedIn) {
    return (
      <Button asChild size="sm" className={className}>
        <Link href={SIGN_IN_PATH}>登录</Link>
      </Button>
    );
  }

  return (
    <Button asChild size="sm" variant="outline" className={className}>
      {/*
       * `max-w-32` + `truncate` 放在内层 `<span>` 上：`Button` 的样式通过 `Slot` 落到
       * `<Link>` 上，链接本身是 flex 容器，截断必须发生在文字所在的元素上。
       */}
      <Link href={CONSOLE_HOME}>
        <span className="max-w-32 truncate">{view.name ?? CONSOLE_LABEL}</span>
      </Link>
    </Button>
  );
}
