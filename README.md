# Amazon Order Exporter

A Chrome extension that exports your Amazon order history as a CSV file for budgeting.

Built for [icanbudget](https://icanbudget.com) customers who want to import Amazon purchases for AI-powered transaction matching.

## What it does

- Scrapes order data from your Amazon order pages (list and detail views)
- Collects order ID, date, total, recipient, item names, prices, and ASINs
- Optionally fetches product categories from Amazon product pages
- Exports everything as a clean CSV file
- **All data stays in your browser** — no external servers, no tracking, no analytics

## Supported Amazon regions

Amazon US (.com) and Canada (.ca).

## Install from Chrome Web Store

Coming soon.

## Install from source (developer mode)

1. Download or clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the `extension/` folder
5. Navigate to [Your Amazon Orders](https://www.amazon.com/your-orders/orders)
6. Click the extension icon and hit **Collect Orders**
7. Navigate through each page of orders and collect from each
8. Click **Download CSV** when done

## How it works

1. A content script is injected on Amazon pages
2. When you click "Collect Orders", it scrapes the current page's DOM for order data
3. Data is stored locally in `chrome.storage.local`
4. If "Include categories" is enabled, it fetches each product page to read the breadcrumb category
5. CSV is generated client-side and downloaded as a file

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Access the current Amazon tab when you click the extension |
| `storage` | Save collected orders between popup sessions |
| `host_permissions` (Amazon domains) | Read order data from Amazon pages |

The extension makes **zero external network requests**. The only network activity is fetching Amazon product pages (same domain) for category data, and only when you opt in.

## Privacy

- No data leaves your browser
- No analytics or tracking
- No external servers contacted
- All order data stored locally in Chrome, cleared with the "Clear All" button
- Source code is fully open for inspection

## A note on the install warning

When you install this extension, Chrome will show **"Read and change your data on amazon.com"** (and the other supported Amazon domains). This is Chrome's standard wording for any extension that accesses a website — there is no "read-only" permission in Chrome's permission system.

**This extension only reads.** It does not modify any Amazon pages, submit forms, place orders, or change your account in any way. You can verify this yourself — the full source code is here, and there is no `document.write`, no form submissions, and no POST requests anywhere in the codebase.

## Security choices

This extension is designed to be auditable by anyone. Here are the specific choices we made:

- **No innerHTML with user data.** All Amazon-sourced content (item names, prices, categories) is rendered using `textContent` or escaped with dedicated `escapeHTML`/`escapeAttr` helpers. This eliminates XSS as a category of risk.
- **No eval, no dynamic code.** Zero use of `eval()`, `new Function()`, or string-based `setTimeout`. No dynamically generated code of any kind.
- **No external requests.** The only `fetch` call is a relative-path request to Amazon product pages on the same domain (for category breadcrumbs), and it uses `credentials: 'omit'` so it doesn't send cookies.
- **Input validation.** ASINs are validated against a strict `[A-Z0-9]{10}` regex before being used in any URL.
- **Minimal permissions.** No access to browsing history, cookies, downloads, or any other sensitive Chrome API.
- **No background process.** No service worker, no persistent background page. The extension only runs when you click it.

If you find a security concern, please [open an issue](https://github.com/micah63/amazon-order-exporter/issues).

## License

MIT
