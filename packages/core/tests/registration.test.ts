/**
 * 邀请码注册编排的测试。
 *
 * 用纯内存假端口跑，覆盖的重点是**顺序带来的性质**，而不是某个函数的分支：
 *
 * - 建号失败时不消费邀请码（用户换邮箱重试还能用同一个码）；
 * - 消费失败时必须回滚账号，且回滚失败要明说；
 * - 判定与消费用同一个时间点（过期边界不会两边打架）。
 */
import { describe, expect, it } from 'vitest';

import { INVITE_REJECTION, type InviteSnapshot } from '../src/invites';
import {
  registerWithInvite,
  REGISTRATION_FAILURE,
  type ConsumeInviteOutcome,
  type CreateUserOutcome,
  type RegistrationPorts,
} from '../src/registration';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const attempt = {
  name: '小苏',
  email: 'su@example.com',
  password: 'correct horse battery staple',
  inviteCode: 'INV-ABC-123',
};

/** 一个可用的邀请码快照：未使用、未过期。 */
function usableInvite(): InviteSnapshot {
  return { usedBy: null, usedAt: null, expiresAt: null };
}

type CallLog = {
  findInvite: string[];
  createUser: { name: string; email: string }[];
  consumeInvite: { code: string; userId: string; now: Date }[];
  deleteUser: string[];
};

/**
 * 假端口。每个步骤的行为都能被替换，用来构造真实端口才可能出现的失败。
 */
function makePorts(overrides: Partial<RegistrationPorts> = {}): {
  ports: RegistrationPorts;
  calls: CallLog;
} {
  const calls: CallLog = { findInvite: [], createUser: [], consumeInvite: [], deleteUser: [] };

  const base: RegistrationPorts = {
    now: () => NOW,
    findInvite: async (code) => {
      calls.findInvite.push(code);
      return usableInvite();
    },
    createUser: async (request) => {
      calls.createUser.push({ name: request.name, email: request.email });
      return { ok: true, userId: 'user-1' } satisfies CreateUserOutcome;
    },
    consumeInvite: async (params) => {
      calls.consumeInvite.push(params);
      return { consumed: true, inviteId: 'invite-1' } satisfies ConsumeInviteOutcome;
    },
    deleteUser: async (userId) => {
      calls.deleteUser.push(userId);
    },
  };

  return { ports: { ...base, ...overrides }, calls };
}

describe('registerWithInvite 正常路径', () => {
  it('建号并消费成功后，返回 userId 与 inviteId', async () => {
    const { ports, calls } = makePorts();

    const result = await registerWithInvite(ports, attempt);

    expect(result).toEqual({ ok: true, userId: 'user-1', inviteId: 'invite-1' });
    expect(calls.createUser).toEqual([{ name: '小苏', email: 'su@example.com' }]);
    expect(calls.deleteUser).toEqual([]);
  });

  it('判定与消费使用同一个时间点', async () => {
    const { ports, calls } = makePorts();

    await registerWithInvite(ports, attempt);

    expect(calls.consumeInvite).toHaveLength(1);
    expect(calls.consumeInvite[0]?.now).toBe(NOW);
  });

  it('邀请码首尾的空白会被裁掉（用户复制时常见的换行）', async () => {
    const { ports, calls } = makePorts();

    await registerWithInvite(ports, { ...attempt, inviteCode: '  INV-ABC-123\n' });

    expect(calls.findInvite).toEqual(['INV-ABC-123']);
    expect(calls.consumeInvite[0]?.code).toBe('INV-ABC-123');
  });
});

describe('registerWithInvite 建号之前的拒绝', () => {
  it('没填邀请码时直接拒绝，不查库也不建号', async () => {
    const { ports, calls } = makePorts();

    const result = await registerWithInvite(ports, { ...attempt, inviteCode: '   ' });

    expect(result).toEqual({ ok: false, failure: INVITE_REJECTION.required });
    expect(calls.findInvite).toEqual([]);
    expect(calls.createUser).toEqual([]);
  });

  it('码不存在时拒绝，不建号', async () => {
    const { ports, calls } = makePorts({ findInvite: async () => null });

    const result = await registerWithInvite(ports, attempt);

    expect(result).toEqual({ ok: false, failure: INVITE_REJECTION.notFound });
    expect(calls.createUser).toEqual([]);
    expect(calls.consumeInvite).toEqual([]);
  });

  it('码已使用时拒绝，不建号', async () => {
    const { ports, calls } = makePorts({
      findInvite: async () => ({ usedBy: 'user-x', usedAt: NOW, expiresAt: null }),
    });

    const result = await registerWithInvite(ports, attempt);

    expect(result).toEqual({ ok: false, failure: INVITE_REJECTION.used });
    expect(calls.createUser).toEqual([]);
  });

  it('码已过期时拒绝（到期时刻本身即不可用）', async () => {
    const { ports, calls } = makePorts({
      findInvite: async () => ({ usedBy: null, usedAt: null, expiresAt: NOW }),
    });

    const result = await registerWithInvite(ports, attempt);

    expect(result).toEqual({ ok: false, failure: INVITE_REJECTION.expired });
    expect(calls.createUser).toEqual([]);
  });

  it('码是脏数据（只写了使用者没写时间）时按不可用处理', async () => {
    const { ports } = makePorts({
      findInvite: async () => ({ usedBy: 'user-x', usedAt: null, expiresAt: null }),
    });

    const result = await registerWithInvite(ports, attempt);

    expect(result).toEqual({ ok: false, failure: INVITE_REJECTION.corrupted });
  });
});

describe('registerWithInvite 建号失败', () => {
  it('邮箱已注册时透传适配器的失败，且不消费邀请码', async () => {
    const failure = { code: 'AUTH_EMAIL_TAKEN', message: '该邮箱已注册。' };
    const { ports, calls } = makePorts({
      createUser: async () => ({ ok: false, emailTaken: true, failure }),
    });

    const result = await registerWithInvite(ports, attempt);

    expect(result).toEqual({ ok: false, failure });
    // 这是「建号成功才消费」的直接证据：换了邮箱重试，同一个码还能用。
    expect(calls.consumeInvite).toEqual([]);
    expect(calls.deleteUser).toEqual([]);
  });

  it('其它建号失败同样不消费邀请码', async () => {
    const failure = { code: 'AUTH_SIGN_UP_FAILED', message: '注册失败，请稍后重试。' };
    const { ports, calls } = makePorts({
      createUser: async () => ({ ok: false, emailTaken: false, failure }),
    });

    const result = await registerWithInvite(ports, attempt);

    expect(result).toEqual({ ok: false, failure });
    expect(calls.consumeInvite).toEqual([]);
  });
});

describe('registerWithInvite 消费失败后的回滚', () => {
  it('码被并发抢走时删掉刚建的账号，并提示已使用', async () => {
    const { ports, calls } = makePorts({
      consumeInvite: async () => ({
        consumed: false,
        snapshot: { usedBy: 'user-2', usedAt: NOW, expiresAt: null },
      }),
    });

    const result = await registerWithInvite(ports, attempt);

    expect(result).toEqual({ ok: false, failure: INVITE_REJECTION.used });
    expect(calls.deleteUser).toEqual(['user-1']);
  });

  it('码在两步之间被删掉时，提示不存在并回滚', async () => {
    const { ports, calls } = makePorts({
      consumeInvite: async () => ({ consumed: false, snapshot: null }),
    });

    const result = await registerWithInvite(ports, attempt);

    expect(result).toEqual({ ok: false, failure: INVITE_REJECTION.notFound });
    expect(calls.deleteUser).toEqual(['user-1']);
  });

  it('回滚失败时明确报出来，并把原错误挂在 cause 上', async () => {
    const cause = new Error('connection terminated');
    const { ports } = makePorts({
      consumeInvite: async () => ({ consumed: false, snapshot: null }),
      deleteUser: async () => {
        throw cause;
      },
    });

    const result = await registerWithInvite(ports, attempt);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe(REGISTRATION_FAILURE.rollbackFailed.code);
    expect(result.failure.message).toBe(REGISTRATION_FAILURE.rollbackFailed.message);
    expect(result.failure.cause).toBe(cause);
  });

  it('消费失败但重读显示码仍可用时，给「重试一次」而不是「码无效」', async () => {
    const { ports, calls } = makePorts({
      consumeInvite: async () => ({ consumed: false, snapshot: usableInvite() }),
    });

    const result = await registerWithInvite(ports, attempt);

    expect(result).toEqual({ ok: false, failure: REGISTRATION_FAILURE.inviteConflict });
    expect(calls.deleteUser).toEqual(['user-1']);
  });
});
