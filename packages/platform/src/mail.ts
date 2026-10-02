/**
 * 邮件发送。
 *
 * M1 只落地「控制台传输」：验证邮件与找回密码的链接打印在服务端终端里，供本地开发点开。
 * 真实 SMTP 传输尚未接入，这是 `docs/ROADMAP.md` 的 M1 已知债务，不是遗漏——
 * `docs/INTEGRATIONS.md` 第 4 节（I2）要求开发环境固定用 Mailpit 且不得误发真实邮件，
 * 而 M1 明确不引入 Mailpit 容器，所以只剩「什么都不发、只在控制台看」这一种诚实做法。
 *
 * 三条约束，改这个文件前先读：
 *
 * 1. **端口在这里，实现可以不在。** `MailTransport` 只描述「能发一封邮件」，控制台传输是
 *    它的一个实现。真实 SMTP 适配器按分层铁律属于集成层（`packages/integrations/*`），
 *    落地时实现同一个类型即可，调用方（`./auth`）一行不改。
 * 2. **生产环境必须炸。** 控制台传输在 `isProduction` 下直接抛错，而不是把链接打进生产日志。
 *    把带令牌的链接写进生产日志等于把账号交出去；而「静默什么都不发」会让用户以为
 *    邮件在路上。抛错是唯一能让这个缺口被看见的行为。
 * 3. **只打印收件人、主题与链接。** 口令、令牌原文、完整请求都不进日志。
 */
import type { ServerEnv } from './env';

/** 一封待发的邮件。`link` 单独给出：渠道不同，排版方式不同，正文不必自己再切一次。 */
export type MailMessage = {
  to: string;
  subject: string;
  /** 纯文本正文。 */
  text: string;
  /** 邮件里那个可点的动作链接。 */
  link: string;
};

export type MailTransport = {
  send(message: MailMessage): Promise<void>;
};

/**
 * 控制台传输。
 *
 * 打印格式刻意显眼：本地开发时这一行会混在 Next.js 的编译日志里，不显眼就等于没发。
 */
export function createConsoleMailTransport(env: Pick<ServerEnv, 'isProduction'>): MailTransport {
  return {
    async send(message) {
      if (env.isProduction) {
        throw new Error(
          '邮件未发送：生产环境尚未接入真实 SMTP 传输（控制台传输禁止在生产使用）。' +
            '见 docs/INTEGRATIONS.md 第 4 节与 docs/ROADMAP.md 的已知债务。',
        );
      }

      const lines = [
        '',
        '──────── 邮件（控制台传输，未接入真实 SMTP）────────',
        `收件人：${message.to}`,
        `主题：${message.subject}`,
        `链接：${message.link}`,
        '───────────────────────────────────────────────',
        '',
      ];
      // 用 stdout 而不是 stderr：这一行是给开发者看的正常输出，不是错误。
      process.stdout.write(`${lines.join('\n')}\n`);
    },
  };
}
