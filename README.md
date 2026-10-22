# 🦊 Nariya

**Nariya** is a powerful browser extension for web developers and security researchers. It combines the ease-of-use of tools like **Requestly** for request management with the deep inspection capabilities of **Burp Suite** via the Chrome Debugger Protocol (CDP).

Named after the clever fox, Nariya gives you the cunning tools needed to intercept, modify, and replay network traffic with precision.

---

## 🚀 Key Features

### 🛠️ Request Management
- **Smart Redirection:** Redirect URLs using simple wildcards (`*`) or powerful regex patterns.
- **Header Modification:** Add, remove, or modify request and response headers globally or for specific domains.
- **CORS-Free Development:** Pages on your dev sites (default `localhost`, `127.0.0.1`; configurable in Settings) can call any API cross-origin in a normal Chrome profile — preflights, cookies and `Authorization` included. `Access-Control-Allow-Origin` is set to the page's exact origin, and other sites (Gmail, Google Chat, ...) are left untouched. Redirect rules that send a site's calls to another origin (e.g. staging → `http://localhost:8081`) need no extra setup: that site gets the bypass automatically, including custom headers on credentialed requests. The **CORS Status** panel in Settings shows active origins, automatic sites, learned headers and recent preflights.
- **Send via Nariya (Proxy rules):** If an API answers the preflight `OPTIONS` with 401/404/405, no header can fix it. A Proxy rule makes Nariya's background worker perform matching fetch/XHR calls instead of the page, so there is no CORS check and no preflight. Responses stream back as they arrive (streaming APIs and SSE work), with XHR progress/upload events and abort. The API sees your page's `Origin`, even when several dev servers call it at once. Only for pages on the CORS bypass sites. The CORS Status panel offers "Create proxy rule" next to any rejected preflight.

### 🔍 Deep Network Inspection
- **CDP-Powered Interception:** Uses the Chrome Debugger API to pause requests and responses, allowing for manual inspection and modification before they reach their destination.
- **Repeater:** Replay any intercepted request with custom modifications to headers, body, or URL. Perfect for API testing.
- **Request Recorder → Postman:** Record a tab's API calls (method, URL, headers, body, status and response body), then export a **Postman v2.1 collection** with a `{{baseUrl}}` variable per host, tokens moved into `{{authToken}}`/`{{apiKey}}` variables, one request per endpoint, example responses and generated tests (status code, content type, response fields, response time). HAR export too.

### 💾 Rule Storage
- **Browser storage** (default), or keep a live copy in **`nariya_rules.json`** in a **folder on disk** (great for version control) or in **Google Drive** (sync between machines). Every change is written automatically; connecting a folder or Drive that already has rules offers to import them. Settings shows the last sync and lets you re-grant folder access if Chrome asks again.
- **Nariya Cloud:** optional backend for sign-in, rule sync, sharing and large cloud-stored mock bodies.

### 🎭 Content Manipulation
- **Mocking:** Replace server responses with custom JSON, HTML, or plain text, with optional delay, custom headers and cloud-stored bodies. Works for `fetch` and `XMLHttpRequest` (including `responseType`, `getResponseHeader` and the usual events).
- **Script Injection:** Inject custom JavaScript into pages to automate tasks or debug client-side logic in a secure sandbox.
- **Network Delays:** Simulate slow network conditions by adding artificial latency to specific requests.

---

## 🛠️ Installation

1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/sithmal-pathirana/Nariya.git
    ```
2.  **Open Chrome Extensions:** Navigate to `chrome://extensions` in your browser.
3.  **Enable Developer Mode:** Toggle the "Developer mode" switch in the top-right corner.
4.  **Load Unpacked:** Click the **"Load unpacked"** button and select the `Nariya` project directory.
5.  **Pin the Extension:** Find the Nariya "Fox" icon in your extension bar and pin it for quick access.

### Google sign-in (optional, for Nariya Cloud)
Google sign-in uses `chrome.identity`, which needs a real OAuth client ID:
1. In Google Cloud Console create an **OAuth client ID** of type **Chrome extension**, using your extension ID from `chrome://extensions`.
2. Put it in `manifest.json` under `oauth2.client_id` and reload the extension.
3. Set the backend address under **Settings → Storage Provider → Nariya Cloud backend URL** (default `http://localhost:8080`).

Until then the Sign In button stays disabled; everything else works locally.

### Packaging for the Chrome Web Store
```bash
node tools/package.mjs     # → dist/nariya-<version>.zip (runtime files only)
```
CI builds the same zip on every push and attaches it to the run as the `nariya-extension` artifact.

---

## 📂 Project Structure

-   `background/`: Service worker, message router, interceptor registration and handlers (rules, debugger, repeater, page calls such as proxy fetches).
-   `content/`: `bridge.js` (isolated world, all pages) and `interceptor.js` (page world, registered only while mock/delay/proxy rules or the recorder need it). They talk over a private `MessageChannel`.
-   `core/`: The logic engine:
    -   `rules-engine.js`: Compiles user rules into `declarativeNetRequest` rules.
    -   `cors-bypass.js`: Scoped CORS bypass (per-origin session rules, learned headers, preflight log).
    -   `recorder.js` / `postman.js`: Request recorder and Postman/HAR export.
    -   `url-match.js`: URL pattern matching shared by rules and the dashboard's URL tester.
    -   `storage/mirror.js`: Writes `nariya_rules.json` to a folder or Google Drive.
    -   `debugger-proxy.js`: Wrapper for the Chrome Debugger Protocol.
    -   `repeater.js`: Request history and replay.
-   `ui/`: Dashboard, popup and shared UI helpers.
-   `sandbox/`: Secure environment for executing custom scripts.
-   `tests/`: Unit tests and Playwright end-to-end tests that load the extension into Chromium.
-   `tools/package.mjs`: Builds the Web Store zip.
-   `backend/`, `infra/`: Optional Nariya Cloud backend and deployment.

---

## 📖 Usage

### Using the Dashboard
1. Click the Nariya icon and select **"Open Dashboard"**.
2. Create new **Rules** (Redirect, Header, Mock, etc.) using the "Add Rule" button.
3. Monitor active interceptions in the **Traffic** tab.
4. Send any request to the **Repeater** to tweak and replay.

### Using the Popup
- Toggle the entire extension **On/Off**.
- Access quick links to the Dashboard or Documentation.
- View current tab status.

---

## 🧪 Tests

```bash
cd tests
npm install
npx playwright install chromium   # full Chromium; the headless shell cannot load extensions
npm test                          # or: npm run test:unit / npm run test:e2e
npm run lint                      # ESLint over the extension sources
npm run package                   # build dist/nariya-<version>.zip
```

The end-to-end tests start local servers, load the unpacked extension (and the packaged build) into Chromium with no special flags, and check CORS, mocks (including cloud mocks), delays, proxy streaming, the recorder, rule-file sync and the dashboard. They run on every push via GitHub Actions (`.github/workflows/test.yml`).

---

## 🤝 Contributing

Contributions are welcome! If you have ideas for new features or find bugs, please open an issue or submit a pull request.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📝 License

Distributed under the MIT License. See `LICENSE` for more information.

---

*Built with ❤️ for developers by [Sithmal Pathirana](https://github.com/sithmal-pathirana).*
