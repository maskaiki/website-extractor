'use strict';

const express = require('express');
const { chromium } = require('playwright');
const cheerio = require('cheerio');
const archiver = require('archiver');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const EXPORTS_ROOT = path.join(__dirname, 'exports');
if (!fs.existsSync(EXPORTS_ROOT)) fs.mkdirSync(EXPORTS_ROOT, { recursive: true });
app.use('/downloads', express.static(EXPORTS_ROOT));

const CDP_PORT = 9222;
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

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

// Helper: Rewrite url(...) di dalam CSS ke path lokal ../images/
async function rewriteCssUrls(cssContent, cssUrl, imgDir, counterRef) {
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
      const fileName = `css_asset_${++counterRef.val}${ext}`;
      const destPath = path.join(imgDir, fileName);
      replacements.set(original, null);
      tasks.push(
        downloadAsset(absUrl, destPath).then((res) => {
          if (res.ok) {
            replacements.set(original, `../images/${fileName}`);
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
    viewport = 'desktop',
  } = req.query;

  removeWatermarks = removeWatermarks === 'true';
  runReaAnalysis = runReaAnalysis === 'true';

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
    sendEvent('log', {
      tag: 'BOOT',
      jobId,
      progress: 8,
      catSpeech: 'Meow! Menyiapkan Stealth Browser & port CDP 9222...',
      message: `Membuka Chromium Stealth (${selectedViewport.width}x${selectedViewport.height}) untuk ${parsedUrl.hostname}`,
    });

    browser = await chromium.launch({
      headless: true,
      args: [
        `--remote-debugging-port=${CDP_PORT}`,
        `--remote-debugging-address=127.0.0.1`,
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
    });

    const context = await browser.newContext({
      viewport: selectedViewport,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    // Anti-Bot Webdriver Stealth
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    sendEvent('log', {
      tag: 'NAVIGATE',
      progress: 18,
      catSpeech: `Lari ke ${parsedUrl.hostname}... mengendus struktur DOM! 🐾`,
      message: `Menghubungi ${parsedUrl.href} (Smart Anti-Timeout aktif)...`,
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
      catSpeech: 'Menggulung halaman dari atas ke bawah biar semua gambar keluar...',
      message: 'Menjalankan Auto-Scroll untuk merender gambar lazy-load & animasi...',
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

    // Ekstrak Design Tokens & Elemen Semantik
    sendEvent('log', {
      tag: 'TOKENS',
      progress: 44,
      catSpeech: 'Mengumpulkan palet warna, font, dan komponen UI! 🎨',
      message: 'Mengekstrak Computed Styles, Colors, Typography, dan Semantic Sections...',
    });

    const extractedElements = await page.evaluate(() => {
      const colors = new Set();
      const fonts = new Set();
      const components = [];

      document.querySelectorAll('*').forEach((el) => {
        const style = window.getComputedStyle(el);
        if (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)') colors.add(style.backgroundColor);
        if (style.color) colors.add(style.color);
        if (style.fontFamily) {
          const cleanFont = style.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
          if (cleanFont) fonts.add(cleanFont);
        }
      });

      const semanticSelectors = ['header', 'nav', 'main', 'section', 'article', 'footer', 'form', 'button'];
      semanticSelectors.forEach((tag) => {
        document.querySelectorAll(tag).forEach((el, idx) => {
          const rect = el.getBoundingClientRect();
          components.push({
            tag,
            index: idx,
            id: el.id || null,
            classes: typeof el.className === 'string' ? el.className : null,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            htmlPreview: el.outerHTML.slice(0, 500),
          });
        });
      });

      return {
        title: document.title || 'Untitled Website',
        colors: Array.from(colors).slice(0, 24),
        fonts: Array.from(fonts).slice(0, 12),
        componentsCount: components.length,
        components,
      };
    });

    const tokensPath = path.join(reaDir, 'design-tokens-and-elements.json');
    fs.writeFileSync(tokensPath, JSON.stringify(extractedElements, null, 2));

    sendEvent('catCarry', {
      fileType: 'JSON',
      fileName: 'design-tokens-and-elements.json',
      folderPath: 'rea-blueprint/design-tokens-and-elements.json',
      size: fs.statSync(tokensPath).size,
      catSpeech: 'Membawa design-tokens.json ke brankas folder! 🐾',
    });

    // Screenshot Preview
    const ssPath = path.join(exportDir, 'preview.png');
    await page.screenshot({ path: ssPath, fullPage: false });
    sendEvent('catCarry', {
      fileType: 'IMG',
      fileName: 'preview.png',
      folderPath: 'preview.png',
      size: fs.statSync(ssPath).size,
      catSpeech: 'Cekrek! Menyimpan foto preview.png 📸',
    });

    // Jalankan Reverse Engineering morluto/rea via CDP Port 9222
    let reaReport = { status: 'skipped' };
    let reaStatus = 'skipped';
    let targetId = null;

    if (runReaAnalysis) {
      sendEvent('log', {
        tag: 'REA-CDP',
        progress: 52,
        catSpeech: 'Memanggil mesin morluto/rea untuk bedah CDP port 9222... 🔍',
        message: 'Menjalankan `rea list-browser-targets` & `rea inspect-web-page`...',
      });

      const targets = await runReaCommand([
        'list-browser-targets',
        CDP_ENDPOINT,
        '--format',
        'json',
      ]);

      const targetList = extractReaTargets(targets);
      if (targetList.length > 0) {
        const matched =
          targetList.find((t) => t.url && t.url.includes(parsedUrl.hostname)) || targetList[0];
        targetId = sanitizeTargetId(matched.target_id || matched.id || matched.targetId);
      }

      if (targetId) {
        const pageInspection = await runReaCommand([
          'inspect-web-page',
          CDP_ENDPOINT,
          targetId,
          '--include-accessibility-text',
          '--include-console-text',
          '--include-json-body-shapes',
          '--include-storage-keys',
          '--format',
          'json',
        ]);

        const bundleAnalysis = await runReaCommand([
          'analyze-web-bundle',
          CDP_ENDPOINT,
          targetId,
          '--fetch-source-maps',
          '--format',
          'json',
        ]);

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

    // Proses HTML, Hapus Watermark, Download Semua Aset
    const rawHtml = await page.content();
    const platform = detectPlatform(rawHtml);
    const $ = cheerio.load(rawHtml);

    await browser.close();
    browser = null;

    if (removeWatermarks) {
      $(
        '.w-webflow-badge, #__framer-badge-container, [data-framer-name="Badge"], a[href*="webflow.com?utm_campaign=brandjs"], a[href*="framer.website"]'
      ).remove();
    }

    const assetJobs = [];
    const counterRef = { val: 0 };

    // CSS
    $('link[rel="stylesheet"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      try {
        const absUrl = new URL(href, parsedUrl.href).href;
        const fileName = `style_${++counterRef.val}.css`;
        const relPath = `assets/css/${fileName}`;
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

    // JS
    $('script[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      try {
        const absUrl = new URL(src, parsedUrl.href).href;
        const fileName = `script_${++counterRef.val}.js`;
        const relPath = `assets/js/${fileName}`;
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

    // Images (max 45)
    let imgCount = 0;
    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (!src || src.startsWith('data:') || imgCount >= 45) return;
      try {
        const absUrl = new URL(src, parsedUrl.href).href;
        let ext = path.extname(new URL(absUrl).pathname).split('?')[0] || '.png';
        if (!/^\.[a-z0-9]{1,5}$/i.test(ext)) ext = '.png';
        const fileName = `img_${++counterRef.val}${ext}`;
        const relPath = `assets/images/${fileName}`;
        imgCount++;
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

    // Download aset batch + animasi kucing
    let downloadedCount = 0;
    const batchSize = 5;
    for (let i = 0; i < assetJobs.length; i += batchSize) {
      if (clientClosed) break;
      const batch = assetJobs.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (job) => {
          const result = await downloadAsset(job.absUrl, job.destPath);
          if (result.ok) {
            if (job.type === 'CSS') {
              try {
                const cssRaw = fs.readFileSync(job.destPath, 'utf-8');
                const rewrittenCss = await rewriteCssUrls(cssRaw, job.absUrl, imgDir, counterRef);
                fs.writeFileSync(job.destPath, rewrittenCss);
              } catch {}
            }
            job.applyRewrite();
            downloadedCount++;
            const currentProgress = Math.min(90, 60 + Math.round((downloadedCount / Math.max(1, assetJobs.length)) * 30));
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

    // Simpan index.html setelah aset yang berhasil di-rewrite
    const indexHtmlPath = path.join(exportDir, 'index.html');
    fs.writeFileSync(indexHtmlPath, $.html());
    sendEvent('catCarry', {
      fileType: 'HTML',
      fileName: 'index.html',
      folderPath: 'index.html',
      size: fs.statSync(indexHtmlPath).size,
      progress: 92,
      catSpeech: 'index.html utama sudah diamankan! 📄✨',
    });

    // Bungkus ke ZIP
    sendEvent('log', {
      tag: 'ARCHIVE',
      progress: 95,
      catSpeech: 'Membungkus semua tangkapan ke dalam paket .ZIP! 📦🐱',
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

    // Simpan Metadata
    const metadata = {
      jobId,
      domain: parsedUrl.hostname,
      url: parsedUrl.href,
      title: extractedElements.title,
      platform,
      reaStatus,
      createdAt: new Date().toISOString(),
      zipUrl: `/downloads/${zipFileName}`,
      previewUrl: `/downloads/${jobId}/index.html`,
      screenshotUrl: `/downloads/${jobId}/preview.png`,
      stats: {
        assetsDownloaded: downloadedCount,
        componentsCount: extractedElements.componentsCount,
        colors: extractedElements.colors,
        fonts: extractedElements.fonts,
      },
    };
    fs.writeFileSync(path.join(exportDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

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
  const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico'];

  if (imageExts.includes(ext)) {
    const encodedPath = String(filePath).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
    return res.json({
      type: 'image',
      url: `/downloads/${encodeURIComponent(String(jobId))}/${encodedPath}`,
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
// 3. ENDPOINT RIWAYAT EKSTRAKSI (/api/history)
// ============================================================================
app.get('/api/history', (req, res) => {
  if (!fs.existsSync(EXPORTS_ROOT)) return res.json([]);
  const entries = fs.readdirSync(EXPORTS_ROOT, { withFileTypes: true });
  const history = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
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
        fonts: tokens.fonts || [],
      },
    });
  }

  history.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(history.slice(0, 12));
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🐾✨ REA NoCode Exporter Pro berjalan di http://localhost:${PORT}`);
});
