/**
 * 审计动作与目标类型的中文展示名。
 *
 * 与 `app/(admin)/admin/reports/page.tsx` 的 `AUDIT_ACTION_LABEL` / `TARGET_TYPE_LABEL`
 * 同一份事实：M5 的审计页用到的动作更多，抽到这里让两页共用，动作名只写一处。
 * `action` 在数据库里是自由字符串（`audit_logs.action` 故意不加 CHECK），未知值原样显示。
 */
import { ADMIN_AUDIT_ACTION } from '@xsu/core';

/** `audit_logs.targetType` 的四类取值 → 中文。 */
export const AUDIT_TARGET_TYPE_LABEL: Record<string, string> = {
  post: '帖子',
  comment: '评论',
  user: '用户',
  site_config: '站点配置',
};

/** M5 已知的审计动作 → 中文。未知动作（未来的动作、M3 的两个动作在审计页见到的）原样显示。 */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  'report.takedown': '确认下架（举报成立）',
  'report.dismiss': '驳回举报',
  [ADMIN_AUDIT_ACTION.userRoleUpdate]: '角色变更',
  [ADMIN_AUDIT_ACTION.userBan]: '封禁用户',
  [ADMIN_AUDIT_ACTION.userUnban]: '解封用户',
  [ADMIN_AUDIT_ACTION.postTakedown]: '下架帖子',
  [ADMIN_AUDIT_ACTION.postRestore]: '恢复帖子',
  [ADMIN_AUDIT_ACTION.commentTakedown]: '下架评论',
  [ADMIN_AUDIT_ACTION.commentRestore]: '恢复评论',
  [ADMIN_AUDIT_ACTION.siteConfigUpdate]: '更新站点配置',
};
