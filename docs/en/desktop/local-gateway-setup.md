---
title: Configure gateway access in a local browser
nav_title: Gateway access
description: Configure and test a remote gateway locally and understand the credential and privacy boundaries.
order: 12
---

# Configure gateway access in a local browser

The Bun source server provides a local control page at `/_local/gateway`, using the same native tunnel runner as the desktop app. This is intended for local experiments without an Electron window.

## Start and connect

1. Set `CLAUDE_CONFIG_DIR` to an isolated directory and set `CC_HAHA_LOCAL_ACCESS_TOKEN` to a random value of at least 32 characters. This local access credential is separate from your gateway account password.
2. Bind only to `127.0.0.1`. A local experiment launcher must set `CC_HAHA_GATEWAY_LOCAL_ONLY=1`, which authenticates the entire H5/API surface and permits only literal loopback gateway targets.
3. Provide the bundled native tunnel client. Developers can set its absolute path using `CC_HAHA_GATEWAY_CLIENT_PATH`; the page deliberately does not accept executable paths.
4. Open `http://127.0.0.1:<port>/_local/gateway` and sign in with the local access credential.
5. Sign in to the gateway with an administrator-provisioned account and create an access key. Enter the gateway device address including its port, such as `http://127.0.0.1:8081`, and the key in the local control page. Save, test, then start the connection. The device port can differ from the phone login page port.
6. Select the online device on the gateway and open the cc-haha H5 interface. A successful connection test proves connectivity and authentication, not the complete H5 workflow.

## Credentials and control boundaries

- The local login cookie contains a random server session, not the access token or tunnel key. It is HttpOnly, SameSite=Strict, restricted to `/_local/gateway`, and expires after 12 hours. Logout or a server restart invalidates it.
- Without Electron's safeStorage bridge, the Bun server keeps the tunnel key in memory only. Persisted settings contain the address and non-sensitive metadata. Paste the key again after restarting the server.
- The control page requires a real loopback source, an exact Host, and same-origin requests. It rejects forwarding headers and gateway-forwarded requests; mutations also require CSRF validation.
- Remote H5 sessions cannot configure the local gateway or access the local control credential.
- This loopback HTTP experiment is not a public deployment configuration.

## Build the client

Client sources are included in `desktop/gateway-client`; the gateway server repository is not required. Run `bun run build:gateway-tunnel` from `desktop` to build a native client for the current system. The script automatically installs pinned Python dependencies into an isolated environment. Developers need Python to build, but desktop release users do not need to install it. Build Windows and Linux artifacts on their respective operating systems; cross-compilation is not supported.

## Privacy

Gateway connectivity is not business-content end-to-end encryption. Plain HTTP experiments do not protect content from network eavesdroppers. Public access should use correctly verified HTTPS. Even with HTTPS, a forwarding gateway can still read decrypted business content. A successful connection is not an end-to-end privacy acceptance result, and traffic unrecognizability is not guaranteed.
