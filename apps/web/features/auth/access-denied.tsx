/**
 * 统一拒绝视图。
 *
 * 只接收 `@xsu/core` 的 `AccessDenial`，自己不判断任何条件——文案、状态码、错误码全部来自
 * 领域层的 `ACCESS_DENIED` 表，表现层只负责排版。这样「拒绝响应一致」不是靠自觉，而是因为
 * 这里根本没有第二个可以编造文案的地方。
 *
 * 实际只会渲染 `FORBIDDEN` 那一条：`UNAUTHENTICATED` 在分区布局里已经被
 * `redirectToSignInIfUnauthenticated` 弹到登录页了（见 `./guard`）。组件仍然按联合类型写，
 * 是因为它不该知道守卫的选择——哪天策略改成「未登录也渲染拒绝页」，这里不需要改。
 *
 * 页面上明写状态码与错误码，是为了让「被拒」在截图和用户反馈里都是可核对的事实，
 * 而不是一句无法复现的「打不开」。
 */
import Link from 'next/link';
import type { AccessDenial } from '@xsu/core';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { CONSOLE_HOME, SITE_HOME } from './routes';

export function AccessDenied({ denial }: { denial: AccessDenial }) {
  return (
    <main className="mx-auto w-full max-w-md px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>无法访问</CardTitle>
          <CardDescription>{denial.message}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* 给用户看的是上面那句中文，这两项是给排查用的对账信息。 */}
          <p className="font-mono text-xs text-muted-foreground">
            {denial.status} {denial.code}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href={SITE_HOME}>返回首页</Link>
            </Button>
            {/*
             * 「我的控制台」只在已登录时才可能出现（未登录走重定向），而控制台对任何
             * 合法角色都开放，因此这条链接不会把用户送进另一个拒绝页。
             */}
            <Button asChild variant="outline">
              <Link href={CONSOLE_HOME}>我的控制台</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
