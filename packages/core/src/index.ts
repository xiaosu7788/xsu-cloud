/**
 * `@xsu/core` —— 领域层入口。
 *
 * 本包不得依赖任何框架，也不得依赖集成层与表现层；依赖数据层是允许的（见
 * `docs/ARCHITECTURE.md` 2.2）。这条规则由 `packages/config/eslint/layering.mjs` 强制。
 *
 * M1 落地四件横切规则：区域访问判定、邀请码准入、注册编排、账号绑定。业务模块（工具箱、
 * 社区、生图）从 M2 起在这里加各自的目录，不要把文件夹里的东西堆进根目录。
 */
export * from './access';
export * from './accounts';
export * from './invites';
export * from './registration';
export * from './tools';
export * from './community';
export * from './admin';
export * from './social';
