import { ShieldAlert } from 'lucide-react';

import { ErrorPageActions } from './ErrorPageActions';

interface CertificateErrorPageProps {
  readonly tabId: string;
  /** The address that failed, as the address bar shows it. */
  readonly address: string;
  /** Chromium's error name, such as ERR_CERT_AUTHORITY_INVALID. */
  readonly errorName: string | undefined;
  readonly canGoBack: boolean;
}

/**
 * Shown when a site's certificate can't be trusted. Main detaches the tab's view, so the shell
 * draws this. It has no way to continue anyway: the connection is not private, and a click-through
 * is how people hand their passwords to someone else.
 */
export function CertificateErrorPage({
  tabId,
  address,
  errorName,
  canGoBack,
}: CertificateErrorPageProps) {
  return (
    <div
      data-internal-page="certificate-error"
      className="flex min-h-full flex-col items-center gap-4 px-6 pt-[18vh] pb-10 text-center"
    >
      <ShieldAlert className="size-10 text-red-700 dark:text-red-400" aria-hidden="true" />
      <h1 className="text-2xl font-semibold tracking-tight">
        Your connection to this site isn&apos;t private
      </h1>
      <p className="max-w-xl">
        Veltriva couldn&apos;t confirm that this is the site you meant to reach. Someone could be
        trying to steal information you send to it, such as passwords, messages or card numbers.
      </p>
      {address === '' ? null : <p className="max-w-xl break-all">{address}</p>}
      {errorName === undefined ? null : (
        <p className="font-mono text-xs text-foreground/70">{errorName}</p>
      )}
      <p className="max-w-xl text-sm text-foreground/70">
        For your safety, Veltriva won&apos;t open this site until the problem is fixed.
      </p>
      <ErrorPageActions tabId={tabId} canGoBack={canGoBack} />
    </div>
  );
}
