/**
 * `core/admin` —— 后台管理领域层（M5）。
 *
 * 与 `community` 一样按职责拆文件：`users` 用户管理（角色/封禁）、`content` 内容处置与
 * 审计日志读取、`config` 站点配置、`tasks` 工具运行只读统计、`overview` 概览聚合；
 * 判定规则集中在 `rules`，端口与失败码在 `types`。所有写入口都要求管理员角色并写审计行。
 */
export * from './config';
export * from './content';
export * from './overview';
export * from './rules';
export * from './tasks';
export * from './types';
export * from './users';
