# Code signing (not set up: your decision)

Veltriva's builds are **unsigned**. Signing costs money, or needs a public repository for the free route, so it's your call (ADR-0007 item 5). This page says what unsigned means for users, and exactly what to change once you choose a signing route. Nothing in the repository needs to change until then.

## What users see with an unsigned build

- **Downloading the installer:** Edge and Chrome may say the file "isn't commonly downloaded". The user chooses **Keep** (Edge: **⋯ ▸ Keep ▸ Keep anyway**).
- **Running it:** Microsoft Defender SmartScreen shows **"Windows protected your PC"**, with "Unknown publisher". The user chooses **More info ▸ Run anyway**.
  - SmartScreen builds a reputation per file. Every new version starts again from nothing, so each release shows the warning until enough people have run it.
- **Installed:** the app and its uninstaller show "Unknown publisher" under Apps ▸ Installed apps, and in any UAC prompt. Veltriva's installer is per-user and never asks for admin rights, so no UAC prompt appears in normal use.
- **What stays the same either way:** the ASAR integrity fuse still detects a modified `app.asar` (`check-packaged-app.mjs` reads the fuses back on every build). Signing adds the proof of **who** built it, and lets Windows trust the publisher's reputation across versions.

## The routes

| Route | Cost | Needs | Notes |
|---|---|---|---|
| **SignPath Foundation** (ADR-0007's choice) | Free for open source | A public repository under an OSI license (MIT is fine); builds made by CI from that repository; MFA | You sign each release by approving it in SignPath. Signing happens in SignPath's service, not on your machine |
| **Azure Artifact Signing** (formerly Trusted Signing) | A monthly fee | An Azure subscription and identity validation; the public-trust tier for individuals is region-limited | electron-builder supports it directly (`azureSignOptions`) |
| **An OV or EV certificate** from a certificate authority | Yearly fee; EV costs more | A hardware token or a cloud HSM (required for new certificates since 2023) | electron-builder's `signtoolOptions`, or a custom `sign` script for the HSM |

## What to change for each

Every route signs `Veltriva.exe`, the installer and the uninstaller. electron-builder signs them when it finds signing settings, and does nothing otherwise.

### Azure Artifact Signing

In `electron-builder.yml`, under `win:`:

```yaml
win:
  azureSignOptions:
    publisherName: Raymond Valdepeñas # exactly as on the certificate
    endpoint: https://<region>.codesigning.azure.net
    codeSigningAccountName: <account>
    certificateProfileName: <profile>
```

Then build with the Microsoft Entra credentials in the environment: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`, or another method Azure Identity accepts. In CI, keep them as repository secrets.

### A certificate (OV/EV) through signtool

```yaml
win:
  signtoolOptions:
    publisherName: Raymond Valdepeñas
    signingHashAlgorithms: [sha256]
    timeStampServer: http://timestamp.digicert.com # your CA's RFC 3161 server
```

- **With a `.pfx` file** (OV only; EV keys can't be exported): set `CSC_LINK` (the file's path, or base64) and `CSC_KEY_PASSWORD` in the environment. Never commit either.
- **With a hardware token or cloud HSM:** set `certificateSubjectName` instead, or point `win.sign` at a small script that calls the vendor's signing tool.

### SignPath Foundation

- **Apply:** <https://signpath.org>.
- **Once accepted,** CI builds the unsigned artifacts as today, then submits them to SignPath with its GitHub Action. You approve the request, and the action returns the signed files to attach to the draft release.
- **Leave `electron-builder.yml` without signing settings,** since SignPath signs after the build. Its signing policy must include the files *inside* the installer (deep signing), so `Veltriva.exe` and the uninstaller are signed too.

## Checking a signed build

```powershell
Get-AuthenticodeSignature "release\Veltriva-Browser-Setup-<version>.exe" | Format-List Status, SignerCertificate, TimeStamperCertificate
Get-AuthenticodeSignature "$env:LOCALAPPDATA\Programs\veltriva\Veltriva.exe" | Format-List Status, SignerCertificate
```

`Status` must be `Valid`, with a timestamp, so the signature outlives the certificate.

## After signing: updates

ADR-0007 item 4 plans silent auto-update (`electron-updater`) only for signed builds, because the updater checks that a new version has the same publisher.

**Until then:** the update notification (M6.3, off by default) only tells the user that a new version exists, and links to its release page. It downloads nothing.
