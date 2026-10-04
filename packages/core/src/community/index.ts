/**
 * 社区模块的入口。`packages/core/src/index.ts` 只转发本文件，操作文件再多也不用改根入口。
 *
 * 依赖方向（不允许反向，也没有环）：
 *
 * ```text
 * types.ts          契约与失败码，只有声明
 *    ▲
 * rules.ts          纯规则：归一化、校验、游标、分页、归属与审核判定（无 I/O）
 *    ▲
 * posts.ts          帖子的读写；`loadVisiblePost` 是「这内容还活着吗」的唯一实现
 *    ▲            ↖
 * comments.ts       评论（用 posts 的可见性门）；reports.ts（用两者的可见性门）
 * reactions.ts      点赞（用 posts 的可见性门）
 * ```
 */
export * from './comments';
export * from './posts';
export * from './reactions';
export * from './reports';
export * from './rules';
export * from './types';
