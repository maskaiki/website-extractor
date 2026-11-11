# Website Extractor

**Website Extractor** is a modern, full-stack web application that extracts every element from any domain in a single click. Built with **Playwright Stealth**, **Server-Sent Events (SSE)**, and **Chrome DevTools Protocol (CDP)** inspection via `morluto/rea`, it converts live websites—including Framer, Webflow, WordPress, and custom stacks—into clean, local, ready-to-use `.zip` archives.

---

## Key Features

- **One-Click Full Extraction** — Enter any domain name to automatically render, scroll, and capture complete HTML, stylesheets, scripts, and high-resolution images.
- **Smart Anti-Timeout Engine** — Gracefully handles heavy e-commerce and tracker-dense websites without hanging on endless background network requests.
- **No-Code Badge & Watermark Cleaner** — Automatically strips platform watermarks and editor badges from Framer, Webflow, and similar site builders.
- **Real-Time Streaming & Interactive Folder Inspector** — Watch files populate in real-time via SSE and inspect extracted HTML, CSS, JS, JSON, and images directly inside the browser before downloading.
- **Design System Token Extraction** — Automatically detects dominant color palettes, computed typography, and semantic layout sections, with one-click export to Tailwind CSS configuration.
- **Deep CDP Architecture Blueprint (`morluto/rea`)** — Connects over local Chrome DevTools Protocol (`port 9222`) to generate passive page inspection and bundle analysis reports.
- **Editorial 3D Interface** — Crafted with a tactile Cobalt & Crisp Paper aesthetic, smooth inertia scrolling (Lenis), 3D perspective depth, and an interactive 2D Fluffy Cat data courier.

---

## Tech Stack

- **Backend:** Node.js, Express, Playwright (Chromium Stealth), Cheerio, Archiver
- **Reverse Engineering Bridge:** `morluto/rea` (`rea-agents` CLI via CDP Port `9222`)
- **Frontend:** Vanilla HTML5/CSS3, GSAP, Lenis Smooth Scroll, Vanilla-Tilt 3D, Server-Sent Events (SSE)

---

## Getting Started

### 1. Prerequisites

Ensure you have **Node.js (v22.19+ or v24+)** installed on your machine.

*(Optional)* To enable deep CDP & bundle reverse engineering via `morluto/rea`, install `rea-agents` globally:

```bash
npm install -g rea-agents@latest
```

### 2. Installation & Run

```bash
# 1. Clone the repository
git clone https://github.com/maskaiki/website-extractor.git
cd website-extractor

# 2. Install dependencies
npm install

# 3. Install Chromium for Playwright
npx playwright install chromium

# 4. Start the server
npm start
```

Open your browser at `http://localhost:3000`.

---

## Project Structure

```text
├── server.js          # Express backend, Playwright Stealth + REA CDP & SSE stream
├── public/
│   └── index.html     # Editorial 3D UI, Fluffy Cat Courier & Interactive Inspector
├── exports/           # Generated extraction folders & .zip archives (gitignored)
├── package.json
└── LICENSE
```

## Output Structure (per extraction job)

```text
exports/<hostname>_<timestamp>/
├── index.html                               # Rewritten & watermark-cleaned HTML
├── preview.png                              # Viewport screenshot
├── metadata.json                            # Job summary, platform, stats & tokens
├── assets/
│   ├── css/style_N.css                      # Stylesheets (with local url() rewrites)
│   ├── js/script_N.js                       # Downloaded scripts
│   └── images/img_N.*                       # Downloaded images & CSS assets
└── rea-blueprint/
    ├── design-tokens-and-elements.json      # Colors, fonts & semantic sections
    ├── rea-cdp-evidence.json                # Passive CDP page inspection (morluto/rea)
    └── rea-bundle-analysis.json             # Bundle & source-map analysis (morluto/rea)
```

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/extract-stream` | `GET` (SSE) | Stream extraction progress (`domain`, `removeWatermarks`, `runReaAnalysis`, `viewport`) |
| `/api/files/:jobId` | `GET` | Return recursive folder tree for a completed job |
| `/api/file-content` | `GET` | Preview code or image content (`jobId`, `filePath`) |
| `/api/history` | `GET` | List up to 12 recent extractions |
| `/downloads/<jobId>/...` | `GET` | Serve static cloned pages, screenshots, and `.zip` archives |

---

## License

[MIT License](LICENSE)
