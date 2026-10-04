/**
 * 删除帖子的按钮。服务端组件——删除是「确认后一次提交」的写操作，没有任何需要 JavaScript
 * 的中间状态。
 *
 * ## 不做浏览器 confirm
 *
 * `confirm()` 只在客户端组件里可用，为它引入水合不值得：删除自己的帖子是软删除（M3 没有
 * 回收站，但数据还在库里），误删的代价远低于给每张卡片加一段客户端脚本的复杂度。真要二次
 * 确认，属于 M5 后台管理的交互课题，不在这里提前解决。
 *
 * action 由页面传入（理由见 `post-form.tsx` 的同款说明）；成功后 action 自己 redirect，
 * 本组件不关心去哪儿。
 */
import { Button } from '@/components/ui/button';

export function DeletePostButton({
  action,
  postId,
}: {
  action: (formData: FormData) => Promise<void>;
  postId: string;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="postId" value={postId} />
      <Button type="submit" variant="destructive" size="sm">
        删除
      </Button>
    </form>
  );
}
