import type { TabSnapshot } from '../../../shared/contracts/schemas';
import { CertificateErrorPage } from './CertificateErrorPage';
import { ClientCertificatePage } from './ClientCertificatePage';
import { CrashedPage } from './CrashedPage';
import { DiagnosticsPage } from './DiagnosticsPage';
import { NetworkErrorPage } from './NetworkErrorPage';
import { NewTabPage } from './NewTabPage';

/** The page the shell draws itself for a tab whose page is internal. Nothing for a web page. */
export function InternalPage({ tab }: { readonly tab: TabSnapshot }) {
  const { page } = tab;
  if (page.kind !== 'internal') {
    return null;
  }
  switch (page.name) {
    case 'new-tab':
      return <NewTabPage tabId={tab.id} />;
    case 'network-error':
      return (
        <NetworkErrorPage tabId={tab.id} address={tab.address.text} errorName={page.error?.name} />
      );
    case 'certificate-error':
      return (
        <CertificateErrorPage
          tabId={tab.id}
          address={tab.address.text}
          errorName={page.error?.name}
          canGoBack={tab.canGoBack}
        />
      );
    case 'client-certificate':
      return (
        <ClientCertificatePage
          tabId={tab.id}
          address={tab.address.text}
          errorName={page.error?.name}
          canGoBack={tab.canGoBack}
        />
      );
    case 'crashed':
      return <CrashedPage tabId={tab.id} reason={page.error?.name} />;
    case 'diagnostics':
      return <DiagnosticsPage />;
  }
}
