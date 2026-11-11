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

#2. Installation
Clone this repository and install the dependencies:
Bash
git clone https://github.com/YOUR_USERNAME/website-extractor.git
cd website-extractor
npm install
npx playwright install chromium
3. Run the Server
Bash
node server.js
Open http://localhost:3000 in your browser.


