import { describe, expect, it } from 'vitest';

import {
  ACCESS_DENIED,
  ADMIN_ROLE,
  decideAdminAccess,
  decideConsoleAccess,
  isAdmin,
  isRole,
  readRole,
} from '../src/access';

/**
 * 区域访问判定。
 *
 * 这里锁的是 `docs/ROADMAP.md` M1 的两条退出标准：
 * - 非管理员访问 `(admin)` 得到**统一**拒绝响应（所以断言的是 `ACCESS_DENIED` 里的那个对象本身，
 *   不是自己另写一份 status/message）；
 * - 角色值不认识时不得放行（fail closed）。
 */
describe('readRole / isRole', () => {
  it('认识两个合法角色', () => {
    expect(readRole('user')).toBe('user');
    expect(readRole('admin')).toBe('admin');
    expect(isRole('admin')).toBe(true);
  });

  it('不认识的取值一律当未登录处理', () => {
    for (const value of [null, undefined, '', 'root', 'ADMIN', 0, {}, ['admin']]) {
      expect(readRole(value)).toBeNull();
      expect(isRole(value)).toBe(false);
    }
  });
});

describe('isAdmin', () => {
  it('只有 admin 才算管理员', () => {
    expect(isAdmin(ADMIN_ROLE)).toBe(true);
    expect(isAdmin('user')).toBe(false);
    expect(isAdmin('Admin')).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });
});

describe('(console) 分区', () => {
  it('已登录用户放行，并回带角色', () => {
    expect(decideConsoleAccess('user')).toEqual({ allowed: true, role: 'user' });
    expect(decideConsoleAccess('admin')).toEqual({ allowed: true, role: 'admin' });
  });

  it('未登录与脏角色都拿 401', () => {
    for (const value of [null, undefined, 'root']) {
      expect(decideConsoleAccess(value)).toEqual({
        allowed: false,
        denial: ACCESS_DENIED.unauthenticated,
      });
    }
  });
});

describe('(admin) 分区', () => {
  it('管理员放行', () => {
    expect(decideAdminAccess('admin')).toEqual({ allowed: true, role: 'admin' });
  });

  it('已登录但不是管理员 → 403，且用的是统一拒绝对象', () => {
    const decision = decideAdminAccess('user');
    expect(decision.allowed).toBe(false);
    expect(decision).toEqual({ allowed: false, denial: ACCESS_DENIED.forbidden });
    expect(ACCESS_DENIED.forbidden.status).toBe(403);
    expect(ACCESS_DENIED.forbidden.message.length).toBeGreaterThan(0);
  });

  it('未登录 → 401，不会误报成 403', () => {
    expect(decideAdminAccess(null)).toEqual({
      allowed: false,
      denial: ACCESS_DENIED.unauthenticated,
    });
    expect(decideAdminAccess(undefined)).toEqual({
      allowed: false,
      denial: ACCESS_DENIED.unauthenticated,
    });
  });

  it('脏角色不会被当成管理员', () => {
    expect(decideAdminAccess('superadmin')).toEqual({
      allowed: false,
      denial: ACCESS_DENIED.unauthenticated,
    });
  });
});
