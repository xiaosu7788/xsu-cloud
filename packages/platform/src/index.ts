/**
 * `@xsu/platform` —— 基础设施入口。
 *
 * 已落位：
 * - `./env`：全项目唯一读 `process.env` 的地方，解析并校验服务端配置
 * - `./mail`：邮件端口与 M1 的控制台实现
 * - `./auth`：Better Auth 实例（注册准入、账号绑定策略、会话）
 * - `./registration`：把 `@xsu/core` 的注册编排接到 Better Auth 与数据库上
 *
 * 尚未落位：cache / queue（M2，Redis 承载计数、BullMQ 首次落地）。
 *
 * 这里只放基础设施，不放业务规则；鉴权「谁能做什么」的判定属于领域层
 * （`packages/core/src/access.ts`）。
 */
export * from './auth';
export * from './env';
export * from './mail';
export * from './registration';
