import { describe, expect, it } from 'vitest';

import {
  checkInviteUsable,
  INVITE_REJECTION,
  isInviteCorrupted,
  isInviteUsed,
  normalizeInviteCode,
  type InviteSnapshot,
} from '../src/invites';

/**
 * 邀请码准入规则。
 *
 * 锁的是 `docs/PRD.md` 3.6 验收 2：「邀请码为一次性，重复使用被拒并有明确提示」。
 * 三种拒绝（不存在 / 已使用 / 已过期）必须各自可区分——只回一句「操作失败」不算「明确提示」。
 */

const NOW = new Date('2026-03-01T00:00:00.000Z');

function invite(partial: Partial<InviteSnapshot> = {}): InviteSnapshot {
  return { usedBy: null, usedAt: null, expiresAt: null, ...partial };
}

/** 断言拿到某个具体拒绝原因，返回它以便继续查文案。 */
function expectRejection(result: ReturnType<typeof checkInviteUsable>) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('预期被拒绝，实际放行');
  }
  return result.rejection;
}

describe('normalizeInviteCode', () => {
  it('裁掉首尾空白与换行（从聊天窗口复制常带这些）', () => {
    expect(normalizeInviteCode('  abcd-1234\n')).toBe('abcd-1234');
    expect(normalizeInviteCode('\t abcd \t')).toBe('abcd');
  });

  it('保持大小写不变（码是大小写敏感的）', () => {
    expect(normalizeInviteCode(' AbCd ')).toBe('AbCd');
  });

  it('null / undefined / 非字符串不炸，统一成空串', () => {
    expect(normalizeInviteCode(null)).toBe('');
    expect(normalizeInviteCode(undefined)).toBe('');
    expect(normalizeInviteCode(42 as unknown as string)).toBe('');
  });
});

describe('isInviteUsed / isInviteCorrupted', () => {
  it('未使用：两个字段都为空', () => {
    const fresh = invite();
    expect(isInviteUsed(fresh)).toBe(false);
    expect(isInviteCorrupted(fresh)).toBe(false);
  });

  it('已使用：两个字段都有值', () => {
    const used = invite({ usedBy: 'u1', usedAt: NOW });
    expect(isInviteUsed(used)).toBe(true);
    expect(isInviteCorrupted(used)).toBe(false);
  });

  it('只给一个字段算脏数据，两个方向都要抓', () => {
    expect(isInviteCorrupted(invite({ usedBy: 'u1' }))).toBe(true);
    expect(isInviteCorrupted(invite({ usedAt: NOW }))).toBe(true);
  });
});

describe('checkInviteUsable', () => {
  it('查不到的码 → notFound', () => {
    expect(expectRejection(checkInviteUsable(null, NOW))).toBe(INVITE_REJECTION.notFound);
    expect(expectRejection(checkInviteUsable(undefined, NOW))).toBe(INVITE_REJECTION.notFound);
  });

  it('未使用且未过期 → 放行', () => {
    expect(checkInviteUsable(invite(), NOW)).toEqual({ ok: true });
  });

  it('没有过期时间的码永远不过期', () => {
    const farFuture = new Date('2099-01-01T00:00:00.000Z');
    expect(checkInviteUsable(invite({ expiresAt: null }), farFuture)).toEqual({ ok: true });
  });

  it('已使用 → used（重复使用必须被拒）', () => {
    const used = invite({ usedBy: 'u1', usedAt: NOW });
    const rejection = expectRejection(checkInviteUsable(used, NOW));
    expect(rejection).toBe(INVITE_REJECTION.used);
    expect(rejection.message).toContain('一次性');
  });

  it('过期 → expired，且到期时刻本身已不可用（边界含等号）', () => {
    const expiresAt = new Date('2026-03-01T00:00:00.000Z');
    expect(expectRejection(checkInviteUsable(invite({ expiresAt }), expiresAt))).toBe(
      INVITE_REJECTION.expired,
    );
    expect(
      expectRejection(
        checkInviteUsable(invite({ expiresAt }), new Date('2026-03-01T00:00:00.001Z')),
      ),
    ).toBe(INVITE_REJECTION.expired);
    // 到期前一毫秒仍然可用。
    expect(checkInviteUsable(invite({ expiresAt }), new Date('2026-02-28T23:59:59.999Z'))).toEqual({
      ok: true,
    });
  });

  it('脏数据 → corrupted，且不会被当成「还没用」放出去', () => {
    expect(expectRejection(checkInviteUsable(invite({ usedBy: 'u1' }), NOW))).toBe(
      INVITE_REJECTION.corrupted,
    );
    expect(expectRejection(checkInviteUsable(invite({ usedAt: NOW }), NOW))).toBe(
      INVITE_REJECTION.corrupted,
    );
  });

  it('脏数据 + 已过期时优先报脏数据：数据本身坏了，先让人去查', () => {
    const broken = invite({ usedBy: 'u1', expiresAt: new Date('2020-01-01T00:00:00.000Z') });
    expect(expectRejection(checkInviteUsable(broken, NOW))).toBe(INVITE_REJECTION.corrupted);
  });

  it('每条拒绝原因都有可读文案与稳定 code', () => {
    for (const rejection of Object.values(INVITE_REJECTION)) {
      expect(rejection.message.length).toBeGreaterThan(4);
      expect(rejection.code).toMatch(/^INVITE_[A-Z_]+$/);
    }
  });
});
