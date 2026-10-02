import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConsoleMailTransport } from '../src/mail';

const MESSAGE = {
  to: 'someone@example.com',
  subject: '验证你的邮箱 —— xsu-cloud',
  text: '完成邮箱验证后即可登录。',
  link: 'http://localhost:3000/api/auth/verify-email?token=abc',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('控制台邮件传输', () => {
  it('开发环境打印收件人、主题与链接', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    await createConsoleMailTransport({ isProduction: false }).send(MESSAGE);

    const output = written.join('');
    expect(output).toContain(MESSAGE.to);
    expect(output).toContain(MESSAGE.subject);
    expect(output).toContain(MESSAGE.link);
  });

  it('生产环境抛错，不把带令牌的链接写进生产日志', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const transport = createConsoleMailTransport({ isProduction: true });

    await expect(transport.send(MESSAGE)).rejects.toThrow(/生产环境尚未接入真实 SMTP/);
    expect(write).not.toHaveBeenCalled();
  });

  it('正文内容不进输出：只打印字段，不猜排版', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    await createConsoleMailTransport({ isProduction: false }).send({
      ...MESSAGE,
      text: '只该出现在邮件正文里的句子',
    });

    expect(written.join('')).not.toContain('只该出现在邮件正文里的句子');
  });
});
