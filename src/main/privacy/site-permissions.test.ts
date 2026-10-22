import { describe, expect, it, vi } from 'vitest';

import { ClientHintOptIns } from '../../core/net/client-hints';
import { PermissionDecisions } from '../../core/permissions/permission-decisions';
import { DATA_METHODS } from '../../shared/contracts/data-rpc';
import type { DataMethod } from '../../shared/contracts/data-rpc';
import { SitePermissions } from './site-permissions';

/** A protocol guard's always-allow list, as ExternalProtocolGuard keeps it. */
function protocolsOf(entries: { site: string; scheme: string }[]) {
  const list = [...entries];
  return {
    alwaysAllowed: () => [...list],
    revoke: (site: string, scheme: string) => {
      const at = list.findIndex((entry) => entry.site === site && entry.scheme === scheme);
      if (at === -1) {
        return false;
      }
      list.splice(at, 1);
      return true;
    },
  };
}

function setup() {
  const calls: { method: string; input: unknown }[] = [];
  const call = vi.fn((method: DataMethod, input: unknown) => {
    DATA_METHODS[method].input.parse(input);
    calls.push({ method, input });
    return Promise.resolve({ count: 1 });
  });
  const written: { origin: string; permission: string; decision: string }[] = [];
  const decisions = new PermissionDecisions({
    stored: [
      { origin: 'https://meet.example.com', permission: 'camera', decision: 'allow' },
      { origin: 'https://meet.example.com', permission: 'microphone', decision: 'allow' },
      { origin: 'https://news.example.org', permission: 'notifications', decision: 'block' },
    ],
    onDecided: (origin, permission, decision) => {
      written.push({ origin, permission, decision });
    },
  });
  const hintsChanged = vi.fn();
  const clientHints = new ClientHintOptIns({
    stored: {
      v: 1,
      origins: {
        'https://www.example.com': ['sec-ch-ua-arch'],
        'https://example.net': ['sec-ch-ua-model'],
      },
    },
    onChange: hintsChanged,
  });
  const protocols = protocolsOf([
    { site: 'https://meet.example.com', scheme: 'zoommtg' },
    { site: 'https://example.net', scheme: 'mailto' },
  ]);
  const permissions = new SitePermissions({
    decisions,
    protocols,
    clientHints,
    data: { call: call as never },
    logger: { warn: vi.fn(), error: vi.fn() },
  });
  return { permissions, calls, written, hintsChanged };
}

describe('SitePermissions (M5.2)', () => {
  it('lists every stored answer: decisions by origin and permission, apps, browser details', () => {
    expect(setup().permissions.view()).toEqual({
      decisions: [
        { origin: 'https://meet.example.com', permission: 'camera', decision: 'allow' },
        { origin: 'https://meet.example.com', permission: 'microphone', decision: 'allow' },
        { origin: 'https://news.example.org', permission: 'notifications', decision: 'block' },
      ],
      protocols: [
        { origin: 'https://meet.example.com', scheme: 'zoommtg' },
        { origin: 'https://example.net', scheme: 'mailto' },
      ],
      clientHints: [
        { origin: 'https://www.example.com', hints: ['sec-ch-ua-arch'] },
        { origin: 'https://example.net', hints: ['sec-ch-ua-model'] },
      ],
    });
  });

  it('changes a decision, written through as an answer is', () => {
    const { permissions, written } = setup();

    expect(permissions.setDecision('https://meet.example.com', 'camera', 'block')).toBe(true);

    expect(written).toEqual([
      { origin: 'https://meet.example.com', permission: 'camera', decision: 'block' },
    ]);
    expect(permissions.view().decisions[0]).toEqual({
      origin: 'https://meet.example.com',
      permission: 'camera',
      decision: 'block',
    });
  });

  it('revokes a decision: it leaves memory and the table, and the page will ask again', () => {
    const { permissions, calls } = setup();

    expect(permissions.setDecision('https://meet.example.com', 'camera', null)).toBe(true);
    expect(permissions.setDecision('https://meet.example.com', 'camera', null)).toBe(false);

    expect(permissions.view().decisions.map((entry) => entry.permission)).toEqual([
      'microphone',
      'notifications',
    ]);
    expect(calls).toEqual([
      {
        method: 'permissions.delete',
        input: { origin: 'https://meet.example.com', permission: 'camera' },
      },
    ]);
  });

  it("revokes an app's always-open, deleting its protocol row", () => {
    const { permissions, calls } = setup();

    expect(permissions.revokeProtocol('https://meet.example.com', 'zoommtg')).toBe(true);

    expect(permissions.view().protocols).toEqual([
      { origin: 'https://example.net', scheme: 'mailto' },
    ]);
    expect(calls).toEqual([
      {
        method: 'permissions.delete',
        input: { origin: 'https://meet.example.com', permission: 'protocol:zoommtg' },
      },
    ]);
  });

  it("revokes a site's browser details, and its document is written again", () => {
    const { permissions, hintsChanged } = setup();

    expect(permissions.revokeClientHints('https://example.net')).toBe(true);

    expect(permissions.view().clientHints.map((entry) => entry.origin)).toEqual([
      'https://www.example.com',
    ]);
    expect(hintsChanged).toHaveBeenCalledTimes(1);
  });

  it("forgets a site: everything its own origins were given, and nothing of another site's", () => {
    const { permissions, calls } = setup();

    permissions.forgetSite('example.com');

    expect(permissions.view()).toEqual({
      decisions: [
        { origin: 'https://news.example.org', permission: 'notifications', decision: 'block' },
      ],
      protocols: [{ origin: 'https://example.net', scheme: 'mailto' }],
      clientHints: [{ origin: 'https://example.net', hints: ['sec-ch-ua-model'] }],
    });
    expect(calls).toEqual([
      { method: 'permissions.delete', input: { origin: 'https://meet.example.com' } },
      {
        method: 'permissions.delete',
        input: { origin: 'https://meet.example.com', permission: 'protocol:zoommtg' },
      },
    ]);
  });
});
