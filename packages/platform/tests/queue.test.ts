import { describe, expect, it, vi } from 'vitest';

import { CLEANUP_CRON, CLEANUP_TIMEZONE, JOB_NAME, QUEUE_NAME, dispatchJob } from '../src/queue';

/**
 * 队列的分派逻辑。
 *
 * **这里刻意不连 Redis。** 提交级检查（`pnpm test`）不起 Redis 服务，而 `new Queue(...)` /
 * `new Worker(...)` 一构造就发起连接，所以本文件只覆盖 `dispatchJob` —— 队列里唯一有分支的地方。
 * 「任务确实被 worker 取走并处理了」这件事连着真实 Redis 才验得了，见 `docs/TESTING.md`
 * 里记录的那次实跑；把它写成「没有 Redis 就跳过」的用例等于把现场状态藏起来。
 */

/** 一封形状完整的邮件载荷。字段来自 `MailMessage`，不是随手编的。 */
const MAIL = {
  to: 'someone@example.com',
  subject: '验证你的邮箱',
  text: '点下面的链接完成验证。',
  link: 'https://cloud.example.com/verify?token=abc',
};

/** 两个处理函数的替身。日志单独收集，好断言「哪条日志在什么情况下该出现」。 */
function makeSpies() {
  const mailSend = vi.fn(async () => {});
  const maintenanceCleanup = vi.fn(async () => {});
  const lines: string[] = [];

  return {
    mailSend,
    maintenanceCleanup,
    handlers: {
      [JOB_NAME.mailSend]: mailSend,
      [JOB_NAME.maintenanceCleanup]: maintenanceCleanup,
    },
    log: (line: string) => lines.push(line),
    /** 全部日志拼起来，够用来断言「出现了 / 没出现某句」。 */
    logged: () => lines.join('\n'),
  };
}

describe('dispatchJob：按任务名分派', () => {
  it('mail.send 交给邮件处理函数，载荷原样传过去', async () => {
    const spies = makeSpies();

    await dispatchJob(spies.handlers, { name: JOB_NAME.mailSend, data: MAIL }, spies.log);

    expect(spies.mailSend).toHaveBeenCalledTimes(1);
    // 逐字段相等而不是「被调用过」：载荷被谁改写一个字都算缺陷。
    expect(spies.mailSend).toHaveBeenCalledWith(MAIL);
    expect(spies.maintenanceCleanup).not.toHaveBeenCalled();
    // 日志里带主题。排障时「哪封邮件成功了」比「有个任务成功了」有用得多。
    expect(spies.logged()).toContain(MAIL.subject);
  });

  it('maintenance.cleanup 交给清理函数，载荷是空对象', async () => {
    const spies = makeSpies();

    await dispatchJob(spies.handlers, { name: JOB_NAME.maintenanceCleanup, data: {} }, spies.log);

    expect(spies.maintenanceCleanup).toHaveBeenCalledTimes(1);
    // 刻意是空对象而不是 `undefined`：BullMQ 用 JSON 序列化，`undefined` 过一遍就没了。
    expect(spies.maintenanceCleanup).toHaveBeenCalledWith({});
    expect(spies.mailSend).not.toHaveBeenCalled();
  });

  it('处理函数抛错就原样往外抛：不吞异常、不返回伪成功', async () => {
    const spies = makeSpies();
    const failure = new Error('SMTP 拒绝连接');
    spies.mailSend.mockRejectedValue(failure);

    /*
     * 断言的是**同一个错误对象**，不是被包过一层的新错误：BullMQ 把抛出来的东西当作失败原因
     * 记进任务，包一层会让「重试三次都失败」的现场里全是包装器的堆栈。
     */
    await expect(
      dispatchJob(spies.handlers, { name: JOB_NAME.mailSend, data: MAIL }, spies.log),
    ).rejects.toBe(failure);

    // 没走到「完成」那一行，否则就是拿日志把失败说成了成功。
    expect(spies.logged()).not.toContain('完成');
  });
});

describe('队列契约常量', () => {
  it('队列名与任务名是稳定字符串：改动等于让线上排队的任务永远没人处理', () => {
    expect(QUEUE_NAME).toBe('xsu');
    expect(JOB_NAME).toEqual({
      mailSend: 'mail.send',
      maintenanceCleanup: 'maintenance.cleanup',
    });
  });

  it('清理任务显式跑在 UTC，不跟随机房本地时区漂移', () => {
    // `AGENTS.md` 第 8 节里机房位置是唯一未决项；换机房不该让清理时间跟着变。
    expect(CLEANUP_TIMEZONE).toBe('UTC');
    expect(CLEANUP_CRON).toBe('0 4 * * *');
  });
});
