# 🦊 Nariya

**Nariya** is a powerful browser extension for web developers and security researchers. It combines the ease-of-use of tools like **Requestly** for request management with the deep inspection capabilities of **Burp Suite** via the Chrome Debugger Protocol (CDP).

Named after the clever fox, Nariya gives you the cunning tools needed to intercept, modify, and replay network traffic with precision.

---

## 🚀 Key Features

### 🛠️ Request Management
- **Smart Redirection:** Redirect URLs using simple wildcards (`*`) or powerful regex patterns.
- **Header Modification:** Add, remove, or modify request and response headers globally or for specific domains.
- **CORS-Free Development:** Automatically injects CORS headers (`Access-Control-Allow-Origin: *`) to simplify integration between different local services.

### 🔍 Deep Network Inspection
- **CDP-Powered Interception:** Uses the Chrome Debugger API to pause requests and responses, allowing for manual inspection and modification before they reach their destination.
- **Repeater:** Replay any intercepted request with custom modifications to headers, body, or URL. Perfect for API testing.

### 🎭 Content Manipulation
- **Mocking:** Replace server responses with custom JSON, HTML, or plain text.
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

---

## 📂 Project Structure

-   `background/`: Contains the global service worker that manages the extension's lifecycle and core events.
-   `content/`: Scripts that run in the context of the web page to intercept Fetch/XHR and bridge communication.
-   `lib/`: The core logic engine:
    -   `rules-engine.js`: Compiles user rules into high-performance `declarativeNetRequest` rules.
    -   `debugger-proxy.js`: High-level wrapper for the Chrome Debugger Protocol.
    -   `repeater.js`: Manages request history and replaying logic.
-   `ui/`: The user interface components:
    -   `dashboard/`: The main management console for rules and history.
    -   `popup/`: Quick actions and status toggle.
    -   `sandbox/`: Secure environment for executing custom scripts.
-   `icons/`: Branding assets featuring the Nariya Fox.

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
