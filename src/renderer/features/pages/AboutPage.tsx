import { RefreshCw } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';

import {
  checkForUpdates,
  fetchAppInfo,
  fetchLicenses,
  fetchUpdateStatus,
  openSettings,
} from '../../state/commands';
import type { AppInfo, Licenses } from '../../state/commands';
import { updateStatusText } from './update-display';
import type { UpdateView } from './update-display';

/**
 * About (`veltriva://about`, M6.3, assessment §7.2 "About page with versions and licenses"): what
 * this build is, Veltriva's own license, and every third-party license it ships
 * (THIRD_PARTY_NOTICES.txt, which main reads from the app's resources). Whether updates are
 * checked, and the button to check now, are here too; the setting itself is in Settings.
 */
export function AboutPage() {
  const [info, setInfo] = useState<AppInfo | null | 'failed'>(null);
  const [licenses, setLicenses] = useState<Licenses | null | 'failed'>(null);
  const [updates, setUpdates] = useState<UpdateView | null>(null);
  const noticesId = useId();

  useEffect(() => {
    let current = true;
    void fetchAppInfo().then((value) => {
      if (current) {
        setInfo(value ?? 'failed');
      }
    });
    void fetchLicenses().then((value) => {
      if (current) {
        setLicenses(value ?? 'failed');
      }
    });
    void fetchUpdateStatus().then((value) => {
      if (current && value !== undefined) {
        setUpdates(value);
      }
    });
    return () => {
      current = false;
    };
  }, []);

  const checkNow = async (): Promise<void> => {
    if (updates === null) {
      return;
    }
    setUpdates({ ...updates, checking: true });
    setUpdates((await checkForUpdates()) ?? { ...updates, checking: false });
  };

  return (
    <div
      data-internal-page="about"
      data-about-state={info === null || licenses === null ? 'loading' : 'ready'}
      className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-8 px-6 py-8"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">About Veltriva Browser</h1>
        <p className="text-sm text-foreground/70">
          A local-first browser that unloads the tabs you aren&apos;t using and remembers every one
          of them. Browse freely. Remember effortlessly.
        </p>
      </header>

      <section aria-labelledby="about-versions" className="flex flex-col gap-3">
        <h2 id="about-versions" className="text-lg font-semibold">
          This build
        </h2>
        {info === null ? <p className="text-sm text-foreground/70">Loading…</p> : null}
        {info === 'failed' ? (
          <p className="text-sm">The versions could not be read.</p>
        ) : info === null ? null : (
          <table data-about-versions="" className="w-full max-w-md text-sm">
            <caption className="sr-only">Versions</caption>
            <tbody>
              {[
                ['Veltriva Browser', info.version],
                ['Electron', info.versions.electron],
                ['Chromium', info.versions.chrome],
                ['Node.js', info.versions.node],
                ['V8', info.versions.v8],
              ].map(([name, version]) => (
                <tr key={name} className="border-b last:border-b-0">
                  <th scope="row" className="py-1.5 pr-4 text-left font-medium">
                    {name}
                  </th>
                  <td className="py-1.5 font-mono" data-version-of={name}>
                    {version}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="about-updates" className="flex flex-col gap-3">
        <h2 id="about-updates" className="text-lg font-semibold">
          Updates
        </h2>
        <p data-about-updates="" role="status" className="text-sm">
          {updates === null ? 'Loading…' : updateStatusText(updates)}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {updates?.enabled === true ? (
            <Button
              variant="outline"
              data-about-check=""
              disabled={updates.checking}
              onClick={() => {
                void checkNow();
              }}
              className={FOCUS_RING}
            >
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
              Check now
            </Button>
          ) : null}
          <Button
            variant="outline"
            data-about-settings=""
            onClick={() => {
              void openSettings();
            }}
            className={FOCUS_RING}
          >
            Update settings
          </Button>
        </div>
        <p className="text-sm text-foreground/70">
          Veltriva tells you when a newer version is out, if you turn that on. It never downloads or
          installs anything by itself.
        </p>
      </section>

      <section aria-labelledby="about-license" className="flex flex-col gap-3">
        <h2 id="about-license" className="text-lg font-semibold">
          License
        </h2>
        {licenses === null ? <p className="text-sm text-foreground/70">Loading…</p> : null}
        {licenses === 'failed' ? (
          <p className="text-sm">The license texts could not be read.</p>
        ) : licenses === null ? null : (
          <>
            <p className="text-sm">
              Veltriva Browser is free software under the MIT License. It is built on Electron and
              Chromium, and includes other open-source software, each under its own license.
            </p>
            <pre
              data-about-license=""
              tabIndex={0}
              aria-label="The MIT License"
              className="max-h-64 overflow-auto rounded-md border bg-card p-3 text-xs whitespace-pre-wrap select-text"
            >
              {licenses.license}
            </pre>
            <details className="flex flex-col gap-2">
              <summary className={`cursor-pointer text-sm font-medium ${FOCUS_RING}`}>
                Third-party notices
              </summary>
              <pre
                id={noticesId}
                data-about-notices=""
                tabIndex={0}
                aria-label="Third-party notices"
                className="mt-2 max-h-96 overflow-auto rounded-md border bg-card p-3 text-xs whitespace-pre-wrap select-text"
              >
                {licenses.notices}
              </pre>
            </details>
            <p className="text-sm text-foreground/70">
              Chromium&apos;s and Node.js&apos;s own licenses are in LICENSES.chromium.html, next to
              Veltriva.exe in the installation folder.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
