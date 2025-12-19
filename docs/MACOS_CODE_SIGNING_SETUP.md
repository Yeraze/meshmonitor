# macOS Code Signing Setup Guide

This guide walks you through setting up macOS code signing and notarization for MeshMonitor desktop releases.

## Prerequisites

- **Apple Developer Account** ($99/year) - https://developer.apple.com/programs/
- **macOS computer** (required to export the certificate)
- **Admin access** to the GitHub repository (to add secrets)

---

## Step 1: Create a Developer ID Certificate

1. Go to https://developer.apple.com/account/resources/certificates/list
2. Click the **+** button to create a new certificate
3. Select **"Developer ID Application"** (for apps distributed outside App Store)
4. Follow the prompts to create a Certificate Signing Request (CSR) using Keychain Access:
   - Open **Keychain Access** → Certificate Assistant → Request a Certificate from a Certificate Authority
   - Enter your email and select "Saved to disk"
   - Upload the CSR to Apple's developer portal
5. Download the certificate and double-click to install it in your Keychain

---

## Step 2: Export the Certificate as .p12

1. Open **Keychain Access** on your Mac
2. In the left sidebar, select **"login"** keychain and **"My Certificates"** category
3. Find your **"Developer ID Application: Your Name (TEAMID)"** certificate
4. Right-click → **Export**
5. Save as `.p12` format (e.g., `MeshMonitor-Certificate.p12`)
6. **Set a strong password** - you'll need this for `APPLE_CERTIFICATE_PASSWORD`

> **Important:** Keep this password secure. You'll enter it as a GitHub secret.

---

## Step 3: Convert Certificate to Base64

Open Terminal and run:

```bash
# Convert .p12 to base64 (single line, no newlines)
base64 -i MeshMonitor-Certificate.p12 | tr -d '\n' > certificate-base64.txt

# View the contents (will be a long string)
cat certificate-base64.txt
```

Copy the entire output - this goes into the **`APPLE_CERTIFICATE`** secret.

---

## Step 4: Get Your Signing Identity Name

In Terminal, run:

```bash
# List all signing identities
security find-identity -v -p codesigning
```

You'll see output like:
```
1) ABC123DEF456789... "Developer ID Application: John Doe (ABC123XYZ)"
     1 valid identities found
```

Copy the **full quoted name** (e.g., `Developer ID Application: John Doe (ABC123XYZ)`).

This goes into **`APPLE_SIGNING_IDENTITY`**.

---

## Step 5: Get Your Team ID

Your Team ID is the 10-character alphanumeric code in parentheses at the end of your signing identity.

From the example above: `ABC123XYZ`

You can also find it at:
- https://developer.apple.com/account → Membership → **Team ID**

This goes into **`APPLE_TEAM_ID`**.

---

## Step 6: Create an App Store Connect API Key

1. Go to https://appstoreconnect.apple.com/access/integrations/api
2. If you don't see the API Keys section, you may need to request access or have the Account Holder enable it
3. Click **"Generate API Key"** (or the **+** button)
4. Fill in:
   - **Name:** `MeshMonitor CI` (or any descriptive name)
   - **Access:** Select **"Developer"** role (sufficient for notarization)
5. Click **Generate**

**IMPORTANT:**
- Download the `.p8` file **immediately** - you can only download it once!
- Save it somewhere secure (e.g., `AuthKey_XXXXXXXXXX.p8`)

Note these values from the page:
- **Issuer ID** (shown at the top of the page, UUID format like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
- **Key ID** (10-character alphanumeric string in the table)

---

## Step 7: Get the API Key Contents

In Terminal:

```bash
# View the .p8 file contents
cat ~/Downloads/AuthKey_XXXXXXXXXX.p8
```

You'll see something like:
```
-----BEGIN PRIVATE KEY-----
MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg...
...several lines of base64...
-----END PRIVATE KEY-----
```

Copy the **entire contents** including the `BEGIN` and `END` lines.

This goes into **`APPLE_API_KEY_CONTENT`**.

---

## Step 8: Add Secrets to GitHub

1. Go to: https://github.com/Yeraze/meshmonitor/settings/secrets/actions
2. Click **"New repository secret"**
3. Add each of the following secrets:

| Secret Name | What to Enter |
|-------------|---------------|
| `APPLE_CERTIFICATE` | The entire contents of `certificate-base64.txt` from Step 3 |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the .p12 in Step 2 |
| `APPLE_SIGNING_IDENTITY` | The full certificate name from Step 4 (e.g., `Developer ID Application: John Doe (ABC123XYZ)`) |
| `APPLE_ID` | Your Apple ID email address (e.g., `john@example.com`) |
| `APPLE_TEAM_ID` | Your 10-character Team ID from Step 5 (e.g., `ABC123XYZ`) |
| `APPLE_API_KEY` | The Key ID from Step 6 (10 characters, e.g., `XXXXXXXXXX`) |
| `APPLE_API_ISSUER` | The Issuer ID from Step 6 (UUID format) |
| `APPLE_API_KEY_CONTENT` | The full contents of the .p8 file from Step 7 |

---

## Step 9: Test the Setup

After merging PR #1156, you can test by either:

1. **Creating a new release** - The workflow triggers automatically
2. **Manual trigger** - Go to Actions → Desktop Release → Run workflow

The workflow will:
1. Import your certificate into a temporary keychain on the runner
2. Build the Tauri app
3. Sign the app with your Developer ID
4. Submit to Apple's notarization service
5. Wait for notarization approval
6. Staple the notarization ticket to the DMG
7. Upload the signed, notarized DMG to the release

---

## Troubleshooting

### "No signing identity found"
- Verify `APPLE_SIGNING_IDENTITY` matches exactly what `security find-identity` shows
- Ensure the certificate hasn't expired

### "Notarization failed"
- Check that all API key values are correct
- Ensure the API key has "Developer" access or higher
- Look at the Apple notarization logs in the workflow output

### "Certificate has been revoked"
- Create a new Developer ID Application certificate
- Export and update the GitHub secrets

### Build hangs on codesign
- This usually means the keychain is locked or the partition list isn't set correctly
- The workflow should handle this, but check the "Import Apple signing certificate" step logs

---

## Security Best Practices

1. **Never commit** certificates, keys, or passwords to your repository
2. **Delete local copies** of `.p12` and `.p8` files after adding to GitHub Secrets
3. **Rotate certificates** if you suspect they've been compromised
4. **Use API keys** instead of app-specific passwords (more secure, can be revoked)
5. **Limit access** to GitHub repository settings to trusted maintainers
6. **Review the workflow** to ensure secrets aren't accidentally logged

---

## Quick Reference: All Secrets

```
APPLE_CERTIFICATE           = <base64 encoded .p12 file>
APPLE_CERTIFICATE_PASSWORD  = <password for .p12>
APPLE_SIGNING_IDENTITY      = Developer ID Application: Your Name (TEAMID)
APPLE_ID                    = your-email@example.com
APPLE_TEAM_ID               = XXXXXXXXXX
APPLE_API_KEY               = XXXXXXXXXX
APPLE_API_ISSUER            = xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
APPLE_API_KEY_CONTENT       = -----BEGIN PRIVATE KEY-----
                              <key content>
                              -----END PRIVATE KEY-----
```

---

## Related Links

- [Apple Developer Program](https://developer.apple.com/programs/)
- [App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi)
- [Tauri macOS Code Signing Docs](https://v2.tauri.app/distribute/sign/macos/)
- [GitHub Encrypted Secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
