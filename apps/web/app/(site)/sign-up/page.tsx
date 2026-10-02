/**
 * 注册页。
 *
 * ## 这是注册的唯一入口
 *
 * Better Auth 自己的 `/sign-up/email` 已被 `packages/platform/src/auth.ts` 用 `disabledPaths`
 * 关掉（那里写了为什么），注册只能走 `./actions.ts` 的 Server Action，因此本页不是「一个可选的
 * 表单」，而是 `docs/ROADMAP.md` M1 交付物①「邀请码注册准入」在界面上的落点：没有它，
 * 注册编排（`packages/core/src/registration.ts`）在运行时不可达。
 *
 * ## 本页也是动态渲染，理由与登录页不同
 *
 * `docs/ARCHITECTURE.md` 7.1 红线 1 禁的是「公开**内容**页默认为动态」，本页不在这条之内。
 * 它按请求渲染只有一个原因：**已登录的人不该看到注册表单**。与登录页一样，
 * 遇到这个状态直接送进控制台——否则页面会显示一个「已经登录、却还能再注册一个账号」的
 * 自相矛盾界面，而这种状态只能由手动敲地址或旧标签页产生，一旦产生就非常像鉴权坏了。
 *
 * 登录页的另一个动态理由（第三方提供方清单来自环境变量）在本页不成立：注册只有邮箱密码
 * 一条路径，没有 OAuth 按钮。所以本页不读 `getServerEnv()`，构建期也不依赖任何服务端密钥。
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { CONSOLE_HOME, SIGN_IN_PATH } from '@/features/auth/routes';
import { readSessionUser } from '@/features/auth/session';
import { SignUpForm } from '@/features/auth/sign-up-form';

export const metadata: Metadata = {
  title: '注册',
};

export default async function SignUpPage() {
  if (await readSessionUser()) {
    redirect(CONSOLE_HOME);
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 py-4">
      <SignUpForm />

      {/*
        内联链接同样要满足 `docs/PRD.md` 4.1 的「触控目标 ≥44px」：文字本身只有 18px 高，
        靠 `inline-flex h-11 items-center` 撑起命中区，与 `components/site-nav.tsx` 的做法一致。
        外层改用 `flex` 是配套的：默认流式排版下 `h-11` 会把这一行的行高一起顶开，
        文字相对卡片出现一段无意义的垂直偏移。
      */}
      <p className="flex flex-wrap items-center gap-x-1 text-sm text-muted-foreground">
        已经有账号？
        <Link
          href={SIGN_IN_PATH}
          className="inline-flex h-11 min-w-11 items-center font-medium text-foreground underline underline-offset-4"
        >
          去登录
        </Link>
      </p>
    </div>
  );
}
