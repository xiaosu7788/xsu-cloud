/**
 * 数据层入口。
 *
 * schema 与迁移自 M1 起落地（鉴权四表 + 邀请码表，见 `docs/ROADMAP.md` M1）。
 * 表结构的事实来源是 `docs/DATA-MODEL.md`；本包不含业务规则。仓储见 `./repositories`。
 */
export * from './client';
export * from './schema';
export * from './repositories';
