/**
 * 登录页。
 *
 * ## 这个页面是有意为之的动态渲染
 *
 * `docs/ARCHITECTURE.md` 7.1 红线 1 禁的是「公开**内容**页默认为动态」，本页不在这条之内，
 * 两处原因都指向必须按请求渲染：
 *
 * 1. **第三方登录入口由环境变量决定。** 提供方清单来自服务端配置（`enabledOAuthProviders`），
 *    如果在构建期读它，构建产物就把当时的配置固化了——运营方补一个 OAuth 应用之后不重新
 *    构建就永远看不到按钮；更糟的是构建过程会因此依赖部署密钥（`getServerEnv` 缺必填项
 *    直接抛错），把「构建一个镜像」变成一次必须持有生产密钥的操作。运行时读没有这些问题。
 * 2. **OAuth 失败必须出现在首屏 HTML 里。** Better Auth 的第三方登录失败不走 JSON 返回，
 *    而是把 `?error=<code>` 附在错误回调地址上重定向回来（见 `features/auth/oauth.ts`）。
 *    服务端读这个参数，用户点完授权失败回到本页时**立刻**能看到原因；
 *    交给客户端读则要先水合再补渲染，失败的那一瞬间页面看起来像是「什么都没发生」。
 *
 * 首页（`app/(site)/page.tsx`）仍按红线 1 保持静态预渲染。公开分区里按请求渲染的只有本页与
 * 注册页（`app/(site)/sign-up/page.tsx`，理由写在那边：已登录的人不该看到注册表单）。
 *
 * ## 已登录用户直接送进控制台
 *
 * 本页已经要读请求期数据，顺手读一次会话不增加成本。不这么做就会出现「已经登录、却还能
 * 看到登录表单并可再提交一次」的自相矛盾界面——登录成功后 `SignInForm` 用的是
 * `router.replace`，登录页不会留在历史里，所以这个状态只能由「手动敲地址」或「旧标签页」
 * 产生，一旦产生就非常像鉴权坏了。
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { SignInForm } from '@/features/auth/sign-in-form';
import {
  OAUTH_PROVIDER_LABEL,
  readOAuthCallbackError,
  type SignInProvider,
} from '@/features/auth/oauth';
import { CONSOLE_HOME, SIGN_UP_PATH } from '@/features/auth/routes';
import { readSessionUser } from '@/features/auth/session';
import { enabledOAuthProviders, getServerEnv } from '@xsu/platform';

export const metadata: Metadata = {
  title: '登录',
};

/** Next 16 把 `searchParams` 交成 Promise，参数可能重复出现因此值可能是数组。 */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  if (await readSessionUser()) {
    redirect(CONSOLE_HOME);
  }

  const params = await searchParams;

  /*
   * 只渲染**真的配好了**的提供方。不这么做的话，一个还没申请 OAuth 应用的部署会显示
   * 两个点了必然报错的按钮，而用户会以为是本站坏了。
   * 文案取自 `OAUTH_PROVIDER_LABEL`（`satisfies Record<OAuthProviderId, string>` 保证
   * 新增提供方时这里不会漏）。
   */
  const providers: SignInProvider[] = enabledOAuthProviders(getServerEnv()).map((id) => ({
    id,
    label: OAUTH_PROVIDER_LABEL[id],
  }));

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 py-4">
      <SignInForm providers={providers} callbackError={readOAuthCallbackError(params.error)} />

      <Card>
        <CardHeader>
          <CardTitle>还没有账号？</CardTitle>
          <CardDescription>本站不开放自由注册，注册需要邀请码。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            邀请码由管理员发放。拿到邀请码后即可注册，注册后需要先完成邮箱验证，通过验证才能登录。
          </p>
          <Button asChild variant="outline">
            <Link href={SIGN_UP_PATH}>去注册</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
