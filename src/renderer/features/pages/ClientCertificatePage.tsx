import { IdCard } from 'lucide-react';

import { ErrorPageActions } from './ErrorPageActions';

interface ClientCertificatePageProps {
  readonly tabId: string;
  /** The address that failed, as the address bar shows it. */
  readonly address: string;
  /** Chromium's error name, such as ERR_SSL_CLIENT_AUTH_CERT_NEEDED. */
  readonly errorName: string | undefined;
  readonly canGoBack: boolean;
}

/**
 * Shown when a site asks the visitor for a certificate to sign in with. Veltriva doesn't choose
 * certificates yet, so such a site can't be opened. Main detaches the tab's view, so the shell
 * draws this.
 */
export function ClientCertificatePage({
  tabId,
  address,
  errorName,
  canGoBack,
}: ClientCertificatePageProps) {
  return (
    <div
      data-internal-page="client-certificate"
      className="flex min-h-full flex-col items-center gap-4 px-6 pt-[18vh] pb-10 text-center"
    >
      <IdCard className="size-10 text-foreground/70" aria-hidden="true" />
      <h1 className="text-2xl font-semibold tracking-tight">
        This site needs a certificate to sign in
      </h1>
      <p className="max-w-xl">
        The site asks for a certificate that identifies you. Veltriva can&apos;t choose one yet, so
        this site can&apos;t be opened.
      </p>
      {address === '' ? null : <p className="max-w-xl break-all">{address}</p>}
      {errorName === undefined ? null : (
        <p className="font-mono text-xs text-foreground/70">{errorName}</p>
      )}
      <ErrorPageActions tabId={tabId} canGoBack={canGoBack} />
    </div>
  );
}
