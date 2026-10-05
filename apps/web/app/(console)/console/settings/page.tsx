/**
 * 账号设置。
 *
 * ## 为什么这一页自己要再守一次
 *
 * `(console)/layout.tsx` 已经守过一道，但布局守的是「直接访问这个地址」。分区内部跳转时
 * Next 的路由缓存可能复用没有变化的布局段，服务端不再执行布局——会话正好在这期间失效时，
 * 本页会在「布局守卫没有运行」的情况下渲染。所以凡是要用用户信息的页面都必须自己再读一次。
 * 读的是同一个 `readSessionUser()`，一个请求内被 `React.cache()` 收口，不会多一次数据库往返。
 * 拒绝的翻译仍然只有 `features/auth/guard.ts` 一处，这里不另写文案。
 *
 * ## 移动端的主要出口
 *
 * `ResponsiveNav` 在移动端不渲染侧边栏底部的 `AccountPanel`，因此这一页是手机上退出登录与
 * 切换主题的唯一入口。它必须一直可从底部导航到达（见 `(console)/layout.tsx` 的入口清单）。
 *
 * ## 只读展示，不提供编辑
 *
 * M1 的交付物是「会话 + 角色 + 邀请码准入」，个人资料的写入不在其中。所以这里只显示现状，
 * 并明确列出还没做的项——不放几个禁用的输入框假装快要能用。
 */
import type { Metadata } from 'next';

import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { AccessDenied } from '@/features/auth/access-denied';
import { AccountPanel } from '@/features/auth/account-panel';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readConsoleAccess } from '@/features/auth/session';

export const metadata: Metadata = {
  title: '账号设置',
};

/** 尚未提供的能力。列出来是为了让「没有」是明确的，而不是用户找不到入口。 */
const PENDING_ACTIONS = [
  '修改昵称与头像',
  '更换登录邮箱（需重新验证）',
  '修改密码与已登录设备管理',
  '绑定或解绑第三方账号（策略是不自动关联，绑定须已登录后主动发起）',
];

export default async function ConsoleSettingsPage() {
  const access = await readConsoleAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="账号设置" description="当前登录账号与外观设置。" />

      <Card>
        <CardHeader>
          <CardTitle>账号</CardTitle>
          <CardDescription>邮箱在注册时确定，本阶段不能修改。</CardDescription>
        </CardHeader>
        <CardContent>
          {/* 复用侧边栏底部那块面板：同一组操作不该有两套实现。 */}
          <AccountPanel name={access.user.name} email={access.user.email} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>尚未提供</CardTitle>
          <CardDescription>以下能力还没做，接口与界面都没有。</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
            {PENDING_ACTIONS.map((action) => (
              <li key={action} className="flex gap-2">
                <span aria-hidden>·</span>
                <span>{action}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
