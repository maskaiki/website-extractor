'use strict';

const fs = require('fs');
const path = require('path');

const MAX_NETWORK_ASSET_BYTES = 8 * 1024 * 1024; // 8 MB per resource
const MAX_TOTAL_NETWORK_BYTES = 35 * 1024 * 1024; // 35 MB total captured buffers
const MAX_RECOVERED_SOURCE_FILES = 150;

const CAPTURE_EXT_MAP = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.css': 'css',
  '.map': 'map',
  '.woff2': 'font',
  '.woff': 'font',
  '.ttf': 'font',
  '.otf': 'font',
  '.svg': 'svg',
  '.riv': 'animation',
  '.mp4': 'media',
  '.webm': 'media',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.avif': 'image',
};

function sanitizeAssetFilename(rawName, fallbackPrefix, ext) {
  const base = path.basename(rawName || '').split('?')[0].split('#')[0];
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  if (cleaned && cleaned.includes('.')) return cleaned;
  return `${fallbackPrefix}${ext}`;
}

function isLikelyLottieJson(text) {
  if (!text || text.length < 40 || text.length > 4 * 1024 * 1024) return false;
  try {
    const parsed = JSON.parse(text);
    return (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray(parsed.layers) &&
      typeof parsed.fr === 'number' &&
      typeof parsed.op === 'number'
    );
  } catch {
    return false;
  }
}

/**
 * Attach Playwright response listener to capture dynamic JS chunks, CSS, source maps,
 * fonts, Lottie animations, SVGs, and media loaded during page hydration/scroll.
 */
function attachNetworkCollector(page) {
  const captured = new Map();
  let totalBytes = 0;

  const handler = async (response) => {
    try {
      const status = response.status();
      if (status < 200 || status >= 300) return;

      const url = response.url();
      if (!url || url.startsWith('data:') || url.startsWith('blob:') || captured.has(url)) return;
      if (captured.size >= 180 || totalBytes >= MAX_TOTAL_NETWORK_BYTES) return;

      const headers = response.headers();
      const ct = (headers['content-type'] || '').toLowerCase();
      const contentLen = parseInt(headers['content-length'] || '0', 10);
      if (contentLen > MAX_NETWORK_ASSET_BYTES) return;

      let ext = '';
      try {
        ext = path.extname(new URL(url).pathname).toLowerCase();
      } catch {}

      let kind = CAPTURE_EXT_MAP[ext] || null;
      if (!kind) {
        if (ct.includes('javascript') || ct.includes('ecmascript')) kind = 'js';
        else if (ct.includes('text/css')) kind = 'css';
        else if (ct.includes('font/') || ct.includes('woff')) kind = 'font';
        else if (ct.includes('image/svg')) kind = 'svg';
        else if (ct.includes('image/')) kind = 'image';
        else if (ct.includes('video/')) kind = 'media';
        else if (ct.includes('application/json') && /lottie|anim|motion/i.test(url)) kind = 'json-candidate';
      }

      if (!kind) return;

      const buffer = await response.body();
      if (!buffer || buffer.length === 0 || buffer.length > MAX_NETWORK_ASSET_BYTES) return;

      if (kind === 'json-candidate') {
        if (!isLikelyLottieJson(buffer.toString('utf-8'))) return;
        kind = 'animation';
      }

      totalBytes += buffer.length;
      captured.set(url, { url, kind, ext: ext || '', contentType: ct, buffer });
    } catch {
      // Ignore closed target / aborted response errors
    }
  };

  page.on('response', handler);
  return {
    getCaptured: () => Array.from(captured.values()),
    detach: () => page.off('response', handler),
  };
}

/**
 * Safely unpack source map `sources` + `sourcesContent` into `src-recovered/`.
 */
function unpackSourceMapObject(mapObj, sourceUrl, outRoot, seenPaths) {
  if (!mapObj || !Array.isArray(mapObj.sources) || !Array.isArray(mapObj.sourcesContent)) return [];

  const safeRoot = path.resolve(outRoot);
  const unpacked = [];

  for (let i = 0; i < mapObj.sources.length; i++) {
    if (seenPaths.size >= MAX_RECOVERED_SOURCE_FILES) break;
    const content = mapObj.sourcesContent[i];
    if (typeof content !== 'string' || !content.trim()) continue;

    let rawSrc = String(mapObj.sources[i] || `module_${i}.ts`);
    rawSrc = rawSrc
      .replace(/^webpack:\/\/[^/]*\//i, '')
      .replace(/^(webpack|vite|turbopack|rsc|file):\/+/i, '')
      .replace(/^(\.\.\/)+/g, '')
      .replace(/^\/+/, '')
      .replace(/\?.*$/, '');

    // Group node_modules separately or skip huge third-party libs if needed
    const parts = rawSrc
      .split(/[\\/]/)
      .filter((p) => p && p !== '.' && p !== '..')
      .map((p) => p.replace(/[<>:"|?*]/g, '_'));

    if (parts.length === 0) parts.push(`recovered_${i}.ts`);
    let relPosix = parts.join('/');

    if (seenPaths.has(relPosix)) {
      const ext = path.posix.extname(relPosix) || '.ts';
      const stem = relPosix.slice(0, relPosix.length - ext.length);
      relPosix = `${stem}_${i}${ext}`;
    }

    const destAbs = path.resolve(safeRoot, relPosix);
    if (!destAbs.startsWith(safeRoot + path.sep)) continue;

    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.writeFileSync(destAbs, content, 'utf-8');
    seenPaths.add(relPosix);

    unpacked.push({
      relPath: `src-recovered/${relPosix}`,
      originalSource: mapObj.sources[i],
      sourceUrl,
      size: Buffer.byteLength(content, 'utf-8'),
    });
  }

  return unpacked;
}

/**
 * Resolve & unpack source maps from both captured `.map` responses and
 * `sourceMappingURL` directives embedded in downloaded JS/CSS bundles.
 */
async function recoverSourceMaps({ capturedAssets, savedScriptEntries, exportDir, downloadFn }) {
  const recoveredDir = path.join(exportDir, 'src-recovered');
  const seenPaths = new Set();
  const unpackedFiles = [];
  let mapsFound = 0;

  // 1. Direct `.map` responses captured over network
  for (const asset of capturedAssets) {
    if (asset.kind !== 'map') continue;
    try {
      const mapObj = JSON.parse(asset.buffer.toString('utf-8'));
      const items = unpackSourceMapObject(mapObj, asset.url, recoveredDir, seenPaths);
      if (items.length > 0) {
        mapsFound++;
        unpackedFiles.push(...items);
      }
    } catch {}
  }

  // 2. Parse `sourceMappingURL=` from captured/downloaded JS scripts
  const mapUrlRegex = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)/g;
  const checkedMapUrls = new Set(capturedAssets.filter((a) => a.kind === 'map').map((a) => a.url));

  for (const script of savedScriptEntries) {
    if (seenPaths.size >= MAX_RECOVERED_SOURCE_FILES) break;
    if (!script.content) continue;

    for (const match of script.content.matchAll(mapUrlRegex)) {
      const ref = match[1].trim();
      if (!ref) continue;

      if (ref.startsWith('data:')) {
        try {
          const commaIdx = ref.indexOf(',');
          if (commaIdx !== -1) {
            const meta = ref.slice(0, commaIdx);
            const rawData = ref.slice(commaIdx + 1);
            const jsonStr = meta.includes(';base64')
              ? Buffer.from(rawData, 'base64').toString('utf-8')
              : decodeURIComponent(rawData);
            const mapObj = JSON.parse(jsonStr);
            const items = unpackSourceMapObject(mapObj, script.absUrl, recoveredDir, seenPaths);
            if (items.length > 0) {
              mapsFound++;
              unpackedFiles.push(...items);
            }
          }
        } catch {}
        continue;
      }

      try {
        const absMapUrl = new URL(ref, script.absUrl).href;
        if (checkedMapUrls.has(absMapUrl)) continue;
        checkedMapUrls.add(absMapUrl);

        const tmpPath = path.join(exportDir, '.tmp_source_map.json');
        const res = await downloadFn(absMapUrl, tmpPath);
        if (res.ok && fs.existsSync(tmpPath)) {
          const mapObj = JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
          fs.unlinkSync(tmpPath);
          const items = unpackSourceMapObject(mapObj, absMapUrl, recoveredDir, seenPaths);
          if (items.length > 0) {
            mapsFound++;
            unpackedFiles.push(...items);
          }
        } else if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {}
    }
  }

  return { mapsFound, recoveredFiles: unpackedFiles };
}

/**
 * Balanced-brace extractor for complete `@keyframes` blocks and `cubic-bezier(...)` curves from raw CSS.
 */
function extractMotionFromCssTexts(cssTexts) {
  const keyframesMap = new Map();
  const curvesSet = new Set();
  const curveRegex = /cubic-bezier\(\s*[-+]?\d*\.?\d+\s*,\s*[-+]?\d*\.?\d+\s*,\s*[-+]?\d*\.?\d+\s*,\s*[-+]?\d*\.?\d+\s*\)/gi;

  for (const css of cssTexts) {
    if (!css || typeof css !== 'string') continue;

    for (const m of css.matchAll(curveRegex)) {
      curvesSet.add(m[0].replace(/\s+/g, ' ').trim());
    }

    const kfStartRegex = /@(?:-\w+-)?keyframes\s+([a-zA-Z0-9_-]+)\s*\{/g;
    let match;
    while ((match = kfStartRegex.exec(css)) !== null) {
      const name = match[1];
      let depth = 1;
      let idx = kfStartRegex.lastIndex;
      const startIdx = match.index;

      while (idx < css.length && depth > 0) {
        if (css[idx] === '{') depth++;
        else if (css[idx] === '}') depth--;
        idx++;
      }

      if (depth === 0 && !keyframesMap.has(name)) {
        keyframesMap.set(name, css.slice(startIdx, idx));
      }
      kfStartRegex.lastIndex = idx;
    }
  }

  return {
    keyframes: Array.from(keyframesMap.entries()).map(([name, rule]) => ({ name, rule })),
    curves: Array.from(curvesSet).slice(0, 24),
  };
}

/**
 * Inspect DOM for design tokens, motion primitives, SVGs, internal routes, and semantic layout sections.
 */
async function evaluateDeepDomData(page) {
  return page.evaluate(() => {
    const colors = new Set();
    const fonts = new Set();
    const cssVars = {};
    const domKeyframes = [];
    const domCurves = new Set();
    const animatedElements = [];

    // Collect root CSS custom properties
    try {
      const rootStyle = window.getComputedStyle(document.documentElement);
      for (let i = 0; i < rootStyle.length; i++) {
        const prop = rootStyle[i];
        if (prop.startsWith('--')) {
          const val = rootStyle.getPropertyValue(prop).trim();
          if (val && Object.keys(cssVars).length < 60) cssVars[prop] = val;
        }
      }
    } catch {}

    // Inspect accessible stylesheets for @keyframes
    try {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules || [])) {
            if (rule.type === CSSRule.KEYFRAMES_RULE) {
              domKeyframes.push({ name: rule.name, rule: rule.cssText });
            }
          }
        } catch {
          // Cross-origin stylesheet skipped here; captured in Node from CSS texts
        }
      }
    } catch {}

    // Collect colors, fonts & animated DOM nodes with semantic roles
    const colorBuckets = new Map();
    const recordColor = (raw, category) => {
      if (!raw || raw === 'transparent' || raw === 'rgba(0, 0, 0, 0)') return;
      const key = `${raw}::${category}`;
      colorBuckets.set(key, { raw, category, count: (colorBuckets.get(key)?.count || 0) + 1 });
    };

    const fontMap = new Map();
    const recordFont = (rawFamily, weight, fontStyle, isHeading) => {
      if (!rawFamily) return;
      const clean = rawFamily.split(',')[0].replace(/['"]/g, '').trim();
      if (!clean || /^(inherit|initial|unset)$/i.test(clean)) return;
      if (!fontMap.has(clean)) {
        fontMap.set(clean, { family: clean, weights: new Set(), styles: new Set(), headingHits: 0, bodyHits: 0 });
      }
      const entry = fontMap.get(clean);
      if (weight) entry.weights.add(String(weight));
      if (fontStyle && fontStyle !== 'normal') entry.styles.add(fontStyle);
      else entry.styles.add('normal');
      if (isHeading) entry.headingHits++;
      else entry.bodyHits++;
    };

    const fontLinks = [];
    for (const lnk of Array.from(document.querySelectorAll('link[rel="stylesheet"]'))) {
      const href = lnk.getAttribute('href');
      if (href && /fonts\.googleapis|typekit|fonts\.bunny|use\.fontawesome/i.test(href)) {
        try {
          fontLinks.push(new URL(href, window.location.href).href);
        } catch {}
      }
    }

    const bodyStyle = window.getComputedStyle(document.body);
    recordColor(bodyStyle.backgroundColor, 'Background');
    recordColor(bodyStyle.color, 'Text');
    recordFont(bodyStyle.fontFamily, bodyStyle.fontWeight, bodyStyle.fontStyle, false);

    const allEls = Array.from(document.querySelectorAll('*')).slice(0, 1200);
    for (const el of allEls) {
      const style = window.getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      const isHeading = /^h[1-6]$/.test(tag);
      const isAction = tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button';

      if (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        const bgCat = isAction ? 'Accent' : /^(body|main|section|header|footer)$/.test(tag) ? 'Background' : 'Surface';
        recordColor(style.backgroundColor, bgCat);
      }
      if (style.color) {
        recordColor(style.color, isAction && tag === 'a' ? 'Accent' : 'Text');
      }
      if (parseFloat(style.borderTopWidth) > 0 && style.borderTopColor) {
        recordColor(style.borderTopColor, 'Border');
      }
      if (style.fontFamily) {
        recordFont(style.fontFamily, style.fontWeight, style.fontStyle, isHeading);
      }

      const animName = style.animationName;
      const transDur = style.transitionDuration;
      const tfm = style.transform;
      const hasAnim = animName && animName !== 'none';
      const hasTrans = transDur && transDur !== '0s';

      if ((hasAnim || (hasTrans && style.transitionProperty !== 'all' && style.transitionProperty !== 'none')) && animatedElements.length < 40) {
        const tf = style.transitionTimingFunction || style.animationTimingFunction || '';
        if (tf.includes('cubic-bezier')) domCurves.add(tf);
        animatedElements.push({
          tag,
          id: el.id || null,
          className: typeof el.className === 'string' ? el.className.slice(0, 100) : null,
          animationName: hasAnim ? animName : null,
          animationDuration: hasAnim ? style.animationDuration : null,
          transitionProperty: hasTrans ? style.transitionProperty : null,
          transitionDuration: hasTrans ? transDur : null,
          timingFunction: tf,
          transform: tfm !== 'none' ? tfm : null,
        });
      }
    }

    for (const entry of fontMap.keys()) fonts.add(entry);
    for (const item of colorBuckets.values()) colors.add(item.raw);

    // Detect motion & 3D libraries in runtime
    const detectedLibraries = [];
    if (window.gsap) detectedLibraries.push('GSAP');
    if (window.Lenis) detectedLibraries.push('Lenis');
    if (window.lottie || document.querySelector('lottie-player, dotlottie-player')) detectedLibraries.push('Lottie');
    if (document.querySelector('[data-framer-appear-id], [data-framer-name]')) detectedLibraries.push('Framer Motion');
    if (document.querySelector('[data-aos]')) detectedLibraries.push('AOS');
    if (document.querySelector('[data-scroll], [data-scroll-section]')) detectedLibraries.push('Locomotive Scroll');
    if (window.THREE || document.querySelector('canvas')) detectedLibraries.push('Canvas / WebGL');
    if (document.querySelector('spline-viewer')) detectedLibraries.push('Spline 3D');

    // Collect inline SVGs
    const svgs = [];
    const seenSvg = new Set();
    for (const svg of Array.from(document.querySelectorAll('svg')).slice(0, 60)) {
      const markup = svg.outerHTML;
      if (markup && markup.length < 35000 && !seenSvg.has(markup)) {
        seenSvg.add(markup);
        svgs.push(markup);
        if (svgs.length >= 30) break;
      }
    }

    // Collect internal links & media URLs
    const origin = window.location.origin;
    const routes = new Set();
    for (const a of Array.from(document.querySelectorAll('a[href]')).slice(0, 200)) {
      try {
        const u = new URL(a.getAttribute('href'), origin);
        if (u.origin === origin && !u.pathname.match(/\.(png|jpg|jpeg|svg|pdf|zip|css|js)$/i)) {
          routes.add(u.pathname);
        }
      } catch {}
    }

    const mediaUrls = new Set();
    for (const el of Array.from(document.querySelectorAll('video, video source, link[rel="preload"], link[rel="modulepreload"]'))) {
      const src = el.getAttribute('src') || el.getAttribute('href');
      if (src && !src.startsWith('data:')) {
        try {
          mediaUrls.add(new URL(src, window.location.href).href);
        } catch {}
      }
    }

    // Extract top-level layout sections for TSX reconstruction
    const rawSections = [];
    const candidateSelectors = 'header, nav, main > section, main > div, body > section, article, footer';
    const picked = new Set();

    for (const el of Array.from(document.querySelectorAll(candidateSelectors))) {
      // Skip tiny hidden containers or nested descendants already inside a picked section
      const rect = el.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 40) continue;
      let insidePicked = false;
      for (const p of picked) {
        if (p.contains(el)) {
          insidePicked = true;
          break;
        }
      }
      if (insidePicked) continue;
      picked.add(el);

      const cs = window.getComputedStyle(el);
      const heading = el.querySelector('h1, h2, h3');

      const clone = el.cloneNode(true);
      clone.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
      clone.querySelectorAll('svg').forEach((s) => {
        if (s.outerHTML.length > 1500) {
          const placeholder = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          placeholder.setAttribute('data-extracted-icon', 'true');
          if (s.getAttribute('viewBox')) placeholder.setAttribute('viewBox', s.getAttribute('viewBox'));
          if (s.getAttribute('class')) placeholder.setAttribute('class', s.getAttribute('class'));
          s.replaceWith(placeholder);
        }
      });

      let snapshot = clone.outerHTML;
      if (snapshot.length > 24000) {
        // Keep only the top children until threshold to preserve valid closing tags
        const shell = clone.cloneNode(false);
        let acc = '';
        for (const child of Array.from(clone.children)) {
          if (acc.length + child.outerHTML.length > 20000) break;
          acc += child.outerHTML;
        }
        shell.innerHTML = acc || (heading ? heading.outerHTML : '');
        snapshot = shell.outerHTML;
      }

      rawSections.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        dataName: el.getAttribute('data-framer-name') || el.getAttribute('aria-label') || null,
        headingText: heading ? heading.textContent.trim().slice(0, 80) : null,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        styles: {
          backgroundColor: cs.backgroundColor,
          color: cs.color,
          display: cs.display,
          padding: cs.padding,
          borderRadius: cs.borderRadius,
        },
        htmlSnapshot: snapshot,
      });

      if (rawSections.length >= 12) break;
    }

    // Fallback semantic elements for compatibility
    const components = [];
    ['header', 'nav', 'main', 'section', 'article', 'footer', 'form', 'button'].forEach((tag) => {
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
      rawColorObservations: Array.from(colorBuckets.values()),
      rawFontObservations: Array.from(fontMap.values()).map((f) => ({
        family: f.family,
        weights: Array.from(f.weights),
        styles: Array.from(f.styles),
        headingHits: f.headingHits,
        bodyHits: f.bodyHits,
      })),
      fontLinks,
      cssVars,
      componentsCount: components.length,
      components,
      domKeyframes,
      domCurves: Array.from(domCurves).slice(0, 12),
      animatedElements,
      detectedLibraries,
      inlineSvgs: svgs,
      internalRoutes: Array.from(routes).slice(0, 50),
      mediaUrls: Array.from(mediaUrls).slice(0, 40),
      rawSections,
    };
  });
}

function cssStringToJsxStyleObject(styleText) {
  const entries = [];
  for (const decl of styleText.split(';')) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx === -1) continue;
    const rawProp = decl.slice(0, colonIdx).trim();
    const rawVal = decl.slice(colonIdx + 1).trim();
    if (!rawProp || !rawVal) continue;

    const escapedVal = rawVal.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    if (rawProp.startsWith('--')) {
      entries.push(`'${rawProp}': '${escapedVal}'`);
    } else {
      const camelProp = rawProp
        .toLowerCase()
        .replace(/^-ms-/, 'ms-')
        .replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      entries.push(`${camelProp}: '${escapedVal}'`);
    }
  }
  return entries.length > 0 ? `{{ ${entries.join(', ')} } as React.CSSProperties}` : '{}';
}

const ATTR_RENAME_MAP = {
  class: 'className',
  for: 'htmlFor',
  tabindex: 'tabIndex',
  readonly: 'readOnly',
  maxlength: 'maxLength',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  srcset: 'srcSet',
  crossorigin: 'crossOrigin',
  autocomplete: 'autoComplete',
  autofocus: 'autoFocus',
  frameborder: 'frameBorder',
  allowfullscreen: 'allowFullScreen',
  playsinline: 'playsInline',
  viewbox: 'viewBox',
  preserveaspectratio: 'preserveAspectRatio',
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset',
  'stroke-miterlimit': 'strokeMiterlimit',
  'stroke-opacity': 'strokeOpacity',
  'fill-rule': 'fillRule',
  'fill-opacity': 'fillOpacity',
  'clip-rule': 'clipRule',
  'clip-path': 'clipPath',
  'stop-color': 'stopColor',
  'stop-opacity': 'stopOpacity',
  'gradientunits': 'gradientUnits',
  'gradienttransform': 'gradientTransform',
  'xlink:href': 'xlinkHref',
  'aria-hidden': 'aria-hidden',
};

/**
 * Convert raw HTML section fragment into valid React TSX JSX markup.
 */
function htmlToSafeJsx(html) {
  if (!html) return '<div />';

  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+xmlns:xlink\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');

  // Convert inline style="..." to JSX object literal
  out = out.replace(/\sstyle\s*=\s*"([^"]*)"/gi, (_, cssText) => ` style=${cssStringToJsxStyleObject(cssText)}`);
  out = out.replace(/\sstyle\s*=\s*'([^']*)'/gi, (_, cssText) => ` style=${cssStringToJsxStyleObject(cssText)}`);

  // Rename HTML/SVG attributes to JSX camelCase equivalents
  for (const [htmlAttr, jsxAttr] of Object.entries(ATTR_RENAME_MAP)) {
    if (htmlAttr === jsxAttr) continue;
    const attrRe = new RegExp(`(\\s)${htmlAttr}(\\s*=)`, 'gi');
    out = out.replace(attrRe, `$1${jsxAttr}$2`);
  }

  // Self-close void HTML/SVG elements that lack trailing slash
  const voidTags = ['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line', 'polygon', 'polyline', 'ellipse', 'use'];
  const voidRe = new RegExp(`<(${voidTags.join('|')})([^>]*?)(?<!/)>`, 'gi');
  out = out.replace(voidRe, '<$1$2 />');

  // Escape literal curly braces inside plain text nodes (between `>` and `<`)
  out = out.replace(/>([^<]+)</g, (_, text) => {
    const safeText = text.replace(/\{/g, "{'{'}").replace(/\}/g, "{'}'}");
    return `>${safeText}<`;
  });

  return out;
}

function makePascalIdentifier(raw, fallback) {
  const cleaned = String(raw || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
  if (!cleaned || /^\d/.test(cleaned)) return fallback;
  return cleaned;
}

/**
 * Generate modular `.tsx` components, `motion/animations.css`, `tokens.ts`, `tailwind.config.ts`,
 * and `EXPORT_REPORT.md` inside the export directory.
 */
function writeTsxAndMotionWorkspace({
  exportDir,
  domain,
  platform,
  extractedData,
  motionData,
  sourceMapReport,
  savedAssetsSummary,
  urlToLocalMap = new Map(),
}) {
  const motionDir = path.join(exportDir, 'motion');
  const compDir = path.join(exportDir, 'components');
  fs.mkdirSync(motionDir, { recursive: true });
  fs.mkdirSync(compDir, { recursive: true });

  const createdFiles = [];

  // 1. motion/animations.css
  const easeVars = (motionData.curves || [])
    .map((c, idx) => `  --ease-extracted-${idx + 1}: ${c};`)
    .join('\n');

  const keyframesBlock = (motionData.keyframes || [])
    .map((k) => k.rule)
    .join('\n\n');

  const animationsCss = [
    `/* Extracted Motion & Keyframes from ${domain} */`,
    `:root {\n${easeVars || '  --ease-extracted-1: cubic-bezier(0.22, 1, 0.36, 1);'}\n}`,
    '',
    '.reveal-motion {',
    '  opacity: 0;',
    '  transform: translateY(18px);',
    '  transition: opacity 0.6s var(--ease-extracted-1, cubic-bezier(0.22, 1, 0.36, 1)), transform 0.6s var(--ease-extracted-1, cubic-bezier(0.22, 1, 0.36, 1));',
    '}',
    '.reveal-motion.is-visible {',
    '  opacity: 1;',
    '  transform: translateY(0);',
    '}',
    '',
    keyframesBlock || '/* No external @keyframes detected */',
    '',
  ].join('\n');

  const animCssPath = path.join(motionDir, 'animations.css');
  fs.writeFileSync(animCssPath, animationsCss, 'utf-8');
  createdFiles.push({ fileName: 'animations.css', folderPath: 'motion/animations.css', size: fs.statSync(animCssPath).size });

  // 2. motion/motion-blueprint.json
  const motionBlueprintPath = path.join(motionDir, 'motion-blueprint.json');
  fs.writeFileSync(
    motionBlueprintPath,
    JSON.stringify(
      {
        domain,
        platform,
        detectedLibraries: extractedData.detectedLibraries || [],
        easingCurves: motionData.curves || [],
        keyframesCount: (motionData.keyframes || []).length,
        keyframeNames: (motionData.keyframes || []).map((k) => k.name),
        animatedElements: extractedData.animatedElements || [],
      },
      null,
      2
    ),
    'utf-8'
  );
  createdFiles.push({ fileName: 'motion-blueprint.json', folderPath: 'motion/motion-blueprint.json', size: fs.statSync(motionBlueprintPath).size });

  // 3. components/tokens.ts
  const tokensTsPath = path.join(compDir, 'tokens.ts');
  const tokensContent = [
    `// Design System Tokens extracted from ${domain}`,
    `export const designTokens = ${JSON.stringify(
      {
        colors: extractedData.colors || [],
        fonts: extractedData.fonts || [],
        cssVariables: extractedData.cssVars || {},
        easingCurves: motionData.curves || [],
        detectedLibraries: extractedData.detectedLibraries || [],
      },
      null,
      2
    )} as const;\n`,
  ].join('\n');
  fs.writeFileSync(tokensTsPath, tokensContent, 'utf-8');
  createdFiles.push({ fileName: 'tokens.ts', folderPath: 'components/tokens.ts', size: fs.statSync(tokensTsPath).size });

  // 4. components/MotionPrimitives.tsx
  const motionPrimitivesPath = path.join(compDir, 'MotionPrimitives.tsx');
  const motionPrimitivesContent = `import React, { useEffect, useRef, useState } from 'react';
import { designTokens } from './tokens';

export interface RevealSectionProps {
  children: React.ReactNode;
  className?: string;
  delayMs?: number;
}

export const EASING_PRESETS = designTokens.easingCurves;

export const RevealSection: React.FC<RevealSectionProps> = ({
  children,
  className = '',
  delayMs = 0,
}) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.12 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={\`reveal-motion \${visible ? 'is-visible' : ''} \${className}\`.trim()}
      style={{ transitionDelay: \`\${delayMs}ms\` }}
    >
      {children}
    </div>
  );
};
`;
  fs.writeFileSync(motionPrimitivesPath, motionPrimitivesContent, 'utf-8');
  createdFiles.push({ fileName: 'MotionPrimitives.tsx', folderPath: 'components/MotionPrimitives.tsx', size: fs.statSync(motionPrimitivesPath).size });

  // 5. Modular section .tsx files
  const sections = extractedData.rawSections || [];
  const componentNames = [];
  const usedNames = new Set();

  sections.forEach((sec, idx) => {
    const labelSource = sec.dataName || sec.id || sec.headingText || sec.tag;
    let baseName = makePascalIdentifier(labelSource, `Section${idx + 1}`);
    if (!baseName.endsWith('Section') && idx > 0) baseName = `${baseName}Section`;
    if (usedNames.has(baseName)) baseName = `${baseName}${idx + 1}`;
    usedNames.add(baseName);

    const fileName = `Section_${String(idx + 1).padStart(2, '0')}_${baseName}.tsx`;
    let snapshotWithLocalAssets = sec.htmlSnapshot || `<${sec.tag} />`;
    for (const [absUrl, relPath] of urlToLocalMap.entries()) {
      if (snapshotWithLocalAssets.includes(absUrl)) {
        snapshotWithLocalAssets = snapshotWithLocalAssets.split(absUrl).join(`../${relPath}`);
      }
    }
    const safeJsx = htmlToSafeJsx(snapshotWithLocalAssets);

    const tsxCode = `import React from 'react';
import { RevealSection } from './MotionPrimitives';

export interface ${baseName}Props {
  className?: string;
}

export const ${baseName}: React.FC<${baseName}Props> = ({ className = '' }) => {
  return (
    <RevealSection delayMs={${idx * 75}} className={className}>
      {/* Reconstructed from <${sec.tag}> (${sec.width}x${sec.height}px) */}
      ${safeJsx}
    </RevealSection>
  );
};

export default ${baseName};
`;
    const compPath = path.join(compDir, fileName);
    fs.writeFileSync(compPath, tsxCode, 'utf-8');
    componentNames.push({ baseName, fileName: fileName.replace(/\.tsx$/, '') });
    createdFiles.push({ fileName, folderPath: `components/${fileName}`, size: fs.statSync(compPath).size });
  });

  // 6. components/ExtractedPage.tsx
  const imports = componentNames.map((c) => `import { ${c.baseName} } from './${c.fileName}';`).join('\n');
  const usages = componentNames.map((c) => `      <${c.baseName} />`).join('\n');
  const pageTsx = `import React from 'react';
import '../motion/animations.css';
${imports}

export const ExtractedPage: React.FC = () => {
  return (
    <div className="extracted-page-root">
${usages || '      <main />'}
    </div>
  );
};

export default ExtractedPage;
`;
  const pageTsxPath = path.join(compDir, 'ExtractedPage.tsx');
  fs.writeFileSync(pageTsxPath, pageTsx, 'utf-8');
  createdFiles.push({ fileName: 'ExtractedPage.tsx', folderPath: 'components/ExtractedPage.tsx', size: fs.statSync(pageTsxPath).size });

  // 7. tailwind.config.ts
  const colorEntries = Object.fromEntries((extractedData.colors || []).slice(0, 12).map((c, i) => [`extracted-${i + 1}`, c]));
  const twConfig = `import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./components/**/*.{ts,tsx}', './src-recovered/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        primary: ${JSON.stringify(extractedData.fonts || ['sans-serif'])},
      },
      colors: ${JSON.stringify(colorEntries, null, 6)},
      transitionTimingFunction: ${JSON.stringify(
        Object.fromEntries((motionData.curves || []).slice(0, 6).map((c, i) => [`extracted-${i + 1}`, c])),
        null,
        6
      )},
    },
  },
  plugins: [],
};

export default config;
`;
  const twPath = path.join(exportDir, 'tailwind.config.ts');
  fs.writeFileSync(twPath, twConfig, 'utf-8');
  createdFiles.push({ fileName: 'tailwind.config.ts', folderPath: 'tailwind.config.ts', size: fs.statSync(twPath).size });

  // 8. EXPORT_REPORT.md
  const reportMd = `# Export Blueprint: ${domain}

- **Detected Stack:** ${platform}
- **Detected Motion / 3D Libraries:** ${(extractedData.detectedLibraries || []).join(', ') || 'None detected'}
- **Source Maps Found:** ${sourceMapReport.mapsFound} (${sourceMapReport.recoveredFiles.length} original files unpacked to \`src-recovered/\`)
- **Reconstructed TSX Components:** ${componentNames.length} sections generated in \`components/\`
- **Extracted Keyframes:** ${(motionData.keyframes || []).length} rules in \`motion/animations.css\`
- **Network Assets Captured:** ${JSON.stringify(savedAssetsSummary)}

## Folder Guide
- \`index.html\` & \`assets/\`: Standalone offline browser clone (HTML, CSS, JS chunks, images, fonts, SVGs, Lottie/video).
- \`src-recovered/\`: **Original** TypeScript/TSX/CSS source files unpacked from public Source Maps (\`.js.map\`), if exposed by target server.
- \`components/\`: **Reconstructed** React TypeScript (\`.tsx\`) section components + \`tokens.ts\` + \`MotionPrimitives.tsx\`.
- \`motion/\`: Extracted \`@keyframes\`, cubic-bezier curves, and runtime animation telemetry.
- \`rea-blueprint/\`: Raw CDP inspection, JS bundle inventory, internal routes, and semantic DOM tokens.
`;
  const reportPath = path.join(exportDir, 'EXPORT_REPORT.md');
  fs.writeFileSync(reportPath, reportMd, 'utf-8');
  createdFiles.push({ fileName: 'EXPORT_REPORT.md', folderPath: 'EXPORT_REPORT.md', size: fs.statSync(reportPath).size });

  return createdFiles;
}

function parseColorToHexAndRgb(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();

  // hex #RGB, #RRGGBB, #RRGGBBAA
  const hexMatch = s.match(/^#([0-9a-f]{3,8})$/i);
  if (hexMatch) {
    let h = hexMatch[1];
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    } else if (h.length === 8) {
      if (parseInt(h.slice(6, 8), 16) === 0) return null;
      h = h.slice(0, 6);
    } else if (h.length !== 6) {
      return null;
    }
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return { hex: `#${h.toUpperCase()}`, rgb: `rgb(${r}, ${g}, ${b})`, rgbTuple: `${r}, ${g}, ${b}` };
  }

  // rgb(...) or rgba(...)
  const rgbMatch = s.match(/^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
  if (rgbMatch) {
    const r = Math.max(0, Math.min(255, parseInt(rgbMatch[1], 10)));
    const g = Math.max(0, Math.min(255, parseInt(rgbMatch[2], 10)));
    const b = Math.max(0, Math.min(255, parseInt(rgbMatch[3], 10)));
    const a = rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1;
    if (a === 0) return null;
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    return { hex, rgb: `rgb(${r}, ${g}, ${b})`, rgbTuple: `${r}, ${g}, ${b}` };
  }

  return null;
}

const CATEGORY_PRIORITY = { Accent: 5, Primary: 5, Background: 4, Surface: 3, Text: 2, Border: 1 };

/**
 * Aggregate deduplicated Color Palette & Font Library metadata from DOM + downloaded CSS.
 */
function buildColorsAndFontsCatalog({ extractedElements, cssTexts, pageUrl, urlToLocalMap }) {
  const colorByHex = new Map();

  for (const obs of extractedElements.rawColorObservations || []) {
    const parsed = parseColorToHexAndRgb(obs.raw);
    if (!parsed) continue;
    const existing = colorByHex.get(parsed.hex);
    if (!existing) {
      colorByHex.set(parsed.hex, {
        ...parsed,
        category: obs.category || 'Surface',
        count: obs.count || 1,
      });
    } else {
      existing.count += obs.count || 1;
      if ((CATEGORY_PRIORITY[obs.category] || 0) > (CATEGORY_PRIORITY[existing.category] || 0)) {
        existing.category = obs.category;
      }
    }
  }

  // Also scan raw CSS texts for explicit hex declarations if not yet seen
  const hexInCssRe = /#[0-9a-fA-F]{6}\b/g;
  for (const css of cssTexts || []) {
    if (!css) continue;
    for (const m of css.matchAll(hexInCssRe)) {
      const parsed = parseColorToHexAndRgb(m[0]);
      if (!parsed) continue;
      if (!colorByHex.has(parsed.hex)) {
        colorByHex.set(parsed.hex, { ...parsed, category: 'CSS Token', count: 1 });
      } else {
        colorByHex.get(parsed.hex).count++;
      }
    }
  }

  const colorsDetailed = Array.from(colorByHex.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 32);

  // Assign Primary / Secondary / Accent refinements for top prominent non-neutral accents
  let primaryAssigned = false;
  let secondaryAssigned = false;
  for (const item of colorsDetailed) {
    if (item.category === 'Accent') {
      if (!primaryAssigned) {
        item.category = 'Primary';
        primaryAssigned = true;
      } else if (!secondaryAssigned) {
        item.category = 'Secondary';
        secondaryAssigned = true;
      }
    }
  }

  // Parse @font-face declarations across CSS texts
  const fontFaceMap = new Map();
  const fontFaceRe = /@font-face\s*\{([^}]+)\}/gi;
  for (const css of cssTexts || []) {
    if (!css) continue;
    for (const m of css.matchAll(fontFaceRe)) {
      const block = m[1];
      const famMatch = block.match(/font-family\s*:\s*([^;]+)/i);
      if (!famMatch) continue;
      const family = famMatch[1].replace(/['"]/g, '').trim();
      if (!family) continue;
      const weightMatch = block.match(/font-weight\s*:\s*([^;]+)/i);
      const styleMatch = block.match(/font-style\s*:\s*([^;]+)/i);
      const urls = Array.from(block.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)).map((u) => u[1].trim());

      if (!fontFaceMap.has(family)) {
        fontFaceMap.set(family, { weights: new Set(), styles: new Set(), urls: new Set(), rules: [] });
      }
      const entry = fontFaceMap.get(family);
      if (weightMatch) entry.weights.add(weightMatch[1].trim());
      if (styleMatch) entry.styles.add(styleMatch[1].trim());
      urls.forEach((u) => entry.urls.add(u));
      if (entry.rules.length < 4) entry.rules.push(`@font-face { ${block.trim()} }`);
    }
  }

  const localFontFiles = Array.from(urlToLocalMap ? urlToLocalMap.entries() : []).filter(([, rel]) =>
    rel.startsWith('assets/fonts/')
  );

  const fontEntriesMap = new Map();
  for (const obs of extractedElements.rawFontObservations || []) {
    fontEntriesMap.set(obs.family, {
      family: obs.family,
      role: obs.headingHits > 0 && obs.bodyHits === 0 ? 'Display / Heading' : obs.headingHits >= obs.bodyHits ? 'Primary' : 'Body / Secondary',
      weights: new Set(obs.weights || []),
      styles: new Set(obs.styles || ['normal']),
      sourceType: 'declared-only',
      sourceUrl: null,
      localFiles: [],
      fontFaceCss: null,
    });
  }

  for (const [family, ff] of fontFaceMap.entries()) {
    if (!fontEntriesMap.has(family)) {
      fontEntriesMap.set(family, {
        family,
        role: 'Declared (@font-face)',
        weights: new Set(),
        styles: new Set(['normal']),
        sourceType: 'declared-only',
        sourceUrl: null,
        localFiles: [],
        fontFaceCss: null,
      });
    }
    const target = fontEntriesMap.get(family);
    ff.weights.forEach((w) => target.weights.add(w));
    ff.styles.forEach((s) => target.styles.add(s));
    target.fontFaceCss = ff.rules.join('\n');

    for (const rawUrl of ff.urls) {
      if (rawUrl.startsWith('data:')) continue;
      try {
        const abs = new URL(rawUrl, pageUrl).href;
        const localRel = urlToLocalMap && urlToLocalMap.get(abs);
        if (localRel && localRel.startsWith('assets/fonts/')) {
          if (!target.localFiles.includes(localRel)) target.localFiles.push(localRel);
          target.sourceType = 'extracted-file';
        } else if (!target.sourceUrl) {
          target.sourceUrl = abs;
          if (target.sourceType !== 'extracted-file') target.sourceType = 'external-stylesheet';
        }
      } catch {}
    }
  }

  // Fallback match external font stylesheet links (e.g. Google Fonts)
  const extFontLinks = extractedElements.fontLinks || [];
  for (const entry of fontEntriesMap.values()) {
    if (entry.sourceType === 'declared-only' && extFontLinks.length > 0) {
      const matchingLink = extFontLinks.find((lnk) => lnk.toLowerCase().includes(encodeURIComponent(entry.family).toLowerCase().replace(/%20/g, '+')));
      if (matchingLink) {
        entry.sourceType = 'external-stylesheet';
        entry.sourceUrl = matchingLink;
      }
    }
    // Check if local font filename contains family stem
    if (entry.localFiles.length === 0 && localFontFiles.length > 0) {
      const stem = entry.family.toLowerCase().replace(/[^a-z0-9]/g, '');
      const matchedLocal = localFontFiles.filter(([, rel]) => rel.toLowerCase().replace(/[^a-z0-9]/g, '').includes(stem));
      if (matchedLocal.length > 0) {
        entry.localFiles = matchedLocal.map(([, rel]) => rel);
        entry.sourceType = 'extracted-file';
      }
    }
  }

  const fontsDetailed = Array.from(fontEntriesMap.values())
    .map((f) => ({
      family: f.family,
      role: f.role,
      weights: Array.from(f.weights).sort(),
      styles: Array.from(f.styles),
      sourceType: f.sourceType,
      sourceUrl: f.sourceUrl,
      localFiles: f.localFiles,
      fontFaceCss: f.fontFaceCss,
    }))
    .slice(0, 16);

  return {
    colorsDetailed,
    fontsDetailed,
    colorsHexList: colorsDetailed.map((c) => c.hex),
  };
}

function routeToSafeSlug(routePath) {
  const clean = String(routePath || '')
    .split('?')[0]
    .split('#')[0]
    .replace(/^\/+|\/+$/g, '');
  if (!clean) return 'home';
  return clean
    .split('/')
    .map((seg) => seg.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48))
    .filter(Boolean)
    .join('/');
}

/**
 * Filter captured same-origin internal links into safe crawlable sub-pages.
 */
function selectCrawlableRoutes(routes, maxRoutes = 4) {
  if (!Array.isArray(routes)) return [];
  const skipRe = /^\/(api|downloads|cdn-cgi|_next|_nuxt|static|assets|login|logout|signin|signup|register|cart|checkout|admin|wp-admin|wp-login)\b/i;
  const seen = new Set();
  const picked = [];

  const sorted = [...routes]
    .filter((r) => typeof r === 'string' && r.startsWith('/') && r !== '/' && !skipRe.test(r))
    .sort((a, b) => a.length - b.length);

  for (const r of sorted) {
    const cleanRoute = r.split('#')[0].replace(/\/+$/, '') || '/';
    if (cleanRoute === '/' || seen.has(cleanRoute)) continue;
    const slug = routeToSafeSlug(cleanRoute);
    if (!slug || slug === 'home' || seen.has(slug)) continue;
    seen.add(cleanRoute);
    seen.add(slug);
    picked.push({
      routePath: cleanRoute,
      slug,
      relOutputPath: `pages/${slug}/index.html`,
    });
    if (picked.length >= maxRoutes) break;
  }

  return picked;
}

/**
 * Safely simulate hover & click triggers on menus, tabs, accordions, and details elements
 * before DOM capture so lazy/hidden interactive states are revealed without navigating away.
 */
async function simulateUiInteractions(page) {
  const startUrl = page.url().split('#')[0];
  const actions = [];
  let hoveredCount = 0;
  let clickedCount = 0;

  const visibleBefore = await page
    .evaluate(() => document.querySelectorAll('*:not(script):not(style)').length)
    .catch(() => 0);

  // 1. Hover top nav items to trigger CSS/JS hover menus
  try {
    const hoverHandles = await page.$$('header nav a, header nav button, nav li');
    for (const handle of hoverHandles.slice(0, 6)) {
      try {
        const box = await handle.boundingBox();
        if (!box || box.width === 0 || box.height === 0) continue;
        await handle.hover({ timeout: 800 });
        hoveredCount++;
        const label = (await handle.innerText().catch(() => '')).trim().slice(0, 40);
        actions.push({ type: 'hover', label: label || 'nav-item' });
        await page.waitForTimeout(80);
      } catch {}
    }
  } catch {}

  // 2. Click safe non-navigational triggers (accordions, tabs, aria-expanded dropdowns)
  const dangerousRe = /submit|delete|remove|buy|checkout|pay|sign|log|cart|subscribe|download|close|dismiss/i;
  const triggerSelector = [
    'details:not([open]) > summary',
    '[role="tab"]:not([aria-selected="true"])',
    'button[aria-expanded="false"]',
    'button[data-state="closed"]',
  ].join(', ');

  try {
    const handles = await page.$$(triggerSelector);
    for (const handle of handles.slice(0, 8)) {
      try {
        const meta = await handle.evaluate((el) => {
          const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
          const isSubmit = el.tagName === 'BUTTON' && el.getAttribute('type') === 'submit';
          const hasHref = el.tagName === 'A' || !!el.closest('a[href]');
          const rect = el.getBoundingClientRect();
          return { text, isSubmit, hasHref, visible: rect.width > 0 && rect.height > 0 };
        });

        if (!meta.visible || meta.isSubmit || meta.hasHref || dangerousRe.test(meta.text)) continue;

        await handle.click({ timeout: 1000 });
        clickedCount++;
        actions.push({ type: 'click', label: meta.text.slice(0, 40) || 'interactive-trigger' });
        await page.waitForTimeout(110);

        // Guard: if a click somehow caused page navigation, return immediately
        if (page.url().split('#')[0] !== startUrl) {
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
          break;
        }
      } catch {}
    }
  } catch {}

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(250);

  const visibleAfter = await page
    .evaluate(() => document.querySelectorAll('*:not(script):not(style)').length)
    .catch(() => visibleBefore);

  return {
    hoveredCount,
    clickedCount,
    domNodesBefore: visibleBefore,
    domNodesAfter: visibleAfter,
    newlyAddedNodes: Math.max(0, visibleAfter - visibleBefore),
    actions,
  };
}

function getDirByteSize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    total += entry.isDirectory() ? getDirByteSize(full) : fs.statSync(full).size;
  }
  return total;
}

/**
 * Generate a standalone runnable React + Vite + Tailwind + TSX project under `react-vite-app/`.
 */
function writeViteReactProject({ exportDir, domain, extractedData, motionData, crawledPages = [], urlToLocalMap = new Map() }) {
  const viteDir = path.join(exportDir, 'react-vite-app');
  const viteSrcDir = path.join(viteDir, 'src');
  const viteCompDir = path.join(viteSrcDir, 'components');
  const viteMotionDir = path.join(viteSrcDir, 'motion');
  const vitePublicAssetsDir = path.join(viteDir, 'public', 'assets');

  [viteDir, viteSrcDir, viteCompDir, viteMotionDir].forEach((d) => fs.mkdirSync(d, { recursive: true }));

  const createdFiles = [];
  const safeSlugName = String(domain || 'extracted-site')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'extracted-site';

  // Copy components/* -> react-vite-app/src/components/* (rewrite ../assets/ to /assets/)
  const rootCompDir = path.join(exportDir, 'components');
  if (fs.existsSync(rootCompDir)) {
    for (const file of fs.readdirSync(rootCompDir)) {
      const srcFile = path.join(rootCompDir, file);
      if (!fs.statSync(srcFile).isFile()) continue;
      let code = fs.readFileSync(srcFile, 'utf-8');
      code = code.replace(/\.\.\/assets\//g, '/assets/');
      const destFile = path.join(viteCompDir, file);
      fs.writeFileSync(destFile, code, 'utf-8');
    }
  }

  // Copy motion/* -> react-vite-app/src/motion/*
  const rootMotionDir = path.join(exportDir, 'motion');
  if (fs.existsSync(rootMotionDir)) {
    for (const file of fs.readdirSync(rootMotionDir)) {
      const srcFile = path.join(rootMotionDir, file);
      if (!fs.statSync(srcFile).isFile()) continue;
      fs.copyFileSync(srcFile, path.join(viteMotionDir, file));
    }
  }

  // Copy assets/ -> react-vite-app/public/assets/ when total <= 20 MB so public/assets works standalone
  const rootAssetsDir = path.join(exportDir, 'assets');
  let copiedPublicAssets = false;
  if (fs.existsSync(rootAssetsDir) && getDirByteSize(rootAssetsDir) <= 20 * 1024 * 1024) {
    fs.cpSync(rootAssetsDir, vitePublicAssetsDir, { recursive: true });
    copiedPublicAssets = true;
  }

  // 1. package.json
  const pkgJson = {
    name: `${safeSlugName}-vite-clone`,
    private: true,
    version: '1.0.0',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'tsc && vite build',
      preview: 'vite preview',
    },
    dependencies: {
      react: '^18.3.1',
      'react-dom': '^18.3.1',
    },
    devDependencies: {
      '@types/react': '^18.3.12',
      '@types/react-dom': '^18.3.5',
      '@vitejs/plugin-react': '^4.3.4',
      autoprefixer: '^10.4.20',
      postcss: '^8.4.49',
      tailwindcss: '^3.4.15',
      typescript: '^5.6.3',
      vite: '^6.0.1',
    },
  };
  const pkgPath = path.join(viteDir, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2), 'utf-8');
  createdFiles.push({ fileName: 'package.json', folderPath: 'react-vite-app/package.json', size: fs.statSync(pkgPath).size });

  // 2. vite.config.ts
  const viteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
  },
});
`;
  const viteCfgPath = path.join(viteDir, 'vite.config.ts');
  fs.writeFileSync(viteCfgPath, viteConfig, 'utf-8');
  createdFiles.push({ fileName: 'vite.config.ts', folderPath: 'react-vite-app/vite.config.ts', size: fs.statSync(viteCfgPath).size });

  // 3. tsconfig.json
  const tsConfig = {
    compilerOptions: {
      target: 'ES2020',
      useDefineForClassFields: true,
      lib: ['ES2020', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      skipLibCheck: true,
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      isolatedModules: true,
      noEmit: true,
      jsx: 'react-jsx',
      strict: false,
    },
    include: ['src'],
  };
  const tsCfgPath = path.join(viteDir, 'tsconfig.json');
  fs.writeFileSync(tsCfgPath, JSON.stringify(tsConfig, null, 2), 'utf-8');
  createdFiles.push({ fileName: 'tsconfig.json', folderPath: 'react-vite-app/tsconfig.json', size: fs.statSync(tsCfgPath).size });

  // 4. postcss.config.js & tailwind.config.ts
  fs.writeFileSync(
    path.join(viteDir, 'postcss.config.js'),
    `export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n};\n`,
    'utf-8'
  );
  const rootTwPath = path.join(exportDir, 'tailwind.config.ts');
  if (fs.existsSync(rootTwPath)) {
    const twContent = fs.readFileSync(rootTwPath, 'utf-8').replace('./components/**/*.{ts,tsx}', './src/components/**/*.{ts,tsx}');
    fs.writeFileSync(path.join(viteDir, 'tailwind.config.ts'), twContent, 'utf-8');
  }

  // 5. index.html
  const fontLinksHtml = (extractedData.fontLinks || [])
    .slice(0, 4)
    .map((u) => `    <link rel="stylesheet" href="${u}" />`)
    .join('\n');
  const viteIndexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${(extractedData.title || domain || 'Extracted App').replace(/[<>]/g, '')}</title>
${fontLinksHtml}
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
  const viteHtmlPath = path.join(viteDir, 'index.html');
  fs.writeFileSync(viteHtmlPath, viteIndexHtml, 'utf-8');
  createdFiles.push({ fileName: 'index.html', folderPath: 'react-vite-app/index.html', size: fs.statSync(viteHtmlPath).size });

  // 6. src/index.css & src/main.tsx & src/App.tsx
  fs.writeFileSync(
    path.join(viteSrcDir, 'index.css'),
    `@import './motion/animations.css';\n\n@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`,
    'utf-8'
  );
  fs.writeFileSync(
    path.join(viteSrcDir, 'main.tsx'),
    `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\nimport './index.css';\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n);\n`,
    'utf-8'
  );

  // Create SubPage_*.tsx components when sub-pages were crawled
  const subPageModules = [];
  for (const cp of crawledPages) {
    if (!cp.sections || cp.sections.length === 0) continue;
    const compName = `Page_${makePascalIdentifier(cp.slug, 'SubPage')}`;
    const subFile = `${compName}.tsx`;
    const bodyJsx = cp.sections
      .slice(0, 4)
      .map((s) => {
        let html = s.htmlSnapshot || `<${s.tag} />`;
        for (const [absUrl, relPath] of urlToLocalMap.entries()) {
          if (html.includes(absUrl)) {
            html = html.split(absUrl).join(`/${relPath}`);
          }
        }
        return htmlToSafeJsx(html);
      })
      .join('\n      ');
    const subCode = `import React from 'react';
import { RevealSection } from './MotionPrimitives';

export const ${compName}: React.FC = () => {
  return (
    <RevealSection>
      ${bodyJsx}
    </RevealSection>
  );
};
`;
    fs.writeFileSync(path.join(viteCompDir, subFile), subCode, 'utf-8');
    subPageModules.push({ routePath: cp.routePath, compName, fileStem: compName });
  }

  const subImports = subPageModules.map((m) => `import { ${m.compName} } from './components/${m.fileStem}';`).join('\n');
  const navSwitcher =
    subPageModules.length > 0
      ? `
      <nav style={{ display: 'flex', gap: 8, padding: '10px 16px', background: '#0f172a', color: '#fff', fontSize: 13 }}>
        <button onClick={() => setRoute('/')} style={{ fontWeight: route === '/' ? 700 : 400 }}>/</button>
        ${subPageModules
          .map((m) => `<button onClick={() => setRoute('${m.routePath}')} style={{ fontWeight: route === '${m.routePath}' ? 700 : 400 }}>${m.routePath}</button>`)
          .join('\n        ')}
      </nav>`
      : '';

  const routeBranches =
    subPageModules.length > 0
      ? subPageModules.map((m) => `{route === '${m.routePath}' && <${m.compName} />}`).join('\n      ')
      : '';

  const appTsx = `import React${subPageModules.length > 0 ? ', { useState }' : ''} from 'react';
import { ExtractedPage } from './components/ExtractedPage';
${subImports}

export function App() {
${subPageModules.length > 0 ? `  const [route, setRoute] = useState<string>('/');\n` : ''}
  return (
    <>
${navSwitcher}
      {${subPageModules.length > 0 ? `route === '/' && ` : ''}<ExtractedPage />}
      ${routeBranches}
    </>
  );
}

export default App;
`;
  const appPath = path.join(viteSrcDir, 'App.tsx');
  fs.writeFileSync(appPath, appTsx, 'utf-8');
  createdFiles.push({ fileName: 'App.tsx', folderPath: 'react-vite-app/src/App.tsx', size: fs.statSync(appPath).size });

  return { viteDir, copiedPublicAssets, createdFiles };
}

module.exports = {
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
};
