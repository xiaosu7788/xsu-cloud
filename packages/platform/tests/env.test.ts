import { describe, expect, it } from 'vitest';

import { TOOL_QUOTA_PER_HOUR_DEFAULT, TOOL_RUN_RETENTION_DAYS_DEFAULT } from '@xsu/core';

import { enabledOAuthProviders, parseServerEnv } from '../src/env';

/**
 * 合法的密钥：长度超过 32。测试里用常量而不是每个用例各写一份，
 * 这样「报错不回显值」的断言有唯一的目标字符串可比。
 */
const SECRET = 'test-secret-0123456789-0123456789-abcd';

/** 最小可用配置：鉴权三项 + 队列的 Redis 地址。OAuth 全部留空意味着两个提供方都不启用。 */
function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'development',
    BETTER_AUTH_URL: 'http://localhost:3000',
    BETTER_AUTH_SECRET: SECRET,
    REDIS_URL: 'redis://localhost:6379',
    ...overrides,
  } satisfies Record<string, string | undefined>;
}

describe('parseServerEnv：最小可用配置', () => {
  it('解析出鉴权与队列配置，且两个 OAuth 提供方都不存在', () => {
    const env = parseServerEnv(baseEnv());

    expect(env.nodeEnv).toBe('development');
    expect(env.isProduction).toBe(false);
    expect(env.auth).toEqual({ baseUrl: 'http://localhost:3000', secret: SECRET });
    expect(env.redis).toEqual({ url: 'redis://localhost:6379' });
    // 没有提供方时是「键不存在」，不是「键为 undefined」——调用方按 `'github' in oauth` 判断。
    expect('github' in env.oauth).toBe(false);
    expect('linuxdo' in env.oauth).toBe(false);
    expect(enabledOAuthProviders(env)).toEqual([]);
  });

  it('NODE_ENV 决定 isProduction，而不是靠字符串比较散落各处', () => {
    expect(parseServerEnv(baseEnv({ NODE_ENV: 'production' })).isProduction).toBe(true);
    expect(parseServerEnv(baseEnv({ NODE_ENV: 'test' })).isProduction).toBe(false);
  });

  it('NODE_ENV 缺省时为 development', () => {
    const env = parseServerEnv({
      BETTER_AUTH_URL: 'http://localhost:3000',
      BETTER_AUTH_SECRET: SECRET,
      REDIS_URL: 'redis://localhost:6379',
    });

    expect(env.nodeEnv).toBe('development');
  });
});

describe('parseServerEnv：必填项', () => {
  it('缺 BETTER_AUTH_SECRET 就抛错，不给默认值兜底', () => {
    expect(() => parseServerEnv({ BETTER_AUTH_URL: 'http://localhost:3000' })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it('密钥短于 32 位视为没配', () => {
    expect(() => parseServerEnv(baseEnv({ BETTER_AUTH_SECRET: 'too-short' }))).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it('BETTER_AUTH_URL 必须带 http/https 协议', () => {
    // `localhost:3000` 能被 `new URL()` 解析（`localhost:` 当作协议名），所以必须显式拒掉，
    // 否则少写 `http://` 的配置能通过校验，直到 OAuth 回调地址拼错才暴露。
    expect(() => parseServerEnv(baseEnv({ BETTER_AUTH_URL: 'localhost:3000' }))).toThrow(
      /BETTER_AUTH_URL/,
    );
    expect(() => parseServerEnv(baseEnv({ BETTER_AUTH_URL: 'ftp://example.com' }))).toThrow(
      /BETTER_AUTH_URL/,
    );
  });

  it('本地开发的 http://localhost:3000 与生产的 https 地址都算合法', () => {
    expect(parseServerEnv(baseEnv()).auth.baseUrl).toBe('http://localhost:3000');
    expect(
      parseServerEnv(baseEnv({ BETTER_AUTH_URL: 'https://cloud.example.com' })).auth.baseUrl,
    ).toBe('https://cloud.example.com');
  });

  it('报错只给键名与原因，不回显任何配置值', () => {
    let message = '';
    try {
      parseServerEnv(baseEnv({ BETTER_AUTH_SECRET: 'too-short' }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('BETTER_AUTH_SECRET');
    expect(message).not.toContain('too-short');
    expect(message).not.toContain(SECRET);
  });

  it('报错里带上 .env.example 这条线索，并逐条列出问题', () => {
    expect(() => parseServerEnv({})).toThrow(/\.env\.example/);
  });

  it('缺 REDIS_URL 就抛错：队列是 M2 起的硬依赖，不给 localhost 兜底', () => {
    expect(() => parseServerEnv(baseEnv({ REDIS_URL: undefined }))).toThrow(/REDIS_URL/);
  });

  it('REDIS_URL 必须带 redis / rediss 协议', () => {
    // 与 BETTER_AUTH_URL 同一理由：`new URL('localhost:6379')` 合法（`localhost:` 当协议名），
    // 少写协议头的配置能通过校验，直到 worker 启动才连不上。
    expect(() => parseServerEnv(baseEnv({ REDIS_URL: 'localhost:6379' }))).toThrow(/REDIS_URL/);
    expect(() => parseServerEnv(baseEnv({ REDIS_URL: 'https://redis.example.com' }))).toThrow(
      /REDIS_URL/,
    );
    expect(
      parseServerEnv(baseEnv({ REDIS_URL: 'rediss://user:pass@redis.example.com:6380' })).redis,
    ).toEqual({ url: 'rediss://user:pass@redis.example.com:6380' });
  });
});

describe('parseServerEnv：工具执行配置', () => {
  it('留空时用领域层的默认值，不在配置层写第二份说法', () => {
    const env = parseServerEnv(
      baseEnv({ TOOL_RUN_QUOTA_PER_HOUR: '', TOOL_RUN_RETENTION_DAYS: '' }),
    );

    expect(env.tools).toEqual({
      quotaPerHour: TOOL_QUOTA_PER_HOUR_DEFAULT,
      retentionDays: TOOL_RUN_RETENTION_DAYS_DEFAULT,
    });
  });

  it('未配置与显式写 0 是两回事：0 表示关闭工具执行', () => {
    // `Number('') === 0`，所以用 `z.coerce.number()` 会把「没配」读成 0，
    // 等于手滑一次就把工具台整体关掉。这条用例钉住这个区别。
    expect(parseServerEnv(baseEnv({ TOOL_RUN_QUOTA_PER_HOUR: '' })).tools.quotaPerHour).toBe(
      TOOL_QUOTA_PER_HOUR_DEFAULT,
    );
    expect(parseServerEnv(baseEnv({ TOOL_RUN_QUOTA_PER_HOUR: '0' })).tools.quotaPerHour).toBe(0);
    expect(parseServerEnv(baseEnv({ TOOL_RUN_QUOTA_PER_HOUR: '120' })).tools.quotaPerHour).toBe(
      120,
    );
  });

  it('把「多打了几个零」和负数拦住', () => {
    expect(() => parseServerEnv(baseEnv({ TOOL_RUN_QUOTA_PER_HOUR: '-1' }))).toThrow(
      /TOOL_RUN_QUOTA_PER_HOUR/,
    );
    expect(() => parseServerEnv(baseEnv({ TOOL_RUN_QUOTA_PER_HOUR: '99999999' }))).toThrow(
      /TOOL_RUN_QUOTA_PER_HOUR/,
    );
  });
});

describe('parseServerEnv：OAuth 凭证', () => {
  it('空字符串按「未配置」处理，不判成配错', () => {
    const env = parseServerEnv(
      baseEnv({
        GITHUB_CLIENT_ID: '',
        GITHUB_CLIENT_SECRET: '',
        LINUXDO_CLIENT_ID: '',
        LINUXDO_CLIENT_SECRET: '',
      }),
    );

    expect('github' in env.oauth).toBe(false);
    expect('linuxdo' in env.oauth).toBe(false);
  });

  it('只填一半的凭证直接拦下，而不是留到第一次登录才炸', () => {
    expect(() =>
      parseServerEnv(baseEnv({ GITHUB_CLIENT_ID: 'id-only', GITHUB_CLIENT_SECRET: '' })),
    ).toThrow(/GITHUB_CLIENT_ID 与 GITHUB_CLIENT_SECRET 必须同时配置/);

    expect(() =>
      parseServerEnv(baseEnv({ GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: 'secret-only' })),
    ).toThrow(/GITHUB_CLIENT_ID 与 GITHUB_CLIENT_SECRET 必须同时配置/);
  });

  it('GitHub 配全后可被领域层当作可用登录方式', () => {
    const env = parseServerEnv(
      baseEnv({ GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret' }),
    );

    expect(env.oauth.github).toEqual({ clientId: 'gh-id', clientSecret: 'gh-secret' });
    expect(enabledOAuthProviders(env)).toEqual(['github']);
  });

  it('Linux.do 只给凭证不给端点时抛错，并点名缺了哪几个', () => {
    expect(() =>
      parseServerEnv(
        baseEnv({
          LINUXDO_CLIENT_ID: 'ld-id',
          LINUXDO_CLIENT_SECRET: 'ld-secret',
          LINUXDO_AUTHORIZATION_URL: 'https://connect.invalid/oauth2/authorize',
        }),
      ),
    ).toThrow(/LINUXDO_TOKEN_URL、LINUXDO_USERINFO_URL/);
  });

  it('Linux.do 端点与凭证齐全后才出现在配置里', () => {
    const env = parseServerEnv(
      baseEnv({
        LINUXDO_CLIENT_ID: 'ld-id',
        LINUXDO_CLIENT_SECRET: 'ld-secret',
        LINUXDO_AUTHORIZATION_URL: 'https://authorize.example/oauth2/authorize',
        LINUXDO_TOKEN_URL: 'https://authorize.example/oauth2/token',
        LINUXDO_USERINFO_URL: 'https://authorize.example/api/user',
      }),
    );

    expect(env.oauth.linuxdo).toEqual({
      clientId: 'ld-id',
      clientSecret: 'ld-secret',
      authorizationUrl: 'https://authorize.example/oauth2/authorize',
      tokenUrl: 'https://authorize.example/oauth2/token',
      userInfoUrl: 'https://authorize.example/api/user',
    });
    expect(enabledOAuthProviders(env)).toEqual(['linuxdo']);
  });

  it('两个提供方都配上时顺序稳定：github 在前', () => {
    const env = parseServerEnv(
      baseEnv({
        GITHUB_CLIENT_ID: 'gh-id',
        GITHUB_CLIENT_SECRET: 'gh-secret',
        LINUXDO_CLIENT_ID: 'ld-id',
        LINUXDO_CLIENT_SECRET: 'ld-secret',
        LINUXDO_AUTHORIZATION_URL: 'https://authorize.example/oauth2/authorize',
        LINUXDO_TOKEN_URL: 'https://authorize.example/oauth2/token',
        LINUXDO_USERINFO_URL: 'https://authorize.example/api/user',
      }),
    );

    expect(enabledOAuthProviders(env)).toEqual(['github', 'linuxdo']);
  });
});
