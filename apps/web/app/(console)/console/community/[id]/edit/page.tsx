/**
 * 编辑自己的帖子（控制台）。
 *
 * ## 判定顺序
 *
 * 先分区门（`readConsoleAccess`），再内容门：`readPost` 不过滤 `deletedAt`——
 * 「id 不存在」→ `notFound()`；「存在但已删除 / 已下架」或「不是你的帖子」→ 统一拒绝视图。
 * 这与详情页的 404 / 拒绝视图二分一致，编辑页多一层「作者就是你自己」的判定。
 *
 * ## `postId` 用 `bind` 绑定
 *
 * 编辑表单的 `updatePostAction.bind(null, post.id)` 把帖子 id 作为第一个参数绑定进 action，
 * 不走表单 hidden 字段——hidden 字段可被客户端篡改成任意 id，绑定值来自服务端渲染时的
 * 数据库事实，没有篡改面。
 */
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';

import { readPost } from '@xsu/core';
import { createCommunityPorts } from '@xsu/platform';

import { updatePostAction } from '../../actions';
import { communityPostPath, COMMUNITY_HOME, CONSOLE_COMMUNITY } from '@/features/community/routes';
import { AccessDenied } from '@/features/auth/access-denied';
import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readConsoleAccess } from '@/features/auth/session';
import { PostForm } from '@/features/community/post-form';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';

type EditPageProps = { params: Promise<{ id: string }> };

export function generateMetadata(): Metadata {
  return { title: '编辑帖子' };
}

export default async function ConsoleCommunityEditPage({ params }: EditPageProps) {
  const { id } = await params;
  const access = await readConsoleAccess();

  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return <AccessDenied denial={access.denial} />;
  }

  const ports = await createCommunityPorts({ userId: access.user.id });
  const outcome = await readPost(ports, { postId: id });
  if (!outcome.ok) {
    notFound();
  }
  const post = outcome.post;

  if (post.deletedAt !== null || post.authorId !== access.user.id) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="无法编辑"
          description="这篇帖子已被删除、已下架，或不是你发的帖子。"
          actions={
            <>
              <Button asChild variant="outline">
                <Link href={CONSOLE_COMMUNITY}>返回我的帖子</Link>
              </Button>
              <Link
                href={communityPostPath(post.id)}
                className="text-sm underline underline-offset-4"
              >
                查看帖子
                <span aria-hidden>→</span>
              </Link>
            </>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="编辑帖子"
        description={
          <>
            保存后会同步刷新公开页；公开时间线在{' '}
            <Link href={COMMUNITY_HOME} className="underline underline-offset-4">
              社区首页
            </Link>
            。
          </>
        }
      />

      <PostForm
        action={updatePostAction.bind(null, post.id)}
        mode="edit"
        initial={{
          title: post.title,
          body: post.body,
          tags: post.tags.join(', '),
          /* 标签串按保存时的排序回填；编辑页不提供标签排序编辑。 */
        }}
      />
      <p className="text-xs text-muted-foreground">
        保存后跳转到帖子详情页；删除入口在{' '}
        <Link href={CONSOLE_COMMUNITY} className="underline underline-offset-4">
          我的帖子
        </Link>
        。
      </p>
    </div>
  );
}
