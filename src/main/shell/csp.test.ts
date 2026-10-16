import { describe, expect, it } from 'vitest';

import { devShellCsp, SHELL_CSP } from './csp';

function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split(';').map((part) => {
      const [name = '', ...values] = part.trim().split(/\s+/);
      return [name, values.join(' ')];
    }),
  );
}

describe('SHELL_CSP', () => {
  const policy = directives(SHELL_CSP);

  it('is the assessment §6.2 policy', () => {
    expect(Object.fromEntries(policy)).toEqual({
      'default-src': "'none'",
      'script-src': "'self'",
      'style-src': "'self'",
      'img-src': "'self' data: blob:",
      'font-src': "'self'",
      'connect-src': "'self'",
      'object-src': "'none'",
      'base-uri': "'none'",
      'form-action': "'none'",
      'frame-ancestors': "'none'",
    });
  });

  it('never allows inline or evaluated script', () => {
    expect(SHELL_CSP).not.toMatch(/unsafe-inline|unsafe-eval|wasm-unsafe-eval|\*/);
  });
});

describe('devShellCsp', () => {
  it('allows what the Vite dev server needs, on its own origin only', () => {
    const policy = directives(devShellCsp('http://localhost:5173'));
    expect(policy.get('script-src')).toBe("'self' 'unsafe-inline'");
    expect(policy.get('style-src')).toBe("'self' 'unsafe-inline'");
    expect(policy.get('connect-src')).toBe("'self' ws://localhost:5173");
    expect(policy.get('frame-ancestors')).toBe("'none'");
    expect(policy.get('script-src')).not.toContain('unsafe-eval');
  });

  it('refuses a dev server that is not plain http', () => {
    expect(() => devShellCsp('https://localhost:5173')).toThrow(/http/);
  });
});
