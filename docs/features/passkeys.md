# Passkeys

A passkey lets you sign in with your device's fingerprint, face or PIN instead of a password. Your device keeps the private key. MeshMonitor stores only the public half.

Passkeys work for **local accounts only**. Accounts that sign in through [SSO (OpenID Connect)](/configuration/sso) or proxy authentication cannot add passkeys.

## Requirements

- **HTTPS, or `http://localhost`.** Browsers turn passkeys off on plain HTTP. On such a page MeshMonitor hides the passkey controls and shows a short note. See [HTTP vs HTTPS](/configuration/http-vs-https).
- **A fixed hostname.** A passkey works only on the hostname where you added it. If you add one at `https://mesh.example.com`, your browser will not offer it at `https://192.168.1.50:8080`, at a `.local` name, or at a port-forward URL. Pick one address, and add your passkeys there.
- **A browser or device that supports passkeys.** Current Chrome, Edge, Safari and Firefox do, with a platform authenticator, a password manager or a security key.

Each passkey in your list shows the hostname it works on.

## Add, rename and remove a passkey

1. Sign in with your password.
2. Open the user menu (your username in the header) and choose **Passkeys**.
3. Select **Add a passkey**, name it (for example, "Work laptop"), and select **Continue**.
4. Approve the prompt from your browser or device.

In the same dialog you can **Rename** or **Delete** any passkey. The list shows when each one was added and last used. Add more than one passkey (for example, a laptop and a phone) so losing one device does not lock you out.

## Sign in with a passkey

On the login page, choose **Sign in with a passkey** and approve the prompt. You do not type a username.

Your browser can also offer your passkey in the username field. Click the field and pick the passkey from the autofill list.

A passkey sign-in **skips the two-factor (TOTP) code**. The passkey already proves two things: you hold the device, and you passed its fingerprint, face or PIN check. Password sign-in still asks for the code.

## Reverse proxy and subpath installs

MeshMonitor reads the hostname and scheme from each request unless you set the variables below.

- Set `TRUST_PROXY` so MeshMonitor sees the real scheme (`https`). See [Reverse Proxy](/configuration/reverse-proxy).
- Make the proxy pass the original `Host` header.
- A `BASE_URL` subpath (for example `/meshmonitor`) needs no passkey setting. A passkey binds to the hostname only, not the path.

If you cannot meet those two conditions, set `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS`.

## Settings

Both variables are optional. At startup, MeshMonitor logs a warning if either is unset.

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBAUTHN_RP_ID` | request hostname | The hostname passkeys bind to. Use a bare hostname with no scheme, port or path. MeshMonitor lowercases it. |
| `WEBAUTHN_ORIGINS` | `<scheme>://<host>` of the request | Comma-separated list of full origins allowed to use passkeys. Each needs a scheme, and a port if it is not the default. MeshMonitor trims spaces and trailing slashes. |

Set them when:

- You sit behind a reverse proxy that does not forward the right `Host` or scheme.
- You reach MeshMonitor under more than one hostname. The RP ID is one hostname. Pick a parent domain that covers them all, and list each origin.

```yaml
environment:
  - WEBAUTHN_RP_ID=mesh.example.com
  - WEBAUTHN_ORIGINS=https://mesh.example.com
```

Two names under one parent domain:

```yaml
environment:
  - WEBAUTHN_RP_ID=example.com
  - WEBAUTHN_ORIGINS=https://mesh.example.com,https://mesh-admin.example.com
```

::: warning
Changing the RP ID later makes existing passkeys stop working, because they bind to the old hostname. Add new passkeys after the change.
:::

## Passkey-only accounts

You can turn off password sign-in for your account. Then only your passkeys, or a recovery code, sign you in.

**Turn it off:**

1. Add at least one passkey (two is safer).
2. Open the user menu, choose **Passkeys**, and select **Turn off password sign-in**.
3. Select **Continue with a passkey** and approve the browser prompt. This proves the passkey works and that you are at the keyboard.
4. MeshMonitor shows **10 one-time recovery codes**. Copy or download them, store them away from this device, and tick **I saved these codes**. MeshMonitor shows them once and cannot show them again.

If you are the only admin, MeshMonitor warns you first and asks you to type `DISABLE` to confirm. If you lose your passkeys and your codes, nobody can sign in to manage MeshMonitor.

**While it is off:**

- Password sign-in fails with the same "Invalid username or password" error as a wrong password.
- You cannot change your password.
- You cannot delete your last passkey. Turn password sign-in back on first.

**Turn it back on:** open **Passkeys** and select **Turn password sign-in back on**. This discards your recovery codes.

## Lost your passkey

### Use a recovery code

1. On the login form, select **Lost your passkey? Use a recovery code**.
2. Enter your username and one recovery code.
3. MeshMonitor signs you in, turns password sign-in back on, and asks you to **Choose a new password**.

Each code works once. When you use one, MeshMonitor discards the rest. Add a new passkey afterwards, and turn password sign-in off again if you want a new set of codes. Accounts with a locked password (set by an admin) skip the new-password step.

### Ask an admin

An admin can set a new password for you in the **Users** tab. That turns password sign-in back on, and you can sign in with the new password.

## Admin tasks

In **Users**, each row shows the user's passkey count. Select **Passkeys** to see a user's passkeys and **Revoke** one. Use this when a device is lost or stolen.

Revoking has one limit. You cannot revoke the last passkey of a user whose password sign-in is off, because that would lock them out. Set a new password for the user first, which turns password sign-in back on, then revoke.

Passkey events (add, rename, delete, admin revoke, password sign-in on or off, recovery code use, failed passkey sign-ins) go to the audit log.

## Troubleshooting

**The browser offers no passkey, or the button is missing.**
Check that the page uses HTTPS or `http://localhost`. Then check the address bar: a passkey works only on the hostname where you added it. Open **Passkeys** to see that hostname.

**"The passkey request expired."**
A passkey request lasts 5 minutes. Try again.

**"Passkey sign-in failed."**
The passkey is unknown, the account is inactive or not local, or local login is off (`DISABLE_LOCAL_AUTH`). Sign in with your password, or a recovery code.

**"This passkey is already added."**
Your device already holds a passkey for this account. Pick a different authenticator.

**Passkeys fail behind a proxy.**
Set `TRUST_PROXY`, forward the `Host` header, or set `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS` to match the address in your browser.

**I changed hostnames and my passkeys vanished.**
They still exist but bind to the old hostname. Use the old address, or add new passkeys on the new one.
