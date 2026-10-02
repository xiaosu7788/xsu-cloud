import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_REJECTION,
  checkAccountLinkable,
  checkAccountUnlinkable,
  countRemainingUsableLoginMethods,
  CREDENTIAL_PROVIDER,
  isProviderLinked,
  toLoginMethods,
  type LoginMethod,
} from '../src/accounts';

/**
 * 账号绑定规则。
 *
 * 锁的是两条策略：`docs/INTEGRATIONS.md` 第 7 节「绑定必须有反向操作，且只在存在
 * 其他可用登录方式时才允许解除」，以及 `docs/PRD.md` 3.6「账号关联策略落地且有测试覆盖」。
 */

/** 造一条登录方式，默认可用。 */
function method(providerId: string, usable = true): LoginMethod {
  return { providerId, usable };
}

/** 断言拿到某个具体拒绝原因。 */
function expectRejection(result: ReturnType<typeof checkAccountUnlinkable>) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('预期被拒绝，实际放行');
  }
  return result.rejection;
}

describe('登录方式映射', () => {
  it('邮箱密码不受外部提供方开关影响，在册即可用', () => {
    const methods = toLoginMethods([{ providerId: CREDENTIAL_PROVIDER }], []);
    expect(methods).toEqual([{ providerId: CREDENTIAL_PROVIDER, usable: true }]);
  });

  it('已注册的外部提供方标记为可用', () => {
    const methods = toLoginMethods([{ providerId: 'github' }], ['github', 'linuxdo']);
    expect(methods).toEqual([{ providerId: 'github', usable: true }]);
  });

  it('绑定还在但提供方已被摘掉时标记为不可用', () => {
    const methods = toLoginMethods([{ providerId: 'linuxdo' }], ['github']);
    expect(methods).toEqual([{ providerId: 'linuxdo', usable: false }]);
  });
});

describe('绑定', () => {
  it('没绑过可以绑', () => {
    expect(checkAccountLinkable([method(CREDENTIAL_PROVIDER)], 'github').ok).toBe(true);
  });

  it('重复绑定被拒，且给的是「已绑定」而不是别的理由', () => {
    const rejection = checkAccountLinkable([method('github')], 'github');
    expect(rejection.ok).toBe(false);
    if (rejection.ok) {
      throw new Error('预期被拒绝，实际放行');
    }
    expect(rejection.rejection).toBe(ACCOUNT_REJECTION.alreadyLinked);
  });

  it('提供方已被摘掉时，绑定关系仍然算「已绑定」——不能靠下线来绕过重复绑定检查', () => {
    expect(isProviderLinked([method('linuxdo', false)], 'linuxdo')).toBe(true);
  });
});

describe('解除绑定', () => {
  it('没绑过的不能解', () => {
    const rejection = expectRejection(checkAccountUnlinkable([method('github')], 'credential'));
    expect(rejection).toBe(ACCOUNT_REJECTION.notLinked);
  });

  it('只有一个可用登录方式时拒绝解除', () => {
    const rejection = expectRejection(
      checkAccountUnlinkable([method(CREDENTIAL_PROVIDER)], CREDENTIAL_PROVIDER),
    );
    expect(rejection).toBe(ACCOUNT_REJECTION.lastLoginMethod);
    expect(rejection.message).toContain('无法登录');
  });

  it('有两个可用登录方式时可以解除其中一个', () => {
    const methods = [method(CREDENTIAL_PROVIDER), method('github')];
    expect(checkAccountUnlinkable(methods, 'github').ok).toBe(true);
    expect(checkAccountUnlinkable(methods, CREDENTIAL_PROVIDER).ok).toBe(true);
  });

  it('绑了两个但另一个的提供方已下线时，仍然拒绝解除——否则会把人锁在门外', () => {
    const methods = [method(CREDENTIAL_PROVIDER), method('linuxdo', false)];
    const rejection = expectRejection(checkAccountUnlinkable(methods, CREDENTIAL_PROVIDER));
    expect(rejection).toBe(ACCOUNT_REJECTION.lastLoginMethod);
  });

  it('解除已下线的那个提供方是允许的：剩下的邮箱密码仍然能登', () => {
    const methods = [method(CREDENTIAL_PROVIDER), method('linuxdo', false)];
    expect(checkAccountUnlinkable(methods, 'linuxdo').ok).toBe(true);
  });

  it('全部提供方都下线且只剩外部绑定时，一个都不许解', () => {
    const methods = [method('github', false), method('linuxdo', false)];
    expect(countRemainingUsableLoginMethods(methods, 'github')).toBe(0);
    const rejection = expectRejection(checkAccountUnlinkable(methods, 'github'));
    expect(rejection).toBe(ACCOUNT_REJECTION.lastLoginMethod);
  });
});

describe('拒绝原因', () => {
  it('三种原因的 code 互不相同，且都有能直接给用户看的文案', () => {
    const all = Object.values(ACCOUNT_REJECTION);
    expect(new Set(all.map((item) => item.code)).size).toBe(all.length);
    for (const item of all) {
      expect(item.message.length).toBeGreaterThan(8);
      // 文案要能指导下一步，不能只是一句「操作失败」。
      expect(item.message).not.toMatch(/失败|错误|异常/);
    }
  });
});
