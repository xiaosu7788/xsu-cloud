/**
 * `@xsu/integrations` —— 集成层入口。
 *
 * M0 只有骨架，一个适配器都还没有。目录约定是「一个外部系统一个目录」，
 * 例如 `src/s3/`、`src/mail/`，各自有自己的出口，本文件将来只做汇总转发。
 *
 * 适配器铁律（见 `docs/INTEGRATIONS.md`）：只做翻译、不 import `@xsu/core`、
 * 凭证只在服务端、必须显式失败、必须有超时。前两条由
 * `packages/config/eslint/layering.mjs` 强制。
 *
 * 首个适配器（S3 兼容对象存储）随 M4 落地。
 */
export {};
