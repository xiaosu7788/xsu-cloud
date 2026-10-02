'use client';

/**
 * 账号操作：退出登录，以及桌面侧边栏底部的账号面板。
 *
 * ## 为什么退出登录是一个客户端动作
 *
 * 退出要清掉会话 cookie，那是鉴权客户端的事（`features/auth/client.ts`）。Server Action
 * 也能做，但那样就得为一个纯粹的前端状态变更多留一条服务端入口，而它带来的唯一好处
 * ——无 JS 可用——正好对「退出登录」没有意义（没有 JS 时根本进不了已登录状态）。
 *
 * ## 退出成功之后为什么要 `router.refresh()`
 *
 * `(console)` / `(admin)` 的外壳是服务端组件，它的渲染结果已经在客户端缓存里。不刷新的话
 * 用户会看到一个「已经退出但仍然显示自己名字、点进去又被弹回登录页」的界面，这种自相矛盾
 * 的状态最容易被当成鉴权坏了。刷新之后布局重新读取会话，守卫按预期把它送去登录页。
 *
 * ## 失败不吞掉
 *
 * 退出失败（网络断开、服务端 500）时按钮回到可点状态并显示原因。不做「乐观退出」：
 * 界面显示已退出、实际会话还活着，是比多报一个错误更糟的结果。
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ThemeToggle } from '@/components/theme-toggle';
import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/components/utils';

import { signOut } from './client';

export function SignOutButton({
  className,
  variant = 'outline',
  size = 'sm',
}: {
  className?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut() {
    setPending(true);
    setError(null);
    try {
      const { error: failure } = await signOut();
      if (failure) {
        setError('退出失败，请重试。');
        return;
      }
      router.refresh();
    } catch {
      setError('退出失败，请检查网络后重试。');
    } finally {
      setPending(false);
    }
  }

  return (
    <span className={cn('inline-flex w-fit flex-col gap-1.5', className)}>
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={handleSignOut}
        disabled={pending}
        /*
         * 按钮自己占满外层：`className` 只作用在外层容器上，同时套给两处会让调用方无法
         * 单独控制其中一层（例如只想让容器占满、按钮保持内容宽度）。
         */
        className="w-full"
      >
        {pending ? '正在退出…' : '退出登录'}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/**
 * 桌面侧边栏底部的账号面板。
 *
 * 移动端的 `ResponsiveNav` 不渲染 footer，所以这里的主题切换与退出登录在手机上要靠
 * `CONSOLE_SETTINGS` 那个页面到达——两处都要保留，删掉设置页等于手机上无法退出登录。
 */
export function AccountPanel({
  name,
  email,
  className,
}: {
  name: string;
  email: string;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {/* `min-w-0` + `truncate`：邮箱可能很长，不给它收敛宽度就会把侧边栏撑宽。 */}
      <div className="min-w-0 px-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate text-xs text-muted-foreground">{email}</p>
      </div>
      <ThemeToggle />
      {/* `w-full` 交给外层而不是按钮：外层是 `inline-flex` 的胶囊容器，宽度要一起占满。 */}
      <SignOutButton className="w-full" />
    </div>
  );
}
