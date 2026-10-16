import { Compass, FileText, Lock, Search, TriangleAlert } from 'lucide-react';

import type { TabSnapshot } from '../../../shared/contracts/schemas';

type Security = TabSnapshot['address']['security'];

/** The state is on `data-security` for tests; assistive technology gets the label. */
export function AddressIndicator({ security }: { readonly security: Security }) {
  switch (security) {
    case 'secure':
      return (
        <span
          role="img"
          aria-label="Secure connection"
          title="Secure connection"
          data-security={security}
          className="flex shrink-0 items-center text-foreground/70"
        >
          <Lock className="size-4" aria-hidden="true" />
        </span>
      );
    case 'not-secure':
      // The text is visible on purpose: an insecure page must not rely on an icon alone.
      return (
        <span
          role="img"
          aria-label="Not secure"
          data-security={security}
          className="flex shrink-0 items-center gap-1 text-sm font-medium text-red-700 dark:text-red-400"
        >
          <TriangleAlert className="size-4" aria-hidden="true" />
          Not secure
        </span>
      );
    case 'local':
      return (
        <span
          role="img"
          aria-label="Local file"
          title="Local file"
          data-security={security}
          className="flex shrink-0 items-center text-foreground/70"
        >
          <FileText className="size-4" aria-hidden="true" />
        </span>
      );
    case 'internal':
      return (
        <span
          role="img"
          aria-label="Veltriva page"
          title="Veltriva page"
          data-security={security}
          className="flex shrink-0 items-center text-foreground/70"
        >
          <Compass className="size-4" aria-hidden="true" />
        </span>
      );
    case 'neutral':
      return (
        <span
          aria-hidden="true"
          data-security={security}
          className="flex shrink-0 items-center text-foreground/70"
        >
          <Search className="size-4" />
        </span>
      );
  }
}

/** Shown beside the indicator when main removed `user:password@` from the address. */
export function CredentialsRemovedIndicator() {
  const label = 'A username or password was removed from this address';
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-indicator="credentials-removed"
      className="flex shrink-0 items-center text-red-700 dark:text-red-400"
    >
      <TriangleAlert className="size-4" aria-hidden="true" />
    </span>
  );
}
