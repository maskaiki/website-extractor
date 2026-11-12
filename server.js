'use strict';

const express = require('express');
const { chromium } = require('playwright');
const cheerio = require('cheerio');
const archiver = require('archiver');
const { execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const cors = require('cors');
const {
  sanitizeAssetFilename,
  attachNetworkCollector,
  recoverSourceMaps,
  extractMotionFromCssTexts,
  evaluateDeepDomData,
  buildColorsAndFontsCatalog,
  writeTsxAndMotionWorkspace,
  selectCrawlableRoutes,
  simulateUiInteractions,
  writeViteReactProject,
} = require('./lib/deep-extractor');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const EXPORTS_ROOT = path.join(__dirname, 'exports');
const TRASH_ROOT = path.join(EXPORTS_ROOT, '.trash');
if (!fs.existsSync(EXPORTS_ROOT)) fs.mkdirSync(EXPORTS_ROOT, { recursive: true });
app.use('/downloads', express.static(EXPORTS_ROOT, { dotfiles: 'ignore' }));

const DEFAULT_CDP_PORT = 9222;

function getAvailableCdpPort(startPort = DEFAULT_CDP_PORT) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      if (port > startPort + 20) return resolve(startPort);
      const srv = net.createServer();
      srv.once('error', () => tryPort(port + 1));
      srv.once('listening', () => srv.close(() => resolve(port)));
      srv.listen(port, '127.0.0.1');
    };
    tryPort(startPort);
  });
}

// Helper: Jalankan CLI morluto/rea
function runReaCommand(args) {
  return new Promise((resolve) => {
    execFile('rea', args, { env: process.env, maxBuffer: 1024 * 1024 * 50, shell: true }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          status: 'warning',
          note: 'CLI rea gagal dijalankan atau belum terinstall (npm i -g rea-agents)',
          error: error.message,
          stderr,
        });
      } else {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ status: 'warning', rawOutput: stdout, stderr });
        }
      }
    });
  });
}

function extractReaTargets(targetsResponse) {
  if (!targetsResponse || typeof targetsResponse !== 'object') return [];
  if (Array.isArray(targetsResponse.normalized_result?.targets)) {
    return targetsResponse.normalized_result.targets;
  }
  if (Array.isArray(targetsResponse.targets)) {
    return targetsResponse.targets;
  }
  return [];
}

function sanitizeTargetId(rawId) {
  if (typeof rawId !== 'string') return null;
  const trimmed = rawId.trim();
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

// Helper: Rewrite url(...) di dalam CSS ke path lokal ../images/ atau ../fonts/
const FONT_EXTS = new Set(['.woff2', '.woff', '.ttf', '.otf', '.eot']);

async function rewriteCssUrls(cssContent, cssUrl, { imgDir, fontsDir }, counterRef, urlToLocalMap) {
  const urlPattern = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  const tasks = [];
  const replacements = new Map();

  for (const match of cssContent.matchAll(urlPattern)) {
    const original = match[1].trim();
    if (!original || original.startsWith('data:') || original.startsWith('#')) continue;
    if (replacements.has(original)) continue;

    try {
      const absUrl = new URL(original, cssUrl).href;
      let ext = path.extname(new URL(absUrl).pathname).split('?')[0] || '.bin';
      if (!/^\.[a-z0-9]{1,6}$/i.test(ext)) ext = '.bin';
      const isFont = FONT_EXTS.has(ext.toLowerCase());
      const fileName = isFont ? `css_font_${++counterRef.val}${ext}` : `css_asset_${++counterRef.val}${ext}`;
      const targetDir = isFont ? fontsDir : imgDir;
      fs.mkdirSync(targetDir, { recursive: true });
      const destPath = path.join(targetDir, fileName);
      replacements.set(original, null);
      tasks.push(
        downloadAsset(absUrl, destPath).then((res) => {
          if (res.ok) {
            replacements.set(original, isFont ? `../fonts/${fileName}` : `../images/${fileName}`);
            if (urlToLocalMap) {
              urlToLocalMap.set(absUrl, isFont ? `assets/fonts/${fileName}` : `assets/images/${fileName}`);
            }
          }
        })
      );
    } catch {}
  }

  await Promise.allSettled(tasks);

  return cssContent.replace(urlPattern, (match, rawUrl) => {
    const key = rawUrl.trim();
    const mapped = replacements.get(key);
    return mapped ? `url('${mapped}')` : match;
  });
}

// Helper: Deteksi Platform Website
function detectPlatform(html) {
  if (html.includes('framer.com') || html.includes('data-framer-appear-id')) return 'Framer';
  if (html.includes('webflow.com') || html.includes('data-wf-site')) return 'Webflow';
  if (html.includes('wix.com') || html.includes('wix-bolt')) return 'Wix';
  if (html.includes('squarespace.com')) return 'Squarespace';
  if (html.includes('wp-content') || html.includes('elementor')) return 'WordPress';
  if (html.includes('__NEXT_DATA__') || html.includes('_next/static')) return 'Next.js';
  if (html.includes('__NUXT__') || html.includes('_nuxt/')) return 'Nuxt.js';
  if (html.includes('cdn.shopify.com')) return 'Shopify';
  return 'Custom Web Stack';
}

// Helper: Download Aset dengan Timeout Aman
async function downloadAsset(url, destPath) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });
    clearTimeout(timeout);
    if (!res.ok) return { ok: false, size: 0 };
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    return { ok: true, size: buffer.length };
  } catch {
    clearTimeout(timeout);
    return { ok: false, size: 0 };
  }
}

// Helper: Baca Struktur Folder secara Rekursif untuk Interactive Folder Explorer
function buildFolderTree(dirPath, relativeBase = '') {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const result = [];

  for (const entry of entries) {
    const relPath = path.posix.join(relativeBase, entry.name);
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        path: relPath,
        type: 'folder',
        children: buildFolderTree(fullPath, relPath),
      });
    } else {
      const stat = fs.statSync(fullPath);
      result.push({
        name: entry.name,
        path: relPath,
        type: 'file',
        size: stat.size,
        ext: path.extname(entry.name).toLowerCase(),
      });
    }
  }
  return result.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
}

// ============================================================================
// 1. ENDPOINT REAL-TIME SSE STREAMING (/api/extract-stream)
// ============================================================================
app.get('/api/extract-stream', async (req, res) => {
  let {
    domain,
    removeWatermarks = 'true',
    runReaAnalysis = 'true',
    crawlSubPages = 'true',
    simulateUi = 'true',
    viewport = 'desktop',
  } = req.query;

  removeWatermarks = removeWatermarks === 'true';
  runReaAnalysis = runReaAnalysis === 'true';
  crawlSubPages = crawlSubPages === 'true';
  simulateUi = simulateUi === 'true';

  // Setup Header SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let clientClosed = false;
  let browser;
  req.on('close', () => {
    clientClosed = true;
    if (browser) {
      browser.close().catch(() => {});
      browser = null;
    }
  });

  const sendEvent = (type, payload) => {
    if (clientClosed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ type, timestamp: new Date().toLocaleTimeString('id-ID'), ...payload })}\n\n`);
  };

  if (!domain) {
    sendEvent('error', { message: 'Masukkan nama domain atau URL terlebih dahulu!' });
    return res.end();
  }

  if (!domain.startsWith('http://') && !domain.startsWith('https://')) {
    domain = `https://${domain}`;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(domain);
  } catch {
    sendEvent('error', { message: 'Format domain atau URL tidak valid!' });
    return res.end();
  }

  const jobId = `${parsedUrl.hostname.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}`;
  const exportDir = path.join(EXPORTS_ROOT, jobId);
  const assetsDir = path.join(exportDir, 'assets');
  const cssDir = path.join(assetsDir, 'css');
  const jsDir = path.join(assetsDir, 'js');
  const imgDir = path.join(assetsDir, 'images');
  const fontsDir = path.join(assetsDir, 'fonts');
  const reaDir = path.join(exportDir, 'rea-blueprint');

  [exportDir, assetsDir, cssDir, jsDir, imgDir, reaDir].forEach((dir) =>
    fs.mkdirSync(dir, { recursive: true })
  );

  const viewports = {
    desktop: { width: 1440, height: 900 },
    tablet: { width: 834, height: 1112 },
    mobile: { width: 390, height: 844 },
  };
  const selectedViewport = viewports[viewport] || viewports.desktop;

  try {
    const cdpPort = await getAvailableCdpPort(DEFAULT_CDP_PORT);
    const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;

    sendEvent('log', {
      tag: 'BOOT',
      jobId,
      progress: 8,
      catSpeech: `Meow! Menyiapkan Stealth Browser & port CDP ${cdpPort}...`,
      message: `Membuka Chromium Stealth (${selectedViewport.width}x${selectedViewport.height}) untuk ${parsedUrl.hostname} (CDP ${cdpPort})`,
    });

    browser = await chromium.launch({
      headless: true,
      args: [
        `--remote-debugging-port=${cdpPort}`,
        `--remote-debugging-address=127.0.0.1`,
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
    });
    if (clientClosed) return;

    const context = await browser.newContext({
      viewport: selectedViewport,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();
    const networkCollector = attachNetworkCollector(page);

    // Anti-Bot Webdriver Stealth
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    sendEvent('log', {
      tag: 'NAVIGATE',
      progress: 18,
      catSpeech: `Lari ke ${parsedUrl.hostname}... mengendus struktur DOM! 🐾`,
      message: `Menghubungi ${parsedUrl.href} (Smart Anti-Timeout + Network Interceptor aktif)...`,
    });

    // SOLUSI ANTI-TIMEOUT (Adidas.com, E-commerce, dll):
    await page.goto(parsedUrl.href, { waitUntil: 'domcontentloaded', timeout: 45000 });

    const idleReached = await page
      .waitForLoadState('networkidle', { timeout: 7000 })
      .then(() => true)
      .catch(() => false);

    if (!idleReached) {
      sendEvent('log', {
        tag: 'BYPASS',
        progress: 26,
        catSpeech: 'Ada tracker berat! Kucing lompat melewati tracker~ 🐱⚡',
        message: 'Background tracker terus berjalan; Smart Bypass aktif, melanjutkan ekstraksi DOM!',
      });
    }

    // Auto-scroll untuk Lazy-Load
    sendEvent('log', {
      tag: 'SCROLL',
      progress: 34,
      catSpeech: 'Menggulung halaman dari atas ke bawah biar semua gambar & animasi keluar...',
      message: 'Menjalankan Auto-Scroll untuk merender gambar lazy-load, Lottie, & animasi scroll...',
    });

    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 450;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight || totalHeight > 14000) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 90);
      });
    });
    await page.waitForTimeout(1000);

    // Screenshot Preview sebelum simulasi dropdown/tab agar thumbnail landing bersih
    const ssPath = path.join(exportDir, 'preview.png');
    await page.screenshot({ path: ssPath, fullPage: false });
    sendEvent('catCarry', {
      fileType: 'IMG',
      fileName: 'preview.png',
      folderPath: 'preview.png',
      size: fs.statSync(ssPath).size,
      catSpeech: 'Mengamankan thumbnail landing preview.png 📸',
    });

    // Simulasi Interaksi UI (auto-hover & click tab/accordion/menu aman)
    let interactionReport = { hoveredCount: 0, clickedCount: 0, newlyAddedNodes: 0, actions: [] };
    if (simulateUi) {
      sendEvent('log', {
        tag: 'INTERACT',
        progress: 40,
        catSpeech: 'Menyimulasikan hover menu, tab & dropdown untuk mengungkap DOM tersembunyi...',
        message: 'Menjalankan Simulasi Interaksi UI (hover nav, tab, accordion, dropdown)...',
      });
      interactionReport = await simulateUiInteractions(page);
      const interactPath = path.join(reaDir, 'interactive-states.json');
      fs.writeFileSync(interactPath, JSON.stringify(interactionReport, null, 2));
      if (interactionReport.actions.length > 0) {
        sendEvent('catCarry', {
          fileType: 'JSON',
          fileName: 'interactive-states.json',
          folderPath: 'rea-blueprint/interactive-states.json',
          size: fs.statSync(interactPath).size,
          catSpeech: `Terdeteksi ${interactionReport.clickedCount} klik & ${interactionReport.hoveredCount} hover interaktif!`,
        });
      }
    }

    // Ekstrak Design Tokens, Motion Primitives, SVGs & Semantic Sections
    sendEvent('log', {
      tag: 'TOKENS',
      progress: 46,
      catSpeech: 'Mengumpulkan palet warna, font, @keyframes animasi, dan section DOM!',
      message: 'Mengekstrak Computed Styles, @keyframes, Curves, SVGs, & Semantic Sections...',
    });

    const extractedElements = await evaluateDeepDomData(page);

    const tokensPath = path.join(reaDir, 'design-tokens-and-elements.json');
    fs.writeFileSync(tokensPath, JSON.stringify(extractedElements, null, 2));

    if ((extractedElements.internalRoutes || []).length > 0) {
      fs.writeFileSync(
        path.join(reaDir, 'routes-inventory.json'),
        JSON.stringify({ domain: parsedUrl.hostname, routes: extractedElements.internalRoutes }, null, 2)
      );
    }

    sendEvent('catCarry', {
      fileType: 'JSON',
      fileName: 'design-tokens-and-elements.json',
      folderPath: 'rea-blueprint/design-tokens-and-elements.json',
      size: fs.statSync(tokensPath).size,
      catSpeech: 'Membawa design-tokens.json ke brankas folder!',
    });

    // Jalankan Reverse Engineering morluto/rea via CDP
    let reaReport = { status: 'skipped' };
    let reaStatus = 'skipped';
    let targetId = null;

    if (clientClosed) return;

    if (runReaAnalysis) {
      sendEvent('log', {
        tag: 'REA-CDP',
        progress: 52,
        catSpeech: `Memanggil mesin morluto/rea untuk bedah CDP port ${cdpPort}...`,
        message: 'Menjalankan `rea list-browser-targets` & `rea inspect-web-page`...',
      });

      const targets = await runReaCommand([
        'list-browser-targets',
        cdpEndpoint,
        '--format',
        'json',
      ]);
      if (clientClosed) return;

      const targetList = extractReaTargets(targets);
      if (targetList.length > 0) {
        const matched =
          targetList.find((t) => t.url && t.url.includes(parsedUrl.hostname)) || targetList[0];
        targetId = sanitizeTargetId(matched.target_id || matched.id || matched.targetId);
      }

      if (targetId) {
        const pageInspection = await runReaCommand([
          'inspect-web-page',
          cdpEndpoint,
          targetId,
          '--include-accessibility-text',
          '--include-console-text',
          '--include-json-body-shapes',
          '--include-storage-keys',
          '--format',
          'json',
        ]);
        if (clientClosed) return;

        const bundleAnalysis = await runReaCommand([
          'analyze-web-bundle',
          cdpEndpoint,
          targetId,
          '--fetch-source-maps',
          '--format',
          'json',
        ]);
        if (clientClosed) return;

        reaReport = { targets, pageInspection, bundleAnalysis };
        const hasInspectOk = pageInspection && !pageInspection.error && pageInspection.status !== 'warning';
        const hasBundleOk = bundleAnalysis && !bundleAnalysis.error && bundleAnalysis.status !== 'warning';
        reaStatus = hasInspectOk || hasBundleOk ? 'verified' : 'warning';

        const reaFilePath = path.join(reaDir, 'rea-cdp-evidence.json');
        fs.writeFileSync(reaFilePath, JSON.stringify({ targets, pageInspection }, null, 2));

        sendEvent('catCarry', {
          fileType: 'REA',
          fileName: 'rea-cdp-evidence.json',
          folderPath: 'rea-blueprint/rea-cdp-evidence.json',
          size: fs.statSync(reaFilePath).size,
          progress: 56,
          catSpeech: 'Berhasil mengangkut bukti arsitektur REA CDP! 🧠🐾',
        });

        const bundleReportPath = path.join(reaDir, 'rea-bundle-analysis.json');
        fs.writeFileSync(bundleReportPath, JSON.stringify(bundleAnalysis, null, 2));

        sendEvent('catCarry', {
          fileType: 'REA',
          fileName: 'rea-bundle-analysis.json',
          folderPath: 'rea-blueprint/rea-bundle-analysis.json',
          size: fs.statSync(bundleReportPath).size,
          progress: 60,
          catSpeech: 'Selesai membedah JS Bundle & Source Maps dengan REA! 🧶',
        });
      } else {
        reaStatus = 'warning';
        reaReport = { status: 'warning', reason: 'Target CDP tidak ditemukan', targets };
        const reaFilePath = path.join(reaDir, 'rea-cdp-evidence.json');
        fs.writeFileSync(reaFilePath, JSON.stringify(reaReport, null, 2));
        sendEvent('log', {
          tag: 'REA-CDP',
          progress: 58,
          catSpeech: 'Target CDP belum merespons, lanjut ekstrak aset web! 🐱',
          message: 'Target CDP tidak ditemukan pada list-browser-targets; bukti partial disimpan.',
        });
      }
    }

    // Ambil HTML halaman utama terlebih dahulu sebelum crawl sub-halaman
    const rawHtml = await page.content();
    const platform = detectPlatform(rawHtml);
    const $ = cheerio.load(rawHtml);

    // Multi-Page Crawler Otomatis (render & clone sub-halaman internal)
    const crawledPages = [];
    if (crawlSubPages && !clientClosed) {
      const targetRoutes = selectCrawlableRoutes(extractedElements.internalRoutes, 4);
      if (targetRoutes.length > 0) {
        sendEvent('log', {
          tag: 'CRAWL',
          progress: 62,
          catSpeech: `Menemukan ${targetRoutes.length} sub-halaman internal — merender otomatis...`,
          message: `Multi-Page Crawler memproses ${targetRoutes.map((r) => r.routePath).join(', ')}...`,
        });

        for (const rItem of targetRoutes) {
          if (clientClosed) break;
          try {
            const subUrl = new URL(rItem.routePath, parsedUrl.origin).href;
            await page.goto(subUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForTimeout(700);
            if (simulateUi) await simulateUiInteractions(page);
            const subDeep = await evaluateDeepDomData(page);
            const subRawHtml = await page.content();
            crawledPages.push({
              ...rItem,
              url: subUrl,
              title: subDeep.title || rItem.slug,
              rawHtml: subRawHtml,
              sections: subDeep.rawSections || [],
            });
          } catch {}
        }
      }
    }

    networkCollector.detach();
    const capturedNetworkAssets = networkCollector.getCaptured();
    const networkByUrl = new Map(capturedNetworkAssets.map((a) => [a.url, a]));

    await browser.close();
    browser = null;

    if (removeWatermarks) {
      $(
        '.w-webflow-badge, #__framer-badge-container, [data-framer-name="Badge"], a[href*="webflow.com?utm_campaign=brandjs"], a[href*="framer.website"]'
      ).remove();
    }

    const assetJobs = [];
    const savedUrls = new Set();
    const urlToLocalMap = new Map();
    const savedScriptEntries = [];
    const cssTexts = [];
    const counterRef = { val: 0 };

    // Collect inline <style> texts too for keyframe/curve extraction
    $('style').each((_, el) => {
      const txt = $(el).html();
      if (txt && txt.trim()) cssTexts.push(txt);
    });

    // Save inline <script> blocks for inspection
    let inlineScriptCount = 0;
    $('script:not([src])').each((_, el) => {
      const txt = $(el).html();
      if (!txt || txt.trim().length < 25 || inlineScriptCount >= 12) return;
      const fileName = `inline_${++inlineScriptCount}.js`;
      fs.writeFileSync(path.join(jsDir, fileName), txt, 'utf-8');
      savedScriptEntries.push({ absUrl: parsedUrl.href, content: txt });
    });

    // CSS from <link rel="stylesheet">
    $('link[rel="stylesheet"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      try {
        const absUrl = new URL(href, parsedUrl.href).href;
        if (savedUrls.has(absUrl)) return;
        savedUrls.add(absUrl);
        const fileName = `style_${++counterRef.val}.css`;
        const relPath = `assets/css/${fileName}`;
        urlToLocalMap.set(absUrl, relPath);
        assetJobs.push({
          type: 'CSS',
          absUrl,
          destPath: path.join(cssDir, fileName),
          fileName,
          relPath,
          applyRewrite: () => $(el).attr('href', relPath),
        });
      } catch {}
    });

    // JS from <script src>
    $('script[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      try {
        const absUrl = new URL(src, parsedUrl.href).href;
        if (savedUrls.has(absUrl)) return;
        savedUrls.add(absUrl);
        const fileName = `script_${++counterRef.val}.js`;
        const relPath = `assets/js/${fileName}`;
        urlToLocalMap.set(absUrl, relPath);
        assetJobs.push({
          type: 'JS',
          absUrl,
          destPath: path.join(jsDir, fileName),
          fileName,
          relPath,
          applyRewrite: () => $(el).attr('src', relPath),
        });
      } catch {}
    });

    // Images (max 150, includes data-src & srcset highest candidate)
    let imgCount = 0;
    $('img').each((_, el) => {
      let src = $(el).attr('src') || $(el).attr('data-src');
      if (!src && $(el).attr('srcset')) {
        const parts = $(el).attr('srcset').split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
        src = parts[parts.length - 1];
      }
      if (!src || src.startsWith('data:') || imgCount >= 150) return;
      try {
        const absUrl = new URL(src, parsedUrl.href).href;
        let ext = path.extname(new URL(absUrl).pathname).split('?')[0] || '.png';
        if (!/^\.[a-z0-9]{1,5}$/i.test(ext)) ext = '.png';
        const fileName = `img_${++counterRef.val}${ext}`;
        const relPath = `assets/images/${fileName}`;
        imgCount++;
        urlToLocalMap.set(absUrl, relPath);
        assetJobs.push({
          type: 'IMG',
          absUrl,
          destPath: path.join(imgDir, fileName),
          fileName,
          relPath,
          applyRewrite: () => {
            $(el).attr('src', relPath);
            $(el).removeAttr('srcset');
          },
        });
      } catch {}
    });

    // Download/write DOM asset batch
    let downloadedCount = 0;
    const savedAssetsSummary = { css: 0, js: 0, images: 0, fonts: 0, animations: 0, icons: 0, media: 0 };
    const batchSize = 5;

    for (let i = 0; i < assetJobs.length; i += batchSize) {
      if (clientClosed) break;
      const batch = assetJobs.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (job) => {
          let result = { ok: false, size: 0 };
          const netHit = networkByUrl.get(job.absUrl);
          if (netHit && netHit.buffer) {
            fs.writeFileSync(job.destPath, netHit.buffer);
            result = { ok: true, size: netHit.buffer.length };
          } else {
            result = await downloadAsset(job.absUrl, job.destPath);
          }

          if (result.ok) {
            if (job.type === 'CSS') {
              savedAssetsSummary.css++;
              try {
                const cssRaw = fs.readFileSync(job.destPath, 'utf-8');
                cssTexts.push(cssRaw);
                const rewrittenCss = await rewriteCssUrls(cssRaw, job.absUrl, { imgDir, fontsDir }, counterRef, urlToLocalMap);
                fs.writeFileSync(job.destPath, rewrittenCss);
              } catch {}
            } else if (job.type === 'JS') {
              savedAssetsSummary.js++;
              try {
                const jsRaw = fs.readFileSync(job.destPath, 'utf-8');
                savedScriptEntries.push({ absUrl: job.absUrl, content: jsRaw });
              } catch {}
            } else if (job.type === 'IMG') {
              savedAssetsSummary.images++;
            }

            job.applyRewrite();
            downloadedCount++;
            const currentProgress = Math.min(82, 60 + Math.round((downloadedCount / Math.max(1, assetJobs.length)) * 22));
            sendEvent('catCarry', {
              fileType: job.type,
              fileName: job.fileName,
              folderPath: job.relPath,
              size: result.size,
              progress: currentProgress,
              catSpeech: `Mengangkut ${job.fileName} (${(result.size / 1024).toFixed(1)} KB)... 🐾`,
            });
          }
        })
      );
    }

    // Persist extra dynamic assets captured via Network Interceptor (JS chunks, fonts, Lottie, SVGs, video)
    for (const netAsset of capturedNetworkAssets) {
      if (clientClosed) break;
      if (savedUrls.has(netAsset.url) || netAsset.kind === 'map' || netAsset.kind === 'image') continue;
      savedUrls.add(netAsset.url);

      let targetSubdir = null;
      let extFallback = '.bin';
      if (netAsset.kind === 'js') {
        targetSubdir = 'js';
        extFallback = '.js';
        savedAssetsSummary.js++;
        savedScriptEntries.push({ absUrl: netAsset.url, content: netAsset.buffer.toString('utf-8') });
      } else if (netAsset.kind === 'css') {
        targetSubdir = 'css';
        extFallback = '.css';
        savedAssetsSummary.css++;
        cssTexts.push(netAsset.buffer.toString('utf-8'));
      } else if (netAsset.kind === 'font') {
        targetSubdir = 'fonts';
        extFallback = '.woff2';
        savedAssetsSummary.fonts++;
      } else if (netAsset.kind === 'animation') {
        targetSubdir = 'animations';
        extFallback = netAsset.ext || '.json';
        savedAssetsSummary.animations++;
      } else if (netAsset.kind === 'svg') {
        targetSubdir = 'icons';
        extFallback = '.svg';
        savedAssetsSummary.icons++;
      } else if (netAsset.kind === 'media') {
        targetSubdir = 'media';
        extFallback = netAsset.ext || '.mp4';
        savedAssetsSummary.media++;
      }

      if (!targetSubdir) continue;
      const destSubDir = path.join(assetsDir, targetSubdir);
      fs.mkdirSync(destSubDir, { recursive: true });
      const fileName = `net_${++counterRef.val}_${sanitizeAssetFilename(netAsset.url, 'chunk', extFallback)}`;
      const destPath = path.join(destSubDir, fileName);
      fs.writeFileSync(destPath, netAsset.buffer);
      urlToLocalMap.set(netAsset.url, `assets/${targetSubdir}/${fileName}`);
      downloadedCount++;
    }

    // Save extracted inline SVGs into assets/icons/
    if ((extractedElements.inlineSvgs || []).length > 0) {
      const iconsDir = path.join(assetsDir, 'icons');
      fs.mkdirSync(iconsDir, { recursive: true });
      extractedElements.inlineSvgs.forEach((svgMarkup, idx) => {
        const iconName = `inline_icon_${idx + 1}.svg`;
        fs.writeFileSync(path.join(iconsDir, iconName), svgMarkup, 'utf-8');
        savedAssetsSummary.icons++;
      });
    }

    // Map crawled routes to local paths and save crawled sub-pages cleanly
    const routeToRel = new Map([['/', 'index.html']]);
    crawledPages.forEach((cp) => routeToRel.set(cp.routePath, cp.relOutputPath));

    const rewriteInternalLinks = ($doc, fromRelPath) => {
      const fromDir = path.posix.dirname(fromRelPath);
      $doc('a[href]').each((_, el) => {
        const href = $doc(el).attr('href');
        if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
        try {
          const u = new URL(href, parsedUrl.origin);
          if (u.origin !== parsedUrl.origin) return;
          const cleanPath = u.pathname.replace(/\/+$/, '') || '/';
          const targetRel = routeToRel.get(cleanPath);
          if (targetRel) {
            const relHref = path.posix.relative(fromDir === '.' ? '' : fromDir, targetRel) || 'index.html';
            $doc(el).attr('href', `${relHref}${u.hash || ''}`);
          }
        } catch {}
      });
    };

    rewriteInternalLinks($, 'index.html');

    if (crawledPages.length > 0) {
      for (const cp of crawledPages) {
        try {
          const sub$ = cheerio.load(cp.rawHtml);
          if (removeWatermarks) {
            sub$(
              '.w-webflow-badge, #__framer-badge-container, [data-framer-name="Badge"], a[href*="webflow.com?utm_campaign=brandjs"], a[href*="framer.website"]'
            ).remove();
          }
          const depthPrefix = '../'.repeat(cp.relOutputPath.split('/').length - 1);

          // Rewrite known stylesheets, scripts & images to relative local assets
          sub$('link[rel="stylesheet"]').each((_, el) => {
            const href = sub$(el).attr('href');
            if (!href) return;
            try {
              const abs = new URL(href, cp.url).href;
              const loc = urlToLocalMap.get(abs);
              if (loc) sub$(el).attr('href', `${depthPrefix}${loc}`);
            } catch {}
          });
          sub$('script[src]').each((_, el) => {
            const src = sub$(el).attr('src');
            if (!src) return;
            try {
              const abs = new URL(src, cp.url).href;
              const loc = urlToLocalMap.get(abs);
              if (loc) sub$(el).attr('src', `${depthPrefix}${loc}`);
            } catch {}
          });
          sub$('img').each((_, el) => {
            const src = sub$(el).attr('src') || sub$(el).attr('data-src');
            if (!src || src.startsWith('data:')) return;
            try {
              const abs = new URL(src, cp.url).href;
              const loc = urlToLocalMap.get(abs);
              if (loc) {
                sub$(el).attr('src', `${depthPrefix}${loc}`);
                sub$(el).removeAttr('srcset');
              }
            } catch {}
          });

          rewriteInternalLinks(sub$, cp.relOutputPath);

          const subDest = path.join(exportDir, cp.relOutputPath);
          fs.mkdirSync(path.dirname(subDest), { recursive: true });
          fs.writeFileSync(subDest, sub$.html(), 'utf-8');
          sendEvent('catCarry', {
            fileType: 'HTML',
            fileName: `${cp.slug}/index.html`,
            folderPath: cp.relOutputPath,
            size: fs.statSync(subDest).size,
            progress: 84,
            catSpeech: `Sub-halaman ${cp.routePath} berhasil di-clone!`,
          });
        } catch {}
      }

      fs.writeFileSync(
        path.join(reaDir, 'crawled-pages.json'),
        JSON.stringify(
          crawledPages.map((p) => ({ routePath: p.routePath, title: p.title, relOutputPath: p.relOutputPath, sectionsCount: p.sections.length })),
          null,
          2
        )
      );
    }

    // Simpan index.html setelah aset & internal link berhasil di-rewrite
    const indexHtmlPath = path.join(exportDir, 'index.html');
    fs.writeFileSync(indexHtmlPath, $.html());
    sendEvent('catCarry', {
      fileType: 'HTML',
      fileName: 'index.html',
      folderPath: 'index.html',
      size: fs.statSync(indexHtmlPath).size,
      progress: 85,
      catSpeech: 'index.html utama & dynamic chunks sudah diamankan! 📄✨',
    });

    // Source Map Recovery (.js.map -> src-recovered/*.tsx)
    sendEvent('log', {
      tag: 'REA-CDP',
      progress: 88,
      catSpeech: 'Memeriksa Source Maps (.js.map) & mengekstrak animasi @keyframes...',
      message: 'Mencari Source Maps (.tsx/.ts) serta mengompilasi @keyframes & komponen TSX...',
    });

    const sourceMapReport = await recoverSourceMaps({
      capturedAssets: capturedNetworkAssets,
      savedScriptEntries,
      exportDir,
      downloadFn: downloadAsset,
    });

    if (sourceMapReport.recoveredFiles.length > 0) {
      const sample = sourceMapReport.recoveredFiles[0];
      sendEvent('catCarry', {
        fileType: 'TSX',
        fileName: path.basename(sample.relPath),
        folderPath: sample.relPath,
        size: sample.size,
        progress: 90,
        catSpeech: `Menemukan ${sourceMapReport.recoveredFiles.length} file source asli dari Source Maps! 🎉`,
      });
    }

    // Merge CSS + DOM keyframes & cubic-bezier curves
    const cssMotion = extractMotionFromCssTexts(cssTexts);
    const mergedKeyframesMap = new Map();
    [...(extractedElements.domKeyframes || []), ...cssMotion.keyframes].forEach((k) => {
      if (k && k.name && !mergedKeyframesMap.has(k.name)) mergedKeyframesMap.set(k.name, k);
    });
    const mergedCurves = Array.from(new Set([...(cssMotion.curves || []), ...(extractedElements.domCurves || [])])).slice(0, 24);

    // Aggregate deduplicated Color Palette & Font Library
    const catalog = buildColorsAndFontsCatalog({
      extractedElements,
      cssTexts,
      pageUrl: parsedUrl.href,
      urlToLocalMap,
    });
    extractedElements.colorsDetailed = catalog.colorsDetailed;
    extractedElements.fontsDetailed = catalog.fontsDetailed;
    if (catalog.colorsHexList.length > 0) {
      extractedElements.colors = catalog.colorsHexList;
    }
    fs.writeFileSync(tokensPath, JSON.stringify(extractedElements, null, 2));

    // Generate components/*.tsx, motion/animations.css, tailwind.config.ts, EXPORT_REPORT.md
    const workspaceFiles = writeTsxAndMotionWorkspace({
      exportDir,
      domain: parsedUrl.hostname,
      platform,
      extractedData: extractedElements,
      motionData: {
        keyframes: Array.from(mergedKeyframesMap.values()),
        curves: mergedCurves,
      },
      sourceMapReport,
      savedAssetsSummary,
      urlToLocalMap,
    });

    const keyGenerated = workspaceFiles.find((f) => f.fileName === 'ExtractedPage.tsx') || workspaceFiles[0];
    if (keyGenerated) {
      sendEvent('catCarry', {
        fileType: 'TSX',
        fileName: keyGenerated.fileName,
        folderPath: keyGenerated.folderPath,
        size: keyGenerated.size,
        progress: 92,
        catSpeech: `Membentuk ${workspaceFiles.length} file TSX, motion CSS, & Tailwind config!`,
      });
    }

    // Auto-generate runnable React + Vite + TSX project under react-vite-app/
    const viteScaffold = writeViteReactProject({
      exportDir,
      domain: parsedUrl.hostname,
      extractedData: extractedElements,
      motionData: {
        keyframes: Array.from(mergedKeyframesMap.values()),
        curves: mergedCurves,
      },
      crawledPages,
      urlToLocalMap,
    });

    sendEvent('catCarry', {
      fileType: 'VITE',
      fileName: 'react-vite-app/package.json',
      folderPath: 'react-vite-app/package.json',
      size: viteScaffold.createdFiles[0]?.size || 0,
      progress: 94,
      catSpeech: 'Proyek Vite + React + TSX mandiri siap dijalankan (`npm install && npm run dev`)!',
    });

    // Simpan Metadata sebelum arsip .ZIP agar ikut terbungkus
    const metadata = {
      jobId,
      domain: parsedUrl.hostname,
      url: parsedUrl.href,
      title: extractedElements.title,
      platform,
      reaStatus,
      createdAt: new Date().toISOString(),
      zipUrl: `/downloads/${jobId}.zip`,
      previewUrl: `/downloads/${jobId}/index.html`,
      screenshotUrl: `/downloads/${jobId}/preview.png`,
      stats: {
        assetsDownloaded: downloadedCount,
        componentsCount: extractedElements.componentsCount,
        colors: extractedElements.colors,
        colorsDetailed: extractedElements.colorsDetailed,
        fonts: extractedElements.fonts,
        fontsDetailed: extractedElements.fontsDetailed,
        cssVars: extractedElements.cssVars || {},
        recoveredSourceFiles: sourceMapReport.recoveredFiles.length,
        tsxComponentsGenerated: workspaceFiles.filter((f) => f.folderPath.startsWith('components/Section_')).length,
        keyframesCount: mergedKeyframesMap.size,
        detectedLibraries: extractedElements.detectedLibraries || [],
        crawledPagesCount: crawledPages.length,
        interactiveStates: {
          hovered: interactionReport.hoveredCount,
          clicked: interactionReport.clickedCount,
          newlyAddedNodes: interactionReport.newlyAddedNodes,
        },
        viteAppGenerated: true,
      },
    };
    fs.writeFileSync(path.join(exportDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

    // Bungkus ke ZIP
    sendEvent('log', {
      tag: 'ARCHIVE',
      progress: 96,
      catSpeech: 'Membungkus semua HTML, aset, animasi, & .tsx ke paket .ZIP! 📦🐱',
      message: 'Mengompres seluruh folder menjadi arsip .ZIP...',
    });

    const zipFileName = `${jobId}.zip`;
    const zipFilePath = path.join(EXPORTS_ROOT, zipFileName);

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipFilePath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(exportDir, false);
      archive.finalize();
    });

    const folderTree = buildFolderTree(exportDir);

    sendEvent('complete', {
      progress: 100,
      catSpeech: 'Purr-fect!! Semua elemen & folder siap kamu jelajahi! 🎉😻',
      metadata,
      folderTree,
    });
    res.end();
  } catch (err) {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    sendEvent('error', {
      catSpeech: 'Meowww... Ada batu sandungan di jalan! 😿',
      message: err.message,
    });
    if (!res.writableEnded) res.end();
  }
});

// ============================================================================
// 2. ENDPOINT INTERACTIVE FOLDER TREE & FILE PREVIEWER
// ============================================================================
app.get('/api/files/:jobId', (req, res) => {
  const safeExportsRoot = path.resolve(EXPORTS_ROOT);
  const targetDir = path.resolve(safeExportsRoot, req.params.jobId);
  if (!targetDir.startsWith(safeExportsRoot + path.sep) || !fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    return res.status(404).json({ error: 'Folder tidak ditemukan' });
  }
  res.json({ jobId: req.params.jobId, tree: buildFolderTree(targetDir) });
});

app.get('/api/file-content', (req, res) => {
  const { jobId, filePath } = req.query;
  if (!jobId || !filePath) return res.status(400).json({ error: 'Parameter kurang lengkap' });

  const safeExportsRoot = path.resolve(EXPORTS_ROOT);
  const safeJobDir = path.resolve(safeExportsRoot, String(jobId));
  if (!safeJobDir.startsWith(safeExportsRoot + path.sep)) {
    return res.status(404).json({ error: 'Folder tidak valid' });
  }
  const absFilePath = path.resolve(safeJobDir, String(filePath));

  // Proteksi Path Traversal
  if (!absFilePath.startsWith(safeJobDir + path.sep) || !fs.existsSync(absFilePath) || !fs.statSync(absFilePath).isFile()) {
    return res.status(404).json({ error: 'File tidak ditemukan' });
  }

  const ext = path.extname(absFilePath).toLowerCase();
  const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.avif'];
  const binaryExts = ['.woff2', '.woff', '.ttf', '.otf', '.eot', '.mp4', '.webm', '.mov', '.riv', '.zip', '.bin', '.wasm'];
  const encodedPath = String(filePath).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  const publicUrl = `/downloads/${encodeURIComponent(String(jobId))}/${encodedPath}`;

  if (imageExts.includes(ext)) {
    return res.json({
      type: 'image',
      url: publicUrl,
    });
  }

  if (binaryExts.includes(ext)) {
    return res.json({
      type: 'binary',
      ext,
      size: fs.statSync(absFilePath).size,
      url: publicUrl,
    });
  }

  const content = fs.readFileSync(absFilePath, 'utf-8').slice(0, 100000);
  res.json({
    type: 'code',
    ext,
    content,
  });
});

// ============================================================================
// 3. ENDPOINT RIWAYAT EKSTRAKSI, DELETE + UNDO & TOKEN CATALOG (/api/history, /api/archive/*)
// ============================================================================
function resolveSafeJobPaths(rawJobId) {
  if (typeof rawJobId !== 'string') return null;
  const jobId = rawJobId.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,160}$/.test(jobId) || jobId === '.trash') return null;

  const safeRoot = path.resolve(EXPORTS_ROOT);
  const dirPath = path.resolve(safeRoot, jobId);
  const zipPath = path.resolve(safeRoot, `${jobId}.zip`);
  if (!dirPath.startsWith(safeRoot + path.sep) || !zipPath.startsWith(safeRoot + path.sep)) return null;
  return { jobId, dirPath, zipPath };
}

function purgeExpiredTrash(maxAgeMs = 2 * 60 * 60 * 1000) {
  if (!fs.existsSync(TRASH_ROOT)) return;
  const now = Date.now();
  for (const entry of fs.readdirSync(TRASH_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = path.join(TRASH_ROOT, entry.name);
    try {
      const stat = fs.statSync(p);
      if (now - stat.mtimeMs > maxAgeMs) fs.rmSync(p, { recursive: true, force: true });
    } catch {}
  }
}

function moveJobsToTrash(rawJobIds) {
  purgeExpiredTrash();
  const trashId = `trash_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const trashSlot = path.join(TRASH_ROOT, trashId);
  const deletedIds = [];

  for (const rawId of rawJobIds) {
    const resolved = resolveSafeJobPaths(rawId);
    if (!resolved) continue;
    const hasDir = fs.existsSync(resolved.dirPath);
    const hasZip = fs.existsSync(resolved.zipPath);
    if (!hasDir && !hasZip) continue;

    fs.mkdirSync(trashSlot, { recursive: true });
    if (hasDir) fs.renameSync(resolved.dirPath, path.join(trashSlot, resolved.jobId));
    if (hasZip) fs.renameSync(resolved.zipPath, path.join(trashSlot, `${resolved.jobId}.zip`));
    deletedIds.push(resolved.jobId);
  }

  if (deletedIds.length > 0) {
    fs.writeFileSync(
      path.join(trashSlot, 'manifest.json'),
      JSON.stringify({ trashId, createdAt: new Date().toISOString(), jobIds: deletedIds }, null, 2)
    );
  }
  return { trashId: deletedIds.length > 0 ? trashId : null, deletedIds };
}

app.get('/api/history', (req, res) => {
  if (!fs.existsSync(EXPORTS_ROOT)) return res.json([]);
  const entries = fs.readdirSync(EXPORTS_ROOT, { withFileTypes: true });
  const history = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const jobDir = path.join(EXPORTS_ROOT, entry.name);
    const metaPath = path.join(jobDir, 'metadata.json');

    if (fs.existsSync(metaPath)) {
      try {
        history.push(JSON.parse(fs.readFileSync(metaPath, 'utf-8')));
        continue;
      } catch {}
    }

    // Fallback untuk hasil ekstraksi versi v1 yang belum punya metadata.json
    const indexPath = path.join(jobDir, 'index.html');
    if (!fs.existsSync(indexPath)) continue;

    const tokenPath = path.join(jobDir, 'rea-blueprint', 'design-tokens-and-elements.json');
    let tokens = {};
    try {
      tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    } catch {}

    let platform = 'Extracted Web';
    try {
      const htmlHead = fs.readFileSync(indexPath, 'utf-8').slice(0, 50000);
      platform = detectPlatform(htmlHead);
    } catch {}

    const countDir = (d) => (fs.existsSync(d) ? fs.readdirSync(d).length : 0);
    const assetsDownloaded =
      countDir(path.join(jobDir, 'assets', 'css')) +
      countDir(path.join(jobDir, 'assets', 'js')) +
      countDir(path.join(jobDir, 'assets', 'images'));

    const domainPart = entry.name.replace(/_\d+$/, '').replace(/_/g, '.');
    const stat = fs.statSync(indexPath);

    history.push({
      jobId: entry.name,
      domain: domainPart,
      url: `https://${domainPart}`,
      title: tokens.title || domainPart,
      platform,
      reaStatus: 'legacy',
      createdAt: stat.mtime.toISOString(),
      zipUrl: `/downloads/${entry.name}.zip`,
      previewUrl: `/downloads/${entry.name}/index.html`,
      screenshotUrl: `/downloads/${entry.name}/preview.png`,
      stats: {
        assetsDownloaded,
        componentsCount: tokens.componentsCount || 0,
        colors: tokens.colors || [],
        colorsDetailed: tokens.colorsDetailed || null,
        fonts: tokens.fonts || [],
        fontsDetailed: tokens.fontsDetailed || null,
        cssVars: tokens.cssVars || {},
      },
    });
  }

  history.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(history.slice(0, 40));
});

app.get('/api/archive/tokens/:jobId', (req, res) => {
  const resolved = resolveSafeJobPaths(req.params.jobId);
  if (!resolved || !fs.existsSync(resolved.dirPath)) {
    return res.status(404).json({ error: 'Archive tidak ditemukan' });
  }

  let metadata = {};
  let tokens = {};
  let motionBlueprint = null;
  try {
    metadata = JSON.parse(fs.readFileSync(path.join(resolved.dirPath, 'metadata.json'), 'utf-8'));
  } catch {}
  try {
    tokens = JSON.parse(fs.readFileSync(path.join(resolved.dirPath, 'rea-blueprint', 'design-tokens-and-elements.json'), 'utf-8'));
  } catch {}
  try {
    motionBlueprint = JSON.parse(fs.readFileSync(path.join(resolved.dirPath, 'motion', 'motion-blueprint.json'), 'utf-8'));
  } catch {}

  let colorsDetailed = tokens.colorsDetailed || metadata.stats?.colorsDetailed || null;
  let fontsDetailed = tokens.fontsDetailed || metadata.stats?.fontsDetailed || null;

  // Backfill legacy archives cleanly from their actual saved CSS & index.html
  if (!colorsDetailed || !fontsDetailed) {
    const cssTexts = [];
    const cssDir = path.join(resolved.dirPath, 'assets', 'css');
    if (fs.existsSync(cssDir)) {
      for (const f of fs.readdirSync(cssDir).slice(0, 10)) {
        if (f.endsWith('.css')) {
          try {
            cssTexts.push(fs.readFileSync(path.join(cssDir, f), 'utf-8'));
          } catch {}
        }
      }
    }
    const localMap = new Map();
    const fontsDir = path.join(resolved.dirPath, 'assets', 'fonts');
    if (fs.existsSync(fontsDir)) {
      for (const f of fs.readdirSync(fontsDir)) {
        localMap.set(f, `assets/fonts/${f}`);
      }
    }
    const rawColors = (tokens.colors || metadata.stats?.colors || []).map((c) => ({ raw: c, category: 'Extracted', count: 1 }));
    const rawFonts = (tokens.fonts || metadata.stats?.fonts || []).map((f) => ({ family: f, weights: [], styles: ['normal'], headingHits: 0, bodyHits: 1 }));
    const fallbackCatalog = buildColorsAndFontsCatalog({
      extractedElements: {
        rawColorObservations: rawColors,
        rawFontObservations: rawFonts,
        fontLinks: [],
      },
      cssTexts,
      pageUrl: metadata.url || `https://${metadata.domain || 'localhost'}`,
      urlToLocalMap: localMap,
    });
    if (!colorsDetailed) colorsDetailed = fallbackCatalog.colorsDetailed;
    if (!fontsDetailed) fontsDetailed = fallbackCatalog.fontsDetailed;
  }

  res.json({
    jobId: resolved.jobId,
    colors: tokens.colors || metadata.stats?.colors || [],
    colorsDetailed: colorsDetailed || [],
    fonts: tokens.fonts || metadata.stats?.fonts || [],
    fontsDetailed: fontsDetailed || [],
    cssVars: tokens.cssVars || metadata.stats?.cssVars || {},
    motionBlueprint,
  });
});

app.delete('/api/archive/:jobId', (req, res) => {
  const { trashId, deletedIds } = moveJobsToTrash([req.params.jobId]);
  if (deletedIds.length === 0) {
    return res.status(404).json({ error: 'Archive tidak ditemukan atau ID tidak valid' });
  }
  res.json({ ok: true, trashId, deletedIds });
});

app.post('/api/archive/delete-bulk', (req, res) => {
  const jobIds = Array.isArray(req.body?.jobIds) ? req.body.jobIds : [];
  if (jobIds.length === 0) return res.status(400).json({ error: 'Pilih minimal satu archive' });

  const { trashId, deletedIds } = moveJobsToTrash(jobIds.slice(0, 60));
  if (deletedIds.length === 0) return res.status(404).json({ error: 'Tidak ada archive valid ditemukan' });
  res.json({ ok: true, trashId, deletedIds });
});

app.post('/api/archive/restore', (req, res) => {
  const rawTrashId = req.body?.trashId;
  if (typeof rawTrashId !== 'string' || !/^[a-zA-Z0-9_-]{3,80}$/.test(rawTrashId)) {
    return res.status(400).json({ error: 'Trash ID tidak valid' });
  }
  const safeTrashRoot = path.resolve(TRASH_ROOT);
  const trashSlot = path.resolve(safeTrashRoot, rawTrashId);
  if (!trashSlot.startsWith(safeTrashRoot + path.sep) || !fs.existsSync(trashSlot)) {
    return res.status(404).json({ error: 'Data Undo sudah kedaluwarsa atau tidak ditemukan' });
  }

  let manifest = { jobIds: [] };
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(trashSlot, 'manifest.json'), 'utf-8'));
  } catch {}

  const restoredIds = [];
  for (const jobId of manifest.jobIds || []) {
    const resolved = resolveSafeJobPaths(jobId);
    if (!resolved) continue;
    const trashedDir = path.join(trashSlot, resolved.jobId);
    const trashedZip = path.join(trashSlot, `${resolved.jobId}.zip`);
    if (fs.existsSync(trashedDir) && !fs.existsSync(resolved.dirPath)) {
      fs.renameSync(trashedDir, resolved.dirPath);
    }
    if (fs.existsSync(trashedZip) && !fs.existsSync(resolved.zipPath)) {
      fs.renameSync(trashedZip, resolved.zipPath);
    }
    restoredIds.push(resolved.jobId);
  }

  try {
    fs.rmSync(trashSlot, { recursive: true, force: true });
  } catch {}

  res.json({ ok: true, restoredIds });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🐾✨ REA NoCode Exporter Pro berjalan di http://localhost:${PORT}`);
});
