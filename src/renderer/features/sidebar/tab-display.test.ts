import { describe, expect, it } from 'vitest';

import { tabLabel, tabStatus } from './tab-display';

type Tab = Parameters<typeof tabLabel>[0];

const webTab: Tab = {
  title: 'Example Domain',
  address: { text: 'example.com' },
  runtime: 'live',
  loading: false,
  page: { kind: 'web' },
};
const newTab: Tab = {
  title: '',
  address: { text: '' },
  runtime: 'live',
  loading: false,
  page: { kind: 'internal', name: 'new-tab' },
};

describe('tabLabel', () => {
  it('prefers the title', () => {
    expect(tabLabel(webTab)).toBe('Example Domain');
  });

  it('falls back to "New Tab" on the new-tab page', () => {
    expect(tabLabel(newTab)).toBe('New Tab');
  });

  it('falls back to the address when a web page has no title', () => {
    expect(tabLabel({ ...webTab, title: '' })).toBe('example.com');
  });

  it('uses the address for an error page without a title', () => {
    const failed: Tab = {
      ...webTab,
      title: '',
      page: { kind: 'internal', name: 'network-error' },
    };
    expect(tabLabel(failed)).toBe('example.com');
  });

  it('is "Untitled" when there is nothing else', () => {
    expect(tabLabel({ ...webTab, title: '', address: { text: '' } })).toBe('Untitled');
  });

  it('treats a blank title as no title', () => {
    expect(tabLabel({ ...webTab, title: '   ' })).toBe('example.com');
    expect(tabLabel({ ...newTab, title: ' \t ' })).toBe('New Tab');
  });

  it('trims the title and leaves its text as it is', () => {
    expect(tabLabel({ ...webTab, title: '  <b>Hi</b>  ' })).toBe('<b>Hi</b>');
  });
});

describe('tabStatus', () => {
  it('is null for a settled page', () => {
    expect(tabStatus(webTab)).toBeNull();
    expect(tabStatus(newTab)).toBeNull();
  });

  it('is "loading" while a page loads', () => {
    expect(tabStatus({ ...webTab, loading: true })).toBe('loading');
  });

  it('is "failed" on the network-error page', () => {
    expect(tabStatus({ ...webTab, page: { kind: 'internal', name: 'network-error' } })).toBe(
      'failed',
    );
  });

  it('is "crashed" for a crashed runtime or the crashed page', () => {
    expect(tabStatus({ ...webTab, runtime: 'crashed' })).toBe('crashed');
    expect(tabStatus({ ...webTab, page: { kind: 'internal', name: 'crashed' } })).toBe('crashed');
  });

  it('puts a crash before a failure and a failure before loading', () => {
    const failedAndLoading: Tab = {
      ...webTab,
      loading: true,
      page: { kind: 'internal', name: 'network-error' },
    };
    expect(tabStatus(failedAndLoading)).toBe('failed');
    expect(tabStatus({ ...failedAndLoading, runtime: 'crashed' })).toBe('crashed');
  });
});
