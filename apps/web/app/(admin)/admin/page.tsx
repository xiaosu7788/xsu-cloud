/**
 * 后台概览。
 *
 * 这一页自己守一次的理由与 `(console)/console/settings/page.tsx` 相同：布局守的是直接访问，
 * 分区内部跳转时布局段可能被路由缓存复用。本页要用当前登录者，所以自己读一次判定。
 *
 * 内容是**权限门禁本身**：M1 的后台只有一道门，没有任何管理功能，因此这一页的作用是让
 * 「谁能进来、进来之后看到的和用户控制台有什么不同」成为一个可以直接看的事实。
 * 真正的管理模块排在 M5。
 */
import type { Metadata } from 'next';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { AccessDenied } from '@/features/auth/access-denied';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readAdminAccess } from '@/features/auth/session';

export const metadata: Metadata = {
  title: '后台管理',
};

/** 排期中的后台模块，全部在 M5。 */
const PENDING_MODULES = [
  { name: '用户管理', scope: '账号、角色、封禁' },
  { name: '内容管理', scope: '帖子、评论、举报处理' },
  { name: '任务管理', scope: '生图任务与失败重试' },
  { name: '站点配置', scope: '配额、限流、开关' },
  { name: '审计日志', scope: '敏感操作留痕，只追加不更新' },
];

export default async function AdminHomePage() {
  const access = await readAdminAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">后台管理</h1>
        {/* 能渲染到这一行本身就说明角色判定放行了：本页只有 `admin` 角色可见。 */}
        <p className="text-sm text-muted-foreground">当前登录：{access.user.name}（管理员）</p>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>权限门禁</CardTitle>
          <CardDescription>M1 的后台只有这道门，还没有任何管理功能。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p>
            未登录或会话失效时访问后台会被重定向到登录页；已登录但不是管理员时得到同一张拒绝页
            （正文里印着 <span className="font-mono text-xs">403 FORBIDDEN</span>），不会时而 404
            时而 500。
          </p>
          <p>
            响应状态码是 200 而不是 403：Next 返回真 403 需要的实验特性本项目没有开启，理由写在
            <span className="font-mono text-xs"> features/auth/guard.ts </span>
            的文件头。判断「是否被拒」要看响应体，不能只看状态码。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>尚未开放的模块</CardTitle>
          <CardDescription>全部排在 M5。导航里不会出现它们的入口。</CardDescription>
        </CardHeader>
        <CardContent>
          {/* 移动端单列，宽屏两列（`docs/PRD.md` 4.1：360px 无横向滚动）。 */}
          <ul className="grid gap-3 sm:grid-cols-2">
            {PENDING_MODULES.map((module) => (
              <li key={module.name} className="rounded-md border border-border px-3 py-2">
                <p className="text-sm font-medium">{module.name}</p>
                <p className="text-xs text-muted-foreground">{module.scope}</p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
