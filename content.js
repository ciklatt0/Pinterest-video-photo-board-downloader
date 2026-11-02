// Pinterest media collector + downloader (v4.2.1)
// Flow:
//  1) page-hook.js (MAIN world) captures the page's real video requests.
//  2) If a progressive .mp4 exists, it is downloaded directly.
//  3) If only HLS (.m3u8) exists, parts are downloaded and merged into .mp4/.ts.
//  4) If none, the same-origin PinResource API is tried.

(() => {
if (window.__pdContentLoaded) return;
window.__pdContentLoaded = true;

const pdMp4 = new Map();   // pinId -> url   (progressive mp4)
const pdHls = new Map();   // pinId -> url   (m3u8 playlist)

// --- Media notifications from MAIN world ---
// NOTE: The e.source check was deliberately removed. Between MAIN and ISOLATED
// worlds, Chrome's event.source can return a different WindowProxy, and this
// check silently dropped messages (it worked in Brave).
// Security: only our own signed payload is accepted.
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.__pdMedia !== true) return;
  if (d.__pdProbe === true) return;
  if (typeof d.url !== 'string') return;
  if (e.origin !== location.origin) return;
  const pinId = extractPinIdFromUrl(location.href) || null;
  // The 'page' record is ALWAYS the last seen URL (in SPA the first video
  // stayed 'page' forever and the wrong video was downloaded).
  if (/\.m3u8(\?|$)/i.test(d.url)) {
    if (pinId && !pdHls.get(pinId)) pdHls.set(pinId, d.url);
    pdHls.set('page', d.url);
  } else if (/\.mp4(\?|$)/i.test(d.url)) {
    if (pinId && !pdMp4.get(pinId)) pdMp4.set(pinId, d.url);
    pdMp4.set('page', d.url);
  }
});
// Both scripts start early; request anything page-hook captured first.
try { window.postMessage({ __pdResend: true }, location.origin); } catch {}

// --- Settings (from popup, persisted in chrome.storage.local) ---
// name -> [storage key, default]. Keep in sync with PD_DEFAULTS in popup.js.
const PD_SETTING_KEYS = {
  folder:         ['pdFolder', 'pinterest'],     // folder inside Downloads
  maxConcurrent:  ['pdMaxConcurrent', 4],        // parallel photo downloads (boards)
  showHover:      ['pdShowHover', true],         // hover button on feed cards
  showPinBtn:     ['pdShowPinBtn', true],        // button on pin detail pages
  showBoardBtn:   ['pdShowBoardBtn', true],      // "Download all" on board pages
  boardFolder:    ['pdBoardFolder', true],       // boards go to <folder>/<user>-<board>/
  saveAs:         ['pdSaveAs', false],           // ask where to save each file
  conflict:       ['pdConflict', 'uniquify'],    // existing file: uniquify | overwrite
  progressToasts: ['pdProgressToasts', false]    // also show non-error messages
};
let PD_SETTINGS = Object.fromEntries(
  Object.entries(PD_SETTING_KEYS).map(([name, [, def]]) => [name, def])
);
async function loadSettings() {
  const keys = Object.values(PD_SETTING_KEYS).map(([key]) => key);
  const res = await chrome.storage.local.get(keys);
  for (const [name, [key]] of Object.entries(PD_SETTING_KEYS)) {
    if (res[key] !== undefined && res[key] !== '') PD_SETTINGS[name] = res[key];
  }
}

// Buttons are attached before the async settings load finishes, so they are
// reconciled again once the real values are known.
function applySettings(names) {
  if (names.includes('showHover')) {
    if (PD_SETTINGS.showHover) {
      try { attachHoverButtons(); } catch {}
    } else {
      document.querySelectorAll('.pd-hover-btn').forEach((b) => b.remove());
      try { pdMirrorHide(); } catch {}
    }
  }
  if (names.includes('showPinBtn')) {
    const existing = document.getElementById('pd-pinpage-btn');
    if (PD_SETTINGS.showPinBtn) {
      try { attachPinPageButton(); } catch {}
    } else if (existing) {
      if (pdCleanup) { try { pdCleanup(); } catch {} pdCleanup = null; }
      existing.remove();
    }
  }
  if (names.includes('showBoardBtn')) {
    try { pdBoardSync(); } catch {}
  }
}
loadSettings().then(() => applySettings(['showHover', 'showPinBtn', 'showBoardBtn']));

// Apply popup setting changes immediately (no page refresh needed).
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const changed = [];
    for (const [name, [key, def]] of Object.entries(PD_SETTING_KEYS)) {
      if (!changes[key]) continue;
      const v = changes[key].newValue;
      PD_SETTINGS[name] = v === undefined || v === '' ? def : v;
      changed.push(name);
    }
    if (changed.length) applySettings(changed);
  });
} catch {}

// --- Secure messaging with background ---
// When the extension reloads, the old content script's chrome.runtime becomes
// invalid and sendMessage THROWS. We convert this into a clear error.
// Downloads go into Downloads/<folder>/[<subfolder>/] — see settings.
function pdSend(msg) {
  if (msg && msg.action === 'DOWNLOAD') {
    // Caller's own values (e.g. a board's subfolder, saveAs:false) win.
    msg = {
      folder: PD_SETTINGS.folder,
      saveAs: !!PD_SETTINGS.saveAs,
      conflict: PD_SETTINGS.conflict,
      ...msg
    };
  }
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: 'Extension connection lost — refresh the page (F5). ' + chrome.runtime.lastError.message });
        } else {
          resolve(res);
        }
      });
    } catch (e) {
      resolve({ ok: false, error: 'Extension reloaded — refresh the page (F5).' });
    }
  });
}

// CORS-less validation: done by background (service worker).
// Fetching i.pinimg.com from content script gets stuck on CORS and ALWAYS
// failed (GIFs fell to .jpg, audio MP4 was never found).
async function pdProbe(url) {
  const r = await pdSend({ action: 'PROBE', url });
  return r && typeof r === 'object' && 'ct' in r ? r : null;
}

// --- In-page resource scan (fallback) ---
function scanPageResources() {
  try {
    performance.getEntriesByType('resource').forEach((e) => {
      const u = e.name;
      if (!/pinimg\.com/i.test(u)) return;
      const pinId = extractPinIdFromUrl(location.href) || null;
      if (/\.m3u8(\?|$)/i.test(u) && pinId && !pdHls.get(pinId)) pdHls.set(pinId, u);
      if (/\.mp4(\?|$)/i.test(u) && pinId && !pdMp4.get(pinId)) pdMp4.set(pinId, u);
    });
  } catch {}
}
scanPageResources();
setInterval(scanPageResources, 4000);

// --- Helpers ---
function extractPinIdFromUrl(url) {
  const m = String(url || '').match(/\/pin\/(?:[\w-]+--)?(\d+)/);
  return m ? m[1] : null;
}

// Derive a PROGRESSIVE MP4 URL from an HLS (.m3u8) URL.
// Pinterest's CDN serves the same hash in both patterns:
//   HLS : .../videos/iht/hls/c2/bd/b8/HASH.m3u8
//   MP4 : .../videos/iht/expMp4/c2/bd/b8/HASH_720w.mp4
// The progressive file has video+audio muxed in the same file
// (avc1 + mp4a, 2 tracks) — so no HLS part merging is needed.
function hlsToProgressiveMp4Candidates(hlsUrl) {
  try {
    const u = new URL(hlsUrl);
    const m = u.pathname.match(/^\/videos\/([^/]+)\/(?:hls)\/(.+?)\/([^/]+)\.m3u8$/i);
    if (!m) return [];
    const [, prefix, dir, rawHash] = m;
    const hash = rawHash.replace(/_720w$/i, '');
    const hosts = [u.hostname, 'v1.pinimg.com'];
    const urls = [];
    for (const host of hosts) {
      urls.push(`https://${host}/videos/${prefix}/expMp4/${dir}/${hash}_720w.mp4`);
      urls.push(`https://${host}/videos/${prefix}/720p/${dir}/${hash}.mp4`);
    }
    return [...new Set(urls)];
  } catch {
    return [];
  }
}

// Does the derived MP4 really exist and is it video? (fast validation with HEAD)
async function verifyProgressiveMp4(url) {
  const p = await pdProbe(url);
  return !!(p && p.ok && (p.ct.includes('video') || p.ct.includes('mp4')));
}

// HLS playlist is also accepted: Idea Pins have no progressive MP4 at all,
// only V_HLSV3_MOBILE (.m3u8).
function pickBestSource(videoList) {
  if (!videoList || typeof videoList !== 'object') return null;
  let bestMp4 = null, bestHls = null;
  for (const [key, f] of Object.entries(videoList)) {
    if (!f || typeof f !== 'object') continue;
    const url = f.url;
    if (!url || typeof url !== 'string') continue;
    const score =
      (f.width || 0) * (f.height || 0) ||
      parseInt((key.match(/(\d{3,4})/) || [0, 0])[1], 10) || 0;
    if (/\.mp4(\?|$)/i.test(url)) {
      if (!bestMp4 || score > bestMp4.score) bestMp4 = { url, score };
    } else if (/\.m3u8(\?|$)/i.test(url)) {
      if (!bestHls || score > bestHls.score) bestHls = { url, score };
    }
  }
  // Prefer progressive MP4 if present (audio already inside, no mux needed)
  if (bestMp4) return bestMp4.url;
  return bestHls ? bestHls.url : null;
}

function videoSourceFromPinData(d) {
  if (!d) return null;
  // Standart video pin
  const direct = pickBestSource(d.videos && d.videos.video_list);
  if (direct) return direct;
  // Idea Pin / Story pin (multi-page)
  const pages = (d.story_pin_data && d.story_pin_data.pages) || [];
  for (const p of pages) {
    for (const b of (p.blocks || [])) {
      if (!b) continue;
      // block structure can vary by pin type
      const u =
        pickBestSource(b.video && b.video.video_list) ||
        pickBestSource(b.video && b.video.video) ||
        (b.video && b.video.url ? pickBestSource({ V: b.video }) : null);
      if (u) return u;
    }
  }
  // Last resort: first media link in raw data
  const m = JSON.stringify(d).match(/https:\/\/v1?\.pinimg\.com\/[^"'\s\\]+\.(mp4|m3u8)[^"'\s\\]*/);
  return m ? m[0] : null;
}

function getFileNameFromUrl(url, index, isVideo) {
  // NOTE: This is only the base name. The real extension is added by
  // background from the server's Content-Type (otherwise GIFs were saved as .jpg).
  try {
    const u = new URL(url, location.href);
    let name = u.pathname.split('/').pop() || `pinterest-${index}`;
    name = name.split('?')[0].replace(/\.[^.]*$/, '').replace(/[<>:"/\\|?*]/g, '-').slice(0, 50);
    return `pinterest/${name || 'pin-' + index}-${index}`;
  } catch {
    return `pinterest/pin-${Date.now()}-${index}`;
  }
}

// --- Visible status toast ---
function pdToast(msg, isError) {
  // Progress / success toasts ("Searching...", "Download starting...",
  // "Download started") are only shown when enabled in settings.
  if (!isError && !PD_SETTINGS.progressToasts) return;
  try {
    let box = document.getElementById('pd-toast-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'pd-toast-box';
      box.style.cssText =
        'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.style.cssText =
      `background:${isError ? '#b00020' : '#111'};color:#fff;padding:10px 16px;border-radius:24px;` +
      `font-size:13px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:90vw;` +
      `pointer-events:auto;font-family:sans-serif;text-align:center;`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), isError ? 7000 : 3000);
  } catch {}
}

// --- Same-origin API (no CORS) ---
async function fetchPinViaApi(pinId) {
  const keys = ['unauth_react_main_pin', 'detailed', 'auth_web_main_pin'];
  let lastErr = null;
  for (const field_set_key of keys) {
    try {
      const payload = { options: { field_set_key, id: String(pinId) }, context: {} };
      const api =
        location.origin + '/resource/PinResource/get/?source_url=' +
        encodeURIComponent(`/pin/${pinId}/`) +
        '&data=' + encodeURIComponent(JSON.stringify(payload));
      const res = await fetch(api, {
        credentials: 'include',
        headers: {
          'X-Pinterest-PWS-Handler': 'www/pin.js',
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json'
        }
      });
      if (!res.ok) {
        lastErr = new Error('Pin API HTTP ' + res.status);
        continue;
      }
      const json = await res.json();
      const src = videoSourceFromPinData(json && json.resource_response && json.resource_response.data);
      if (src) return src;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

// --- Video download ---
// HLS is merged INSIDE THE PAGE (service worker has no createObjectURL).
// --- Resolve video source ---
// Returns: { kind: 'mp4' | 'hls', url }
async function resolveVideoSource(pinId) {
  // If pinId is known, try the API first: a URL captured for other videos on
  // the page could be wrongly bound to this pin.
  if (pinId) {
    let apiFailed = false;
    try {
      const u = await fetchPinViaApi(pinId);
      if (u) {
        return /\.m3u8(\?|$)/i.test(u) ? { kind: 'hls', url: u } : { kind: 'mp4', url: u };
      }
    } catch {
      apiFailed = true;
    }
    // If the API found no video, do not use a URL captured for other pins.
    if (apiFailed) {
      if (pdMp4.get(pinId)) return { kind: 'mp4', url: pdMp4.get(pinId) };
      if (pdHls.get(pinId)) return { kind: 'hls', url: pdHls.get(pinId) };
    }
  } else {
    // NOTE: The 'page' record belongs to a video from ANOTHER pin.
    if (pdMp4.get('page')) return { kind: 'mp4', url: pdMp4.get('page') };
    if (pdHls.get('page')) return { kind: 'hls', url: pdHls.get('page') };
  }

  throw new Error(
    pinId
      ? 'Video source not found — play the video once and try again.'
      : 'Video source not found — open the pin page and play the video.'
  );
}

// Resolves the real download URL for an image.
//
// Candidate generation + validation is done in background.js (RESOLVE_IMAGE):
// fetching i.pinimg.com from content script gets stuck on CORS. The correct
// extension (jpg/png/gif/webp) and whether an 'originals' version exists can
// only be learned by asking the server; otherwise 403 + application/xml is
// returned and the file is saved as .xml.
async function resolveImageUrl(preferredUrl, isGifHint) {
  const r = await pdSend({ action: 'RESOLVE_IMAGE', url: preferredUrl, isGif: !!isGifHint });
  if (r && r.ok && r.url) return r.url;
  // Not validated: pass the URL as-is. background DOWNLOAD still tries
  // alternatives and deletes the file if an error document arrives.
  return preferredUrl;
}

// extra: additional DOWNLOAD message fields (e.g. a board's subfolder).
async function downloadVideoFor(pinId, hintUrl, extra = {}) {
  pdToast('⏳ Searching for video...');
  let src;
  try {
    src = await resolveVideoSource(pinId);
  } catch (e) {
    // If unresolved but we have a real pinimg video link, use it.
    if (hintUrl && /^https:\/\/[^/]*pinimg\.com\/.+\.(mp4|m3u8)(\?|$)/i.test(hintUrl)) {
      src = { kind: /\.m3u8(\?|$)/i.test(hintUrl) ? 'hls' : 'mp4', url: hintUrl };
    } else {
      throw e;
    }
  }

  if (src.kind === 'hls') {
    // Priority: progressive MP4 (audio + video in the SAME file)
    const mp4Candidates = hlsToProgressiveMp4Candidates(src.url);
    for (const mp4 of mp4Candidates) {
      if (!(await verifyProgressiveMp4(mp4))) continue;
      pdToast('⬇ Downloading audio MP4...');
      const r = await pdSend({
        action: 'DOWNLOAD',
        url: mp4,
        type: 'video',
        filename: getFileNameFromUrl(mp4, pinId ? pinId.slice(-6) : Date.now() % 100000, true),
        ...extra
      });
      if (r && r.ok) { pdToast('✅ Downloaded (audio MP4)'); return { ...r, via: 'progressive-mp4', audio: true }; }
    }
    // If no progressive, merge HLS parts
    pdToast('⬇ Downloading HLS parts...');
    try {
      const r = await pdDownloadHls(src.url, 'pin-' + (pinId ? pinId.slice(-6) : Date.now() % 100000));
      pdToast(
        r.audioSaved
          ? `✅ Video saved (${Math.round(r.size / 1024)} KB) — audio in separate file`
          : `✅ Video saved (${Math.round(r.size / 1024)} KB) — this video is silent`,
        !r.audioSaved
      );
      return { ok: true, via: 'page-hls', audioSaved: r.audioSaved };
    } catch (e) {
      throw new Error('Video could not be downloaded: ' + (e && e.message ? e.message : e));
    }
  }

  pdToast('⬇ Download starting...');
  const r = await pdSend({
    action: 'DOWNLOAD',
    url: src.url,
    type: 'video',
    filename: getFileNameFromUrl(src.url, pinId ? pinId.slice(-6) : Date.now() % 100000, true),
    ...extra
  });
  if (r && r.ok) { pdToast('✅ Download started'); return r; }
  pdToast('❌ ' + ((r && r.error) || 'could not be downloaded'), true);
  return r || { ok: false };
}

// --- Video detection ---
// Pinterest video pins usually appear in the feed WITHOUT a <video> tag.
// Distinguishing signs:
//   1. Play button / overlay icon
//   2. Duration label ("0:14")
//   3. Thumbnail path: i.pinimg.com/videos/... (most reliable)
function looksLikeVideoPin(pin) {
  if (!pin || !pin.querySelector) return false;

  if (pin.querySelector('video')) return true;

  // Dedicated video markers.
  if (pin.querySelector(
    '[data-test-id="play-icon"], [data-test-id="overlay-play-button"], ' +
    '[data-test-id="pinrep-video"], [data-test-id="video-play-button"]'
  )) return true;

  // aria-label play buttons. The old selector used *="play" which also matched
  // "Display options", "Replay", "Playlist"... and turned photos into videos.
  // Require "play" as a whole word (or Turkish "oynat").
  const playRe = /\bplay\b|\boynat/i;
  for (const el of pin.querySelectorAll('[aria-label]')) {
    if (playRe.test(el.getAttribute('aria-label') || '')) return true;
  }

  const img = pin.querySelector('img');

  // Thumbnail path: video image
  if (img) {
    const s = img.currentSrc || img.src || '';
    if (/\/videos\/(thumbnails|story)/i.test(s)) return true;
  }

  // Duration badge ("0:14", "1:23") — only counts when it sits ON the image.
  // Titles/captions such as "10:30" used to match and mark photos as videos.
  if (img) {
    const durRe = /^\d{1,2}:\d{2}$/;
    const ir = img.getBoundingClientRect();
    const leaves = pin.querySelectorAll('span, div');
    for (let i = 0; i < leaves.length && i < 200; i++) {
      const el = leaves[i];
      if (el.children.length) continue;
      const t = (el.textContent || '').trim();
      if (t.length > 5 || !durRe.test(t)) continue;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx >= ir.left && cx <= ir.right && cy >= ir.top && cy <= ir.bottom) return true;
    }
  }

  return false;
}
function isGifPin(card) {
  if (!card || !card.querySelector) return false;

  const img = card.querySelector('img');
  if (!img) return false;

  // 1) Is the image's OWN source directly .gif?
  const own = [img.currentSrc, img.src, img.getAttribute('data-src'), img.getAttribute('data-orig')]
    .filter(Boolean)
    .join(' ');
  if (/\.gif(\?|,|\s|$)/i.test(own)) return true;

  // 2) Is the image's TYPE directly reported as gif?
  if ((img.getAttribute('data-type') || '').toLowerCase() === 'gif') return true;

  // 3) Is there a GIF badge in the image's DIRECT container?
  //    (don't look at the whole card — only img.parentElement)
  const parent = img.parentElement;
  if (parent) {
    const badge = parent.querySelector(
      '[data-test-id="gif-badge"], [data-test-id="gifBadge"], [aria-label="GIF"]'
    );
    if (badge) return true;
  }

  return false;
}

// --- Helpers used by collectMedia() ---

// Video thumbnail image? (the video itself is added separately as a video item)
// NOTE: this function was called by collectMedia() but never defined, which made
// the popup fail with "isVideoThumb is not defined".
function isVideoThumb(img) {
  if (!img) return false;
  const s = img.currentSrc || img.src || '';
  return /\/videos\/(thumbnails|story)/i.test(s);
}

// --- Ad / promoted pin detection (keeps ads out of the popup list) ---
// Pinterest labels ads with a small caption ("Promoted by X", "Tanıtım", ...)
// and sometimes with data-test-id / aria-label markers. Checked per card.
const PD_AD_TEXT_RE = new RegExp(
  '^(?:promoted(?:\\s+by\\b.*)?|sponsored(?:\\s+by\\b.*)?|ad|ads|advertisement|' +
  'tan[ıi]t[ıi]m(?:[ıi]?\\s+(?:yapan|eden)\\b.*)?|tan[ıi]t[ıi]ml[ıi]|tan[ıi]t[ıi]ld[ıi]|sponsorlu(?:\\s.*)?|reklam|' +
  'promocionado|patrocinado|promovido|gesponsert|anzeige|sponsoris[ée]|publicit[ée]|' +
  'sponsorizzato|promosso|gepromoot|gesponsord|рекламa|реклама|广告|広告|광고)$',
  'i'
);
const pdAdCache = new WeakMap();

function pdCardOf(el) {
  // Outermost wrapper first: the "Promoted by ..." footer often lives OUTSIDE
  // div[data-test-id="pin"], so the nearest match used to miss it.
  const g = el.closest('[data-grid-item]') ||
    el.closest('div[role="listitem"], div[data-test-id="pin"]');
  if (g) return g;
  // Fallback: climb a few levels while the wrapper still holds just ONE pin.
  let cur = el;
  for (let i = 0; i < 5; i++) {
    const p = cur.parentElement;
    if (!p || p === document.body || p === document.documentElement) break;
    const ids = new Set();
    p.querySelectorAll('a[href*="/pin/"]').forEach((a) => ids.add(a.getAttribute('href')));
    if (ids.size > 1 || p.querySelectorAll('img').length > 3) break;
    cur = p;
  }
  return cur;
}

function pdIsPromotedCard(card) {
  if (!card || !card.querySelector) return false;
  const cached = pdAdCache.get(card);
  if (cached && (cached.ad || Date.now() - cached.t < 2500)) return cached.ad;
  let ad = false;
  try {
    // Explicit ad markers
    const adSel =
      '[data-test-id*="promoted" i], [data-test-id*="sponsor" i], ' +
      '[data-test-id*="pin-ad" i], [data-test-id*="ad-badge" i], ' +
      'a[rel~="sponsored"]';
    if ((card.matches && card.matches(adSel)) || card.querySelector(adSel)) ad = true;

    // "Ad / Sponsored / Promoted" badge text in aria-label
    if (!ad) {
      const labeled = card.querySelectorAll('[aria-label]');
      for (let i = 0; i < labeled.length && i < 60; i++) {
        if (PD_AD_TEXT_RE.test((labeled[i].getAttribute('aria-label') || '').trim())) { ad = true; break; }
      }
    }

    // Ad disclosure text anywhere in the card (e.g. "Promoted by X", "Tanıtım", "Sponsored")
    if (!ad) {
      const leaves = card.querySelectorAll('span, div, p, a, li');
      for (let i = 0; i < leaves.length && i < 400; i++) {
        const el = leaves[i];
        const t = (el.textContent || '').trim();
        if (t && t.length <= 100 && PD_AD_TEXT_RE.test(t)) { ad = true; break; }
      }
    }
  } catch {}
  pdAdCache.set(card, { ad, t: Date.now() });
  return ad;
}
function pdIsPromoted(el) {
  return !!el && pdIsPromotedCard(pdCardOf(el));
}

// --- Media collection ---
// On-screen position of an element; used to order the popup list the way the
// pins are laid out on the page (top -> bottom, left -> right).
function pdPosOf(el) {
  try {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;   // hidden / not laid out
    return { t: Math.round(r.top), l: Math.round(r.left) };
  } catch { return null; }
}

function collectMedia() {
  const items = [];
  const seen = new Set();
  const push = (type, url, thumb, w, h, pinId, posEl) => {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return;
    url = url.replace(/^http:\/\/(v1?\.pinimg|v\.pinimg)/, 'https://$1');
    // The pin: placeholder MUST be saved (added as its own item).
    // It was previously removed here and all videos disappeared from the list.
    const key = url.startsWith('pin:') ? `${type}:${url}` : url;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ type, url, thumb: thumb || '', width: w || 0, height: h || 0, pinId: pinId || null,
      _pos: posEl ? pdPosOf(posEl) : null });
  };

  // pinId -> { thumb, card }  (card = the pin's <a> element, no re-query needed)
  const pinLinks = new Map();
  document.querySelectorAll('a[href*="/pin/"]').forEach((a) => {
    const id = extractPinIdFromUrl(a.getAttribute('href'));
    if (!id || pinLinks.has(id)) return;
    if (pdIsPromoted(a)) return;            // ad: keep it out of the list
    const img = a.querySelector('img');
    pinLinks.set(id, { thumb: img ? img.currentSrc || img.src : '', card: a });
  });

  // Videos (<video> tags)
  document.querySelectorAll('video').forEach((v) => {
    if (pdIsPromoted(v)) return;            // ad video
    const pinEl = v.closest('a[href*="/pin/"]');
    const pinId = (pinEl && extractPinIdFromUrl(pinEl.getAttribute('href'))) ||
      extractPinIdFromUrl(location.href);
    // Do not bind another pin's 'page' record to this pin — wrong video downloaded.
    const real = pinId ? pdMp4.get(pinId) : pdMp4.get('page');
    if (real) push('video', real, v.poster || '', v.videoWidth || 0, v.videoHeight || 0, pinId, pinEl || v);
    else if (pinId) push('video', `pin:${pinId}`, v.poster || '', 0, 0, pinId, pinEl || v);
  });

  // Video-looking cards: detected even without <video> (play icon, duration label,
  // captured HLS/MP4, or videos/thumbnails preview)
  pinLinks.forEach(({ thumb, card }, pinId) => {
    if (!(card && looksLikeVideoPin(card))) return;
    const capturedMp4 = pdMp4.get(pinId);
    if (capturedMp4) push('video', capturedMp4, thumb, 0, 0, pinId, card);
    else push('video', `pin:${pinId}`, thumb, 0, 0, pinId, card);
  });

  // Images — except video thumbnails (they are marked as video via the pin: record)
  document.querySelectorAll('img').forEach((img) => {
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    if (src.includes('s.pinimg.com') && src.includes('emoji')) return;
    // Pin images are on i.pinimg.com; s.pinimg.com (UI icons),
    // ads/external images were cluttering the list.
    if (!/^https?:\/\/i\.pinimg\.com\//i.test(src)) return;
    // Video thumbnail: already added as video
    if (isVideoThumb(img)) return;
    // Ads / promoted pins are not listed
    if (pdIsPromoted(img)) return;
    // If this card already has a video, this image is its preview
    const card = img.closest('div[data-test-id="pin"], a[href*="/pin/"]');
    const cardPin = card && (
      extractPinIdFromUrl(card.getAttribute && card.getAttribute('href')) ||
      extractPinIdFromUrl((card.querySelector && card.querySelector('a[href*="/pin/"]') || {}).getAttribute?.('href'))
    );
    if (card && looksLikeVideoPin(card)) return;
    if (cardPin && (seen.has(`video:pin:${cardPin}`) || pdMp4.get(cardPin) || pdHls.get(cardPin))) return;

    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w > 0 && w < 150 && h > 0 && h < 150) return;
    if (/\/25x|\/30x|\/60x|\/\d+x\d+_RS\/|avatar|profile|favicon|logo/i.test(src)) return;

    // DO NOT convert the URL to an extension here.
    // Guessing the extension produced 403 + application/xml.
    // The correct extension is found by resolveImageUrl() validating with the server.
    const full = src.replace(/\/\d+x\d*\//, '/originals/');
    const isGifCard = /\.gif(\?|$)/i.test(src) || isGifPin(card);

    if (seen.has(full)) return;
    seen.add(full);
    items.push({
      type: 'image',
      url: full,
      thumb: src,
      width: w,
      height: h,
      pinId: null,
      _pos: pdPosOf(img),
      // Suspect GIF only if the image's OWN source is .gif.
      // resolveImageUrl will still validate with the server.
      isGif: isGifCard
    });
  });

  // Order = on-screen layout (top -> bottom, then left -> right), NOT DOM order.
  // Pinterest's masonry grid is virtualised / absolutely positioned, so DOM order
  // is arbitrary, and videos used to be listed before every photo.
  // Items without a layout position keep their relative order at the end
  // (Array.prototype.sort is stable).
  items.sort((a, b) => {
    const pa = a._pos, pb = b._pos;
    if (!pa && !pb) return 0;
    if (!pa) return 1;
    if (!pb) return -1;
    return (pa.t - pb.t) || (pa.l - pb.l);
  });
  items.forEach((it) => { delete it._pos; });
  return items;
}

// --- Mesajlar ---
// ============ HLS DOWNLOAD (inside the page) ============
// WHY HERE? MV3 service workers have NO URL.createObjectURL.
// Merging Blobs in background.js threw "URL.createObjectURL is not a
// function". The content script has full DOM access, so it can use both
// createObjectURL and CORS fetch.
function pdAbsolute(u, base) {
  try { return new URL(u, base).href; } catch { return u; }
}

function pdByteRange(spec, lastOffset) {
  const s = String(spec || '').trim();
  if (!s.includes('@')) return { length: parseInt(s, 10), offset: lastOffset || 0 };
  const [len, off] = s.split('@');
  return { length: parseInt(len, 10), offset: parseInt(off, 10) };
}

async function pdFetchText(url) {
  const r = await fetch(url, { credentials: 'omit' });
  if (!r.ok) throw new Error('Playlist HTTP ' + r.status);
  return r.text();
}

function pdParseMaster(text, baseUrl) {
  const variants = []; const audios = [];
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const type = (line.match(/TYPE=(\w+)/) || [])[1];
      const uri = (line.match(/URI="([^"]+)"/) || [])[1];
      const gid = (line.match(/GROUP-ID="([^"]+)"/) || [])[1];
      if (type === 'AUDIO' && uri) audios.push({ url: pdAbsolute(uri, baseUrl), groupId: gid });
      continue;
    }
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bw = parseInt((line.match(/BANDWIDTH=(\d+)/) || [])[1] || '0', 10);
      const res = line.match(/RESOLUTION=(\d+)x(\d+)/) || [];
      const aud = (line.match(/AUDIO="([^"]+)"/) || [])[1];
      pending = { bw, w: res[1] ? +res[1] : 0, h: res[2] ? +res[2] : 0, audioGroup: aud || null };
      continue;
    }
    if (!line.startsWith('#') && pending) { variants.push({ ...pending, url: pdAbsolute(line, baseUrl) }); pending = null; }
  }
  variants.sort((a, b) => (b.bw || b.w * b.h) - (a.bw || a.w * a.h));
  return { variants, audios };
}

function pdParseMedia(text, baseUrl) {
  const segments = [];
  let lastOffset = 0, pendingDur = 0, pendingRange = null, init = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = (line.match(/URI="([^"]+)"/) || [])[1];
      const br = (line.match(/BYTERANGE="([^"]+)"/) || [])[1];
      if (uri) {
        const url = pdAbsolute(uri, baseUrl);
        if (br) { const r = pdByteRange(br, 0); init = { url, offset: r.offset, length: r.length }; }
        else init = { url, offset: null, length: null };
      }
      continue;
    }
    if (line.startsWith('#EXTINF:')) { pendingDur = parseFloat(line.slice(8)) || 0; continue; }
    if (line.startsWith('#EXT-X-BYTERANGE:')) { pendingRange = line.slice(17).trim(); continue; }
    if (line.startsWith('#')) continue;
    const url = pdAbsolute(line, baseUrl);
    if (pendingRange) {
      const r = pdByteRange(pendingRange, lastOffset);
      segments.push({ url, offset: r.offset, length: r.length, dur: pendingDur });
      lastOffset = r.offset + r.length;
      pendingRange = null;
    } else segments.push({ url, offset: null, length: null, dur: pendingDur });
    pendingDur = 0;
  }
  return { segments, init };
}

async function pdFetchRange(url, offset, length) {
  // In Chrome, the Range header sometimes triggers a CORS preflight.
  // Try Range first; if rejected, make a full request (larger but safe).
  try {
    const r = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (r.status === 206) {
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length) return buf;
    } else if (r.ok) {
      // Server ignored Range (200): the WHOLE file arrived, cut the slice manually.
      // (Returning it as-is like before made every part a full file.)
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length >= offset + length) return buf.slice(offset, offset + length);
    }
  } catch {
    // Range blocked -> fall back to full request
  }
  const buf = await pdFetchBuf(url);
  // If we downloaded the whole file, cut the byte range manually
  if (buf.length >= offset + length) return buf.slice(offset, offset + length);
  return buf;
}

// Status-code-checked download: 403/404 error documents must not mix into the video.
async function pdFetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Part HTTP ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

function pdSaveBlob(parts, mime, filename) {
  const blob = new Blob(parts, { type: mime });
  const objUrl = URL.createObjectURL(blob);   // available in content script
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(objUrl); }, 30000);
  return blob.size;
}

async function pdDownloadHls(playlistUrl, baseName) {
  const masterText = await pdFetchText(playlistUrl);
  let videoUrl = playlistUrl;
  let audioUrl = null;

  if (masterText.includes('#EXT-X-STREAM-INF')) {
    const { variants, audios } = pdParseMaster(masterText, playlistUrl);
    if (!variants.length) throw new Error('HLS variant not found');
    videoUrl = variants[0].url;
    if (variants[0].audioGroup) {
      const a = audios.find((x) => x.groupId === variants[0].audioGroup) || audios[0];
      if (a) audioUrl = a.url;
    }
  }

  const vText = videoUrl === playlistUrl ? masterText : await pdFetchText(videoUrl);
  const vInfo = pdParseMedia(vText, videoUrl);
  if (!vInfo.segments.length) throw new Error('Video part not found');

  const parts = [];
  if (vInfo.init) {
    parts.push(vInfo.init.length
      ? await pdFetchRange(vInfo.init.url, vInfo.init.offset, vInfo.init.length)
      : await pdFetchBuf(vInfo.init.url));
  }

  for (let i = 0; i < vInfo.segments.length; i++) {
    const s = vInfo.segments[i];
    parts.push(s.length
      ? await pdFetchRange(s.url, s.offset, s.length)
      : await pdFetchBuf(s.url));
    if (i % 5 === 0) pdToast(`⬇ Video: ${i}/${vInfo.segments.length} parts`, false);
  }

  // fMP4 (init segment present) -> .mp4 ; MPEG-TS parts -> .ts
  const isTs = !vInfo.init && /\.ts(\?|$)/i.test(vInfo.segments[0].url);
  const size = isTs
    ? pdSaveBlob(parts, 'video/mp2t', baseName + '.ts')
    : pdSaveBlob(parts, 'video/mp4', baseName + '.mp4');

  // In fMP4, audio is a separate stream; it cannot be muxed in the browser.
  // If audio exists, save it as a separate file too.
  let audioSaved = false;
  if (audioUrl) {
    try {
      const aText = await pdFetchText(audioUrl);
      const aInfo = pdParseMedia(aText, audioUrl);
      const aParts = [];
      if (aInfo.init) {
        aParts.push(aInfo.init.length
          ? await pdFetchRange(aInfo.init.url, aInfo.init.offset, aInfo.init.length)
          : await pdFetchBuf(aInfo.init.url));
      }
      for (const s of aInfo.segments) {
        aParts.push(s.length
          ? await pdFetchRange(s.url, s.offset, s.length)
          : await pdFetchBuf(s.url));
      }
      pdSaveBlob(aParts, 'audio/mp4', baseName + '-audio.m4a');
      audioSaved = true;
    } catch {
      audioSaved = false;
    }
  }

  return { ok: true, size, segments: vInfo.segments.length, audioSaved, hasAudioTrack: !!audioUrl };
}

// --- Diagnosis: requested by the popup "Diagnose" button ---
// --- Browser capability report (to see Chrome/Brave differences) ---
async function pdCapabilities() {
  const caps = {};

  // Browser
  const ua = navigator.userAgent;
  caps.browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : navigator.brave ? 'Brave'
    : /Chrome\//.test(ua) ? 'Chrome'
    : 'unknown';
  const m = ua.match(/(?:Chrome|Chromium)\/(\d+)/);
  caps.version = m ? m[1] : '?';

  // Did MAIN world hook run? (page-hook data-pd-hooked marker)
  caps.mainWorldHook = document.documentElement.getAttribute('data-pd-hooked') === '1'
    ? 'YES'
    : 'NO';

  // Core APIs
  caps.createObjectURL = typeof URL.createObjectURL === 'function' ? 'YES' : 'NO';
  caps.fetch = typeof fetch === 'function' ? 'YES' : 'NO';
  caps.rAF = typeof requestAnimationFrame === 'function' ? 'YES' : 'NO';
  caps.performanceEntries = (() => {
    try { return performance.getEntriesByType('resource').length + ' entries'; }
    catch { return 'ERROR'; }
  })();

  caps.postMessageLoop = (pdMp4.size + pdHls.size) > 0
    ? 'WORKING (real entries exist)'
    : (caps.mainWorldHook === 'YES' ? 'hook present, no media yet' : 'no hook');

  // Real remote server access (CORS + network)
  try {
    const t0 = performance.now();
    const res = await fetch('https://i.pinimg.com/originals/00/00/00/0000000000000000.jpg', {
      method: 'HEAD'
    });
    caps.pinimgReach = 'HTTP ' + res.status + ' (' + Math.round(performance.now() - t0) + 'ms)';
  } catch (e) {
    caps.pinimgReach = 'ERROR: ' + (e && e.message ? e.message : e);
  }

  return caps;
}

async function pdDiagnostics() {
  const out = {
    url: location.href,
    origin: location.origin,
    mp4Count: pdMp4.size,
    hlsCount: pdHls.size,
    mp4Urls: [...pdMp4.entries()].map(([k, v]) => ({ pin: k, url: v.slice(0, 90) })),
    hlsUrls: [...pdHls.entries()].map(([k, v]) => ({ pin: k, url: v.slice(0, 90) })),
    pinCards: document.querySelectorAll('div[data-test-id="pin"], div[data-test-id="pinrep-image"]').length,
    videoEls: document.querySelectorAll('video').length,
    pinLinks: document.querySelectorAll('a[href*="/pin/"]').length,
    // Pin detail button status (is it in the DOM, where)
    pinPageBtn: (() => {
      const b = document.getElementById('pd-pinpage-btn');
      if (!b) return 'NONE';
      const r = b.getBoundingClientRect();
      // It is appended to <html>, outside <body>.
      const inDom = document.contains(b);
      return `present (parent=${b.parentElement ? b.parentElement.tagName : '?'}, ` +
        `w=${Math.round(r.width)}, h=${Math.round(r.height)}, ` +
        `visible=${r.width > 0 && r.height > 0}, opacity=${getComputedStyle(b).opacity}, ` +
        `z=${getComputedStyle(b).zIndex}${inDom ? '' : ' [OUTSIDE DOM!]'})`;
    })(),
    hoverBtns: document.querySelectorAll('.pd-hover-btn').length,
    version: '4.6.2',
    mirror: !!document.getElementById('pd-hover-mirror'),
    hasPinSelector: !!document.querySelector('div[data-test-id="pin"]'),
    lastAttachError: pdAttachError || 'none',
    caps: await pdCapabilities()
  };

  // Live-test the API for the open pin
  const pinId = extractPinIdFromUrl(location.href);
  if (pinId) {
    out.pinId = pinId;
    try {
      const payload = { options: { field_set_key: 'unauth_react_main_pin', id: pinId } };
      const api = location.origin + '/resource/PinResource/get/?source_url=' +
        encodeURIComponent(`/pin/${pinId}/`) + '&data=' + encodeURIComponent(JSON.stringify(payload));
      const t0 = performance.now();
      const res = await fetch(api, { credentials: 'include', headers: { 'X-Pinterest-PWS-Handler': 'www/pin.js', Accept: 'application/json' } });
      out.apiStatus = res.status;
      out.apiMs = Math.round(performance.now() - t0);
      if (res.ok) {
        const json = await res.json();
        const d = json && json.resource_response && json.resource_response.data;
        out.apiHasData = !!d;
        out.hasVideos = !!(d && d.videos);
        out.hasStory = !!(d && d.story_pin_data);
        const src = videoSourceFromPinData(d);
        out.resolvedUrl = src ? src.slice(0, 110) : null;
        out.resolvedKind = src ? (/\.m3u8/i.test(src) ? 'HLS' : /\.mp4/i.test(src) ? 'MP4' : 'unknown') : 'NONE';
      }
    } catch (e) {
      out.apiError = String(e && e.message || e);
    }
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Diagnosis request
  if (msg.action === 'DIAGNOSE') {
    (async () => {
      try { sendResponse({ ok: true, diag: await pdDiagnostics() }); }
      catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
    })();
    return true;
  }

  // Background notification (e.g. error document downloaded and deleted)
  if (msg.action === 'TOAST') {
    pdToast(msg.text || '', !!msg.error);
    return;
  }

  // Background HLS part progress
  if (msg.action === 'HLS_PROGRESS') {
    pdToast(`⬇ Video parts: ${msg.done}/${msg.total}`);
    return;
  }

  if (msg.action === 'GET_MEDIA') {
    try { sendResponse({ ok: true, media: collectMedia() }); }
    catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
    return true;
  }

  if (msg.action === 'BOARD_INFO') {
    const b = pdBoardInfo();
    sendResponse({ ok: true, board: b ? { name: b.slug, section: b.section } : null, running: !!pdBoardRun });
    return;
  }

  if (msg.action === 'BOARD_DOWNLOAD_ALL') {
    sendResponse(pdBoardStart());
    return;
  }

  if (msg.action === 'DOWNLOAD_VIDEO') {
    (async () => {
      try {
        // NOTE: msg.url may be a real mp4 link; the pin ID is derived ONLY from
        // the 'pin:ID' placeholder (formerly the URL itself was mistaken for the pin ID).
        const pinId =
          msg.pinId ||
          (/^pin:/.test(msg.url || '') ? msg.url.slice(4) : null) ||
          extractPinIdFromUrl(location.href) ||
          null;

        // Only resolve the link (popup "Open Link")
        if (msg.openOnly) {
          try {
            const src = await resolveVideoSource(pinId);
            return sendResponse({ ok: true, resolvedUrl: src.url, kind: src.kind, openOnly: true });
          } catch (e) {
            return sendResponse({ ok: false, error: String(e && e.message || e) });
          }
        }

        const r = await downloadVideoFor(pinId, msg.url);
        sendResponse(r);
      } catch (e) {
        const err = String(e && e.message || e);
        pdToast('❌ ' + err, true);
        sendResponse({ ok: false, error: err });
      }
    })();
    return true;
  }

  if (msg.action === 'DOWNLOAD_IMAGE') {
    (async () => {
      try {
        // Avoid XML error: pick the URL that really works
        const finalUrl = await resolveImageUrl(msg.url, msg.isGif);
        const r = await pdSend({
          action: 'DOWNLOAD',
          url: finalUrl,
          type: 'image',
          filename: msg.filename
        });
        sendResponse(r || { ok: false, error: 'could not be downloaded' });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
});

// --- Hover button ---
// Pin id for a card whose link is NOT a descendant of the card element.
// On some Pinterest layouts the card div sits INSIDE the <a>, or the <a> is a
// sibling/cousin, so pin.querySelector('a[href*="/pin/"]') finds nothing and
// the button failed with "Pin ID not found".
function pdPinIdForCard(pin) {
  try {
    // 1) the card is inside the pin link
    const up = pin.closest && pin.closest('a[href*="/pin/"]');
    if (up) { const id = extractPinIdFromUrl(up.getAttribute('href')); if (id) return id; }

    // 2) explicit id attributes Pinterest puts on card wrappers
    const attrEl = (pin.closest && pin.closest('[data-test-pin-id]')) ||
                   (pin.querySelector && pin.querySelector('[data-test-pin-id]'));
    if (attrEl) {
      const id = (attrEl.getAttribute('data-test-pin-id') || '').match(/\d+/);
      if (id) return id[0];
    }

    // 3) a nearby ancestor whose links point to exactly ONE pin
    //    (more than one id = we reached a container of several cards: stop)
    let a = pin.parentElement;
    for (let i = 0; a && i < 4; i++, a = a.parentElement) {
      const ids = new Set();
      a.querySelectorAll('a[href*="/pin/"]').forEach((l) => {
        const id = extractPinIdFromUrl(l.getAttribute('href'));
        if (id) ids.add(id);
      });
      if (ids.size === 1) return [...ids][0];
      if (ids.size > 1) break;
    }
  } catch {}
  return null;
}

function findPinMedia(pin) {
  // 'pin' is a <div> card; the pin link may be INSIDE it, or
  // the card itself may be an <a> (from the attached selector).
  const a = pin.querySelector ? pin.querySelector('a[href*="/pin/"]') : null;
  const href = a ? a.getAttribute('href') : (pin.tagName === 'A' ? pin.getAttribute('href') : null);
  // NOTE: no fallback to the PAGE's pin id. On a detail page whose main pin is
  // a video, every card without a parsable link used to inherit that video's
  // captured stream and was treated as a video itself.
  const pinId = extractPinIdFromUrl(href) || pdPinIdForCard(pin);
  if (looksLikeVideoPin(pin) || (pinId && (pdMp4.get(pinId) || pdHls.get(pinId)))) {
    return { isVideo: true, pinId };
  }
  const img = pin.querySelector('img');
  if (img) {
    const u = img.currentSrc || img.src;
    if (u) return { isVideo: false, url: u.replace(/\/\d+x\d*\//, '/originals/') };
  }
  return null;
}

function findHoverButtonHosts(root = document) {
  const cardSelector = 'div[data-test-id="pin"], div[data-test-id="pinrep-image"]';
  const linkSelector = 'a[href*="/pin/"]';
  const hosts = new Set();
  const addCard = (card) => { if (card instanceof HTMLDivElement) hosts.add(card); };
  const addLinkHost = (link) => {
    const knownCard = link.closest(cardSelector);
    if (knownCard) { addCard(knownCard); return; }

    // Newer Pinterest cards do not always expose a data-test-id. Their pin
    // link's direct div wrapper is the image overlay and is cheap to resolve.
    const host = link.parentElement;
    if (host instanceof HTMLDivElement) addCard(host);
  };

  if (root instanceof Element) {
    if (root.matches(cardSelector)) addCard(root);
    if (root.matches(linkSelector)) addLinkHost(root);
  }
  root.querySelectorAll(cardSelector).forEach(addCard);
  root.querySelectorAll(linkSelector).forEach(addLinkHost);
  return [...hosts];
}

function isPinDetailPage() {
  // Pins can be opened through more than the numeric /pin/<id>/ URL.
  if (/\/(?:pin|idea-pin)(?:\/|$)/i.test(location.pathname)) return true;

  // DOM markers cover modal/closeup layouts, but ONLY while they are really
  // on screen. Pinterest keeps a closeup subtree in the DOM (hidden) after you
  // go back to the feed; treating that as "detail page" removed every feed
  // button and stopped new ones from being added.
  const markers = document.querySelectorAll(
    '[data-test-id="pin-detail-media"], [data-test-id="closeup"], ' +
    '[data-test-id="closeup-image"], [data-test-id="pin-closeup"]'
  );
  for (const el of markers) {
    const r = el.getBoundingClientRect();
    if (r.width < 100 || r.height < 100) continue;
    if (el.checkVisibility &&
        !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    return true;
  }
  return false;
}
function syncPinDetailMode() {
  document.documentElement.classList.toggle('pd-pin-detail-page', isPinDetailPage());
}

// Big enough and really on screen. Pinterest keeps old closeups / the feed in
// the DOM (hidden) while a pin is open, so size alone is not enough.
function pdMediaUsable(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 80 || r.height < 80) return false;
  return !el.checkVisibility ||
    el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
}

function findPinDetailMainMedia() {
  if (!isPinDetailPage()) return null;

  // First VISIBLE match, not just the first one: a hidden closeup of the
  // previously opened pin comes earlier in the DOM.
  const direct = [...document.querySelectorAll(
    '[data-test-id="pin-detail-media"] video, [data-test-id="pin-detail-media"] img, ' +
    '[data-test-id="closeup"] video, [data-test-id="closeup"] img'
  )].find(pdMediaUsable);
  if (direct) return direct;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let best = null;
  let bestArea = 0;
  document.querySelectorAll('img, video').forEach((el) => {
    if (!pdMediaUsable(el)) return;
    const r = el.getBoundingClientRect();
    const visibleWidth = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const visibleHeight = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const area = visibleWidth * visibleHeight;
    if (area > bestArea) {
      bestArea = area;
      best = el;
    }
  });
  return best;
}

function removeDetailHoverButton() {
  if (!isPinDetailPage()) return;
  // Only the main media's card button is redundant (it has #pd-pinpage-btn).
  // Related-pin cards below keep theirs.
  document.querySelectorAll('.pd-hover-btn').forEach((btn) => {
    const host = btn.parentElement;
    if (!host) return;
    const main = pdMediaRef;
    if (
      host.closest('[data-test-id="pin-detail-media"], [data-test-id="closeup-image"]') ||
      (main && main.isConnected && (host.contains(main) || main.contains(host)))
    ) {
      btn.remove();
    }
  });
}

function setDownloadLoading(btn, loading) {
  btn.classList.toggle('pd-loading', loading);
  btn.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (btn.id === 'pd-pinpage-btn') btn.textContent = loading ? 'Downloading\u2026' : '\u2B07 Download';
  try { pdMirrorSchedule(); } catch {}
}

function sizeButtonForPin(btn, rect) {
  const compact = rect.width < 180 || rect.height < 135;
  const fontSize = Math.max(12, Math.min(14, Math.round(rect.width / 22)));
  const padX = Math.max(10, Math.min(16, Math.round(rect.width / 18)));
  btn.textContent = compact ? '⬇' : '⬇ Download';
  btn.style.setProperty('font-size', `${fontSize}px`, 'important');
  btn.style.setProperty('padding', `0 ${padX}px`, 'important');
  btn.style.setProperty('min-height', `${compact ? 32 : 36}px`, 'important');
  // Tiny cards have no room below the "Profil" dropdown: keep the top corner there.
  if (rect.height > 0 && rect.height < 140) btn.style.setProperty('top', '8px', 'important');
}

// Feed-card button visibility is driven from JS with INLINE !important styles
// (inline beats any stylesheet rule), so it works no matter which version of
// content.css is loaded: the button exists on every card but is only visible
// while the pointer is over THAT card.
function pdSetHoverVisible(btn, on) {
  if (!on && btn.classList.contains('pd-loading')) return; // keep spinner visible
  // The real button never paints (it only holds layout + the click handler).
  // What the user SEES is a floating mirror drawn on top of everything, see
  // pdMirror* below. Reason: Pinterest's hover layer sat above the in-card
  // button and washed it out / ate the clicks.
  btn.style.setProperty('opacity', '0', 'important');
  btn.style.setProperty('visibility', 'hidden', 'important');
  btn.style.setProperty('pointer-events', 'none', 'important');
  if (on) {
    btn.dataset.pdOn = '1';
    pdMirrorFor = btn;
  } else {
    delete btn.dataset.pdOn;
    if (pdMirrorFor === btn) pdMirrorFor = null;
  }
  pdMirrorSchedule();
}

// --- Floating mirror: the visible download button ---
// One element on <html>, position:fixed, max z-index => always above Pinterest's
// own hover layers. It copies the real button's look and sits exactly on top
// of it. pointer-events:none: all clicks are handled by pdInterceptPointer.
let pdMirrorFor = null;
let pdMirrorRaf = 0;

// The element under the pointer belongs to this button's card, not to a menu,
// flyout or dialog Pinterest draws on top of it (e.g. the "Kaydet" board
// picker). The hover button is painted in the top layer, above all of those.
function pdTargetInCard(b, t) {
  const h = b && b.parentElement;
  if (!h || !(t instanceof Element)) return false;
  if (h.contains(t)) return true;
  const card = pdCardOf(h);
  return !!card && card.contains(t);
}

// Something that is not part of the card (sticky search header, a menu or
// flyout, a dialog) is on top of the button's spot.
function pdCovered(x, y, host) {
  let top = null;
  // Skip our own floating mirror: it is position:fixed and sits exactly on the
  // spot being tested, so it used to "cover" itself -> hide -> show -> hide...
  try {
    top = document.elementsFromPoint(x, y).find((el) => el !== pdMirrorHost) || null;
  } catch {}
  if (!top) return false;
  if (top.contains(host)) return false;          // gap in the card: page shows through
  const card = pdCardOf(host) || host;
  return !card.contains(top);
}

// The mirror lives in a CLOSED SHADOW ROOT and in the browser's TOP LAYER
// (Popover API). Shadow DOM: no page stylesheet can touch it (and no extension
// class can be overridden by one), so it always renders as an opaque pill.
// Top layer: it is painted above every element on the page regardless of
// z-index / stacking contexts, i.e. above Pinterest's hover layers.
let pdMirrorHost = null;
let pdMirrorPill = null;

function pdBuildMirror() {
  const host = document.createElement('div');
  host.id = 'pd-hover-mirror';
  host.style.cssText = [
    'all:initial', 'inset:auto', 'position:absolute', 'left:0', 'top:0',
    'z-index:2147483647', 'pointer-events:none', 'margin:0', 'padding:0',
    'border:0', 'background:transparent', 'overflow:visible',
    'width:auto', 'height:auto', 'opacity:1', 'filter:none', 'display:none'
  ].map((d) => d + ' !important').join(';');
  try { host.setAttribute('popover', 'manual'); } catch {}

  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .p{all:initial;display:inline-flex;align-items:center;justify-content:center;
       box-sizing:border-box;background:#e9e9e9;color:#111;border-radius:24px;
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",Helvetica,Arial,sans-serif;
       font-weight:600;font-size:14px;line-height:1.2;padding:0 16px;min-height:36px;
       white-space:nowrap;box-shadow:none;text-shadow:none;opacity:1;
       filter:none;mix-blend-mode:normal;pointer-events:none;
       -webkit-font-smoothing:antialiased}
    .p.hot{background:#dadada}
    .p.load{color:transparent;font-size:0;min-width:42px;padding:0 8px}
    .p.load::after{content:'';box-sizing:border-box;width:16px;height:16px;
       border:3px solid rgba(17,17,17,.18);border-top-color:#111;border-radius:50%;
       animation:s .7s linear infinite}
    @keyframes s{to{transform:rotate(360deg)}}
  `;
  const pill = document.createElement('div');
  pill.className = 'p';
  root.appendChild(style);
  root.appendChild(pill);

  (document.documentElement || document.body).appendChild(host);
  pdMirrorHost = host;
  pdMirrorPill = pill;
}

// Promote to the top layer. Re-done whenever it is shown: showPopover() puts
// the element on top of anything promoted before it (e.g. Pinterest dialogs).
function pdMirrorToTopLayer() {
  const h = pdMirrorHost;
  if (!h || typeof h.showPopover !== 'function') return;
  try {
    if (h.matches(':popover-open')) h.hidePopover();
    h.showPopover();
  } catch {}
}

function pdMirrorHide() {
  if (pdMirrorHost) pdMirrorHost.style.setProperty('display', 'none', 'important');
  pdMirrorShown = false;
  pdMirrorPlacedFor = null;   // next time it is shown it is positioned again (once)
}
let pdMirrorShown = false;
// The mirror is positioned ONCE per appearance. Pinterest scales the card
// while the mouse button is held down (press-down animation), which moved the
// real button's rect and made the mirror jitter along with it. So we do not
// follow the real button continuously any more; we only re-position on
// scroll / resize (pdMirrorReflow), where the page really moved.
let pdMirrorPlacedFor = null;
let pdMirrorReflow = false;

// If the floating mirror throws for ANY reason (shadow DOM / popover API /
// page quirks) the hover button used to disappear silently, because the real
// button is always visibility:hidden. Fallback: show the real button itself.
function pdMirrorUpdate() {
  try {
    pdMirrorUpdateInner();
  } catch (err) {
    pdAttachError = 'mirror: ' + String((err && err.message) || err);
    const real = pdMirrorFor;
    if (real && real.isConnected && real.dataset.pdOn === '1') {
      real.style.setProperty('visibility', 'visible', 'important');
      real.style.setProperty('opacity', '1', 'important');
      real.style.setProperty('pointer-events', 'auto', 'important');
      real.style.setProperty('z-index', '2147483647', 'important');
    }
  }
}

function pdMirrorUpdateInner() {
  pdMirrorRaf = 0;
  const real = pdMirrorFor;
  if (real && !real.isConnected) {
    // React removed/replaced the card's button. Do not just vanish: look up
    // the button under the (still) pointer and show that one.
    pdMirrorFor = null;
    pdActiveBtn = null;
    pdMirrorHide();
    pdRefreshSoon();
    return;
  }
  if (!real || real.dataset.pdOn !== '1') { pdMirrorHide(); return; }

  const r = real.getBoundingClientRect();
  if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > window.innerHeight ||
      r.right < 0 || r.left > window.innerWidth) { pdMirrorHide(); return; }

  // Hidden while the card's button spot is under the sticky search header or
  // a Pinterest menu / flyout.
  if (pdCovered(r.left + r.width / 2, r.top + r.height / 2, real.parentElement || real)) {
    pdMirrorHide();
    return;
  }

  if (!pdMirrorHost) pdBuildMirror();
  const pill = pdMirrorPill;

  const loading = real.classList.contains('pd-loading');
  const hot = !!real.style.getPropertyValue('background');
  pill.className = 'p' + (hot ? ' hot' : '') + (loading ? ' load' : '');

  const text = loading ? '' : real.textContent;
  if (pill.textContent !== text) pill.textContent = text;

  // Size copied from the real button (compact on small cards).
  const fs = real.style.getPropertyValue('font-size');
  const pad = real.style.getPropertyValue('padding');
  const mh = real.style.getPropertyValue('min-height');
  if (!loading) {
    pill.style.fontSize = fs || '';
    pill.style.padding = pad || '';
    pill.style.minHeight = mh || '';
  } else {
    pill.style.fontSize = pill.style.padding = pill.style.minHeight = '';
  }

  const h = pdMirrorHost;
  if (pdMirrorPlacedFor !== real || pdMirrorReflow) {
    // Document coordinates (viewport + scroll offset). The mirror is
    // position:absolute in the top layer, so the browser scrolls it together
    // with the card; no per-frame JS following, hence no lag / drifting out
    // of the card while scrolling.
    const sx = window.scrollX || document.documentElement.scrollLeft || 0;
    const sy = window.scrollY || document.documentElement.scrollTop || 0;
    h.style.setProperty('left', Math.round(r.left + sx) + 'px', 'important');
    h.style.setProperty('top', Math.round(r.top + sy) + 'px', 'important');
    pdMirrorPlacedFor = real;
    pdMirrorReflow = false;
  }
  h.style.setProperty('display', 'block', 'important');
  if (!pdMirrorShown) {
    pdMirrorShown = true;
    pdMirrorToTopLayer();
  }
}

function pdMirrorSchedule() {
  if (!pdMirrorRaf) pdMirrorRaf = requestAnimationFrame(pdMirrorUpdate);
}
const pdMirrorReflowSchedule = () => { pdMirrorReflow = true; pdMirrorSchedule(); };
const pdMirrorOnScroll = (e) => {
  // Page (window) scroll moves the mirror natively. Only scrolling inside an
  // inner container (which does NOT move an absolutely positioned top-layer
  // element) needs a re-measure.
  const t = e && e.target;
  if (t && t !== document && t !== document.documentElement && t !== document.body) {
    pdMirrorReflow = true;
  }
  pdMirrorSchedule();            // visibility only (off-screen / under header)
  // While the page is scrolling the button stays glued to ITS card (the
  // browser moves both together). Switching to whichever card is under the
  // pointer is postponed until scrolling has stopped; doing it live made the
  // button jump from card to card.
  pdScrolling = true;
  clearTimeout(pdScrollSettleTimer);
  pdScrollSettleTimer = setTimeout(() => {
    pdScrolling = false;
    try { pdRefreshFromLastPointer(); } catch {}
  }, 160);
};
let pdScrolling = false;
let pdScrollSettleTimer = 0;
window.addEventListener('scroll', pdMirrorOnScroll, { passive: true, capture: true });
window.addEventListener('resize', pdMirrorReflowSchedule, { passive: true });
// (No periodic polling any more: it re-measured the card during the
// press-and-hold scale animation and made the button move.)

// Which feed-card button is currently shown. Driven by POINTER POSITION, not by
// the host element's own :hover state.
//
// Why: on newer Pinterest cards the host we attach to is only the small div
// wrapping the pin link. When the pointer is over the card, Pinterest draws
// its own hover layer ("Kaydet" etc.) as a SIBLING of that div, so the host
// stops being :hover / fires mouseleave and the button vanished immediately.
// Instead we look at where the pointer is, find the card around it, and show
// the button whose host rectangle contains the pointer.
let pdActiveBtn = null;
let pdMoveRaf = 0;
let pdLastMove = null;

function pdFindButtonUnderPointer(e) {
  let t = e.target instanceof Element ? e.target : null;
  if (!t) return null;
  const own = t.closest('.pd-hover-btn');
  if (own) return own;

  const x = e.clientX;
  const y = e.clientY;
  const inside = (b) => {
    const h = b.parentElement;
    if (!h) return false;
    const r = h.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  // Climb to the smallest ancestor that contains a button: that is the card
  // (or the column) around the pointer, including sibling hover layers.
  for (let a = t; a && a !== document.documentElement; a = a.parentElement) {
    const list = a.querySelectorAll('.pd-hover-btn');
    if (!list.length) continue;
    if (list.length > 80) return null;      // far too broad: pointer is in a gap
    // Inside a card's rectangle is not enough: a menu over the card climbs
    // up to a shared ancestor too, so the pointer's element must be the card's.
    for (const b of list) if (inside(b)) return pdTargetInCard(b, t) ? b : null;
    return null;
  }
  return null;
}

// Pointer is inside the button's OWN rectangle (not just inside the card)?
function pdPointerInsideBtn(b, e) {
  const r = b.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right &&
         e.clientY >= r.top && e.clientY <= r.bottom;
}

function pdSetHot(b, hot) {
  // Inline, because the CSS :hover rule cannot match while Pinterest's own
  // hover layer sits on top of the button.
  if (hot) b.style.setProperty('background', '#dadada', 'important');
  else b.style.removeProperty('background');
  pdMirrorSchedule();
}

// Pointer still inside the ACTIVE card's rectangle?
function pdPointerInHost(b, e) {
  const h = b && b.isConnected ? b.parentElement : null;
  if (!h) return false;
  const r = h.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right &&
         e.clientY >= r.top && e.clientY <= r.bottom;
}

// Re-evaluate from the LAST known pointer position without a new mouse event
// (e.g. React replaced the button while the pointer was standing still).
let pdRefreshRaf = 0;
function pdRefreshFromLastPointer() {
  if (!pdLastMove) return;
  const x = pdLastMove.clientX, y = pdLastMove.clientY;
  const t = document.elementFromPoint(x, y);
  if (t) pdUpdateActive({ target: t, clientX: x, clientY: y });
}
function pdRefreshSoon() {
  if (pdRefreshRaf) return;
  pdRefreshRaf = requestAnimationFrame(() => {
    pdRefreshRaf = 0;
    try { pdRefreshFromLastPointer(); } catch {}
  });
}

function pdUpdateActive(e) {
  let found = pdFindButtonUnderPointer(e);
  // Hysteresis: Pinterest's hover layers make the lookup return null for a
  // moment even though the pointer is still on the same card. Only hide when
  // the pointer has really left the active card.
  if (!found && pdActiveBtn && pdPointerInHost(pdActiveBtn, e) &&
      pdTargetInCard(pdActiveBtn, e.target)) found = pdActiveBtn;
  if (pdActiveBtn && pdActiveBtn !== found) {
    pdSetHoverVisible(pdActiveBtn, false);
    pdSetHot(pdActiveBtn, false);
  }
  if (found) {
    pdSetHoverVisible(found, true);
    pdSetHot(found, pdPointerInsideBtn(found, e));
  }
  pdActiveBtn = found;
}

// --- Click interception ---
// Pinterest draws its own hover layer over the card (it holds "Kaydet" and
// opens the pin on click). That layer can sit ABOVE our button, so real clicks
// never reach it: the pin opened instead of downloading. Our button lives in a
// small wrapper with its own stacking context, so z-index cannot fix this.
// Instead, catch the pointer events first (window, capture phase); if the
// pointer is inside our visible button's rectangle, swallow the event so
// Pinterest never sees it, and fire the button's own click handler ourselves.
let pdForwarding = false;
function pdButtonAtPointer(e) {
  if (pdForwarding || typeof e.clientX !== 'number') return null;
  const b = pdFindButtonUnderPointer(e);
  if (!b || b.dataset.pdOn !== '1') return null;       // hidden buttons never take clicks
  return pdPointerInsideBtn(b, e) ? b : null;
}
function pdInterceptPointer(e) {
  let b = null;
  try { b = pdButtonAtPointer(e); } catch {}
  if (!b) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.type === 'click') {
    pdForwarding = true;
    try {
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } finally {
      pdForwarding = false;
    }
  }
}
['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick']
  .forEach((t) => window.addEventListener(t, pdInterceptPointer, true));

document.addEventListener('mousemove', (e) => {
  pdLastMove = e;
  if (pdScrolling) return;      // no card switching mid-scroll
  if (pdMoveRaf) return;
  pdMoveRaf = requestAnimationFrame(() => {
    pdMoveRaf = 0;
    if (pdScrolling) return;
    try { pdUpdateActive(pdLastMove); } catch {}
  });
}, { passive: true, capture: true });

// Pointer left the page: hide whatever is shown.
document.documentElement.addEventListener('mouseleave', () => {
  pdLastMove = null;
  if (pdActiveBtn) { pdSetHoverVisible(pdActiveBtn, false); pdActiveBtn = null; }
});

function pdBindHover(pin) {
  // Keyboard focus support only; mouse hover is handled globally above.
  if (pin.__pdHoverBound) return;
  pin.__pdHoverBound = true;
  const get = () => pin.querySelector(':scope > .pd-hover-btn');
  pin.addEventListener('focusin',  () => { const b = get(); if (b) pdSetHoverVisible(b, true); });
  pin.addEventListener('focusout', () => { const b = get(); if (b && b !== pdActiveBtn) pdSetHoverVisible(b, false); });
}

function attachHoverButton(pin) {
    // On pin DETAIL pages the main pin has its own button (#pd-pinpage-btn);
    // a hover button there would overlap Pinterest's back arrow. Related-pin
    // cards around it keep their hover buttons.
    if (pin.closest('[data-test-id="pin-detail-media"], [data-test-id="closeup-image"]')) return;
    // User setting: hide hover buttons entirely
    if (!PD_SETTINGS.showHover) return;
    // Pinterest (React) can remove the button from DOM; check presence instead of a flag.
    if (pin.querySelector(':scope > .pd-hover-btn')) return;
    if (getComputedStyle(pin).position === 'static') pin.style.position = 'relative';
    pin.classList.add('pd-hover-host');

    const btn = document.createElement('button');
    btn.className = 'pd-hover-btn';
    btn.type = 'button';
    sizeButtonForPin(btn, pin.getBoundingClientRect());
    btn.title = 'Download this pin media';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.classList.contains('pd-loading')) return;
      const found = findPinMedia(pin);
      if (!found) { pdToast('❌ No media found in this card', true); return; }
      setDownloadLoading(btn, true);
      try {
        if (found.isVideo) {
          if (!found.pinId) throw new Error('Pin ID not found');
          const vr = await downloadVideoFor(found.pinId);
          if (!vr || !vr.ok) throw new Error((vr && vr.error) || 'Video could not be downloaded');
        } else {
          const isGif = /\.gif(\?|$)/i.test(found.url) || isGifPin(pin);
          const finalUrl = await resolveImageUrl(found.url, isGif);
          const r = await pdSend({
            action: 'DOWNLOAD',
            url: finalUrl,
            type: 'image',
            filename: getFileNameFromUrl(finalUrl, Date.now() % 100000, false)
          });
          if (!r || !r.ok) throw new Error((r && r.error) || 'could not be downloaded');
        }
      } catch (err) {
        btn.title = String(err && err.message || err);
        pdToast('❌ ' + (err && err.message || err), true);
      } finally {
        setDownloadLoading(btn, false);
        btn.title = 'Download this pin media';
        // Pointer may have left the card while downloading.
        pdSetHoverVisible(btn, btn === pdActiveBtn);
      }
    });
  pin.appendChild(btn);
  pdBindHover(pin);
  // New buttons start hidden; the next pointer move shows the right one.
  pdSetHoverVisible(btn, false);
  pdRefreshSoon();
}

function attachHoverButtons(root = document) {
  // Add the button as soon as Pinterest puts a card in the DOM. Waiting for
  // an intersection callback makes it visibly arrive after fast scrolling.
  findHoverButtonHosts(root).forEach(attachHoverButton);
}

let pdAttachError = null;
let pdCleanup = null;
let pdMediaRef = null;   // media element the button is positioned on
let pdDetailPlace = null;

// --- Pin DETAIL page button ---
// The hover button works on feed pages, but on the pin detail page the
// main media is in a different container so the button is invisible.
// The user should also have a Download button when clicking a pin.
function attachPinPageButton() {
  try {
  syncPinDetailMode();
  // The DOM fallbacks below would otherwise pick any feed pin's ID.
  if (!isPinDetailPage()) return;
  if (!PD_SETTINGS.showPinBtn) return;
  // Try to get pinId from URL first, then from DOM
  let pinId = extractPinIdFromUrl(location.href);
  if (!pinId) {
    // Fallback: look in data-test-pin-id or data-pin-id attributes
    const pinEl = document.querySelector('[data-test-pin-id]') || document.querySelector('[data-pin-id]');
    if (pinEl) {
      const attr = pinEl.getAttribute('data-test-pin-id') || pinEl.getAttribute('data-pin-id');
      const m = attr && attr.match(/\d+/);
      if (m) pinId = m[0];
    }
  }
  if (!pinId) {
    // Last resort: look for pin ID in any link on the page (modal, closeup, etc.)
    const pinLink = document.querySelector('[data-test-id="pin-detail-media"] a[href*="/pin/"]') ||
                    document.querySelector('[data-test-id="closeup"] a[href*="/pin/"]') ||
                    document.querySelector('a[href*="/pin/"]');
    if (pinLink) pinId = extractPinIdFromUrl(pinLink.getAttribute('href'));
  }
  if (!pinId) return;
  const existing = document.getElementById('pd-pinpage-btn');
  if (existing) {
    removeDetailHoverButton();
    if (existing.dataset.pinId === pinId) return;
    existing.remove();
  }
  // Also when there is no button any more (it was removed together with a
  // closed dialog): stop the old one's timer and listeners.
  if (pdCleanup) { try { pdCleanup(); } catch {} pdCleanup = null; }

  pdMediaRef = null;
  removeDetailHoverButton();

  const btn = document.createElement('button');
  btn.id = 'pd-pinpage-btn';
  btn.type = 'button';
  btn.dataset.pinId = pinId;
  btn.title = 'Download this pin media';
  // No CSS class — inline !important styles only, to avoid CSS conflicts.
  // The inset/margin/size resets undo the UA styles of [popover] (see below).
  btn.style.cssText =
    'position:fixed!important;z-index:2147483647!important;' +
    'inset:auto!important;margin:0!important;width:auto!important;height:auto!important;' +
    'overflow:visible!important;' +
    // Same Pinterest "secondary" look as the feed hover buttons (.pd-hover-btn).
    'background:#e9e9e9!important;color:#111!important;' +
    'border:none!important;border-radius:24px!important;' +
    'padding:0 16px!important;min-height:36px!important;line-height:36px!important;' +
    'font-size:14px!important;font-weight:600!important;' +
    'cursor:pointer!important;box-shadow:none!important;text-shadow:none!important;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",Helvetica,Arial,sans-serif!important;' +
    '-webkit-font-smoothing:antialiased!important;' +
    'opacity:1!important;white-space:nowrap!important;' +
    'top:88px!important;right:24px!important;display:block!important;';
  btn.textContent = '\u2B07 Download';
  btn.addEventListener('mouseenter', () => btn.style.setProperty('background', '#dadada', 'important'));
  btn.addEventListener('mouseleave', () => btn.style.setProperty('background', '#e9e9e9', 'important'));
  // Top layer (Popover API), like the hover mirror: an opened pin can be shown
  // in a Pinterest dialog, which is painted above any z-index on the page.
  try { btn.setAttribute('popover', 'manual'); } catch {}
  // Append to <html> (not inside React's tree) so React cannot remove it.
  document.documentElement.appendChild(btn);

  // Anything put in the top layer after us is painted above us, so re-show
  // the button whenever that set changes.
  const topLayerCount = () => {
    try { return document.querySelectorAll('dialog[open], :popover-open').length; } catch { return 0; }
  };
  // A modal dialog makes everything outside it inert: the button is painted
  // but clicks go through it. Live inside the open modal while there is one.
  const hostFor = () => {
    let modals = [];
    try { modals = document.querySelectorAll('dialog:modal'); } catch {}
    return modals[modals.length - 1] || document.documentElement;
  };
  let promotedAt = -1;
  const promote = () => {
    const host = hostFor();
    if (btn.parentElement !== host) {
      host.appendChild(btn);    // moving closes the popover; show it again
      promotedAt = -1;
    }
    if (typeof btn.showPopover !== 'function' || topLayerCount() === promotedAt) return;
    try {
      if (btn.matches(':popover-open')) btn.hidePopover();
      btn.showPopover();
    } catch {}
    promotedAt = topLayerCount();
  };

  // Viewport coordinates, re-measured on every scroll (window OR an inner
  // container) and on a timer. Placing it once in document coordinates broke
  // when the pin was opened from a scrolled feed or scrolled inside a modal:
  // the button ended up far off-screen. The media is re-found whenever the
  // locked one is gone or hidden (e.g. a feed image picked mid-transition).
  const set = (prop, val) => btn.style.setProperty(prop, val, 'important');
  const placeBtn = () => {
    if (!btn.isConnected) return false;
    promote();
    if (!pdMediaUsable(pdMediaRef)) pdMediaRef = findPinDetailMainMedia();
    const media = pdMediaRef;
    if (!media) {
      // Not found (yet): keep the button visible in a fixed corner.
      set('left', 'auto'); set('right', '24px'); set('top', '88px');
      set('visibility', 'visible');
      return false;
    }
    const r = media.getBoundingClientRect();
    const bw = btn.offsetWidth || 120;
    const bh = btn.offsetHeight || 36;
    // Just below Pinterest's back arrow (top-left of the pin), aligned with
    // it; without one, the same spot the feed hover button uses.
    const back = document.querySelector('[data-test-id="back-icon-button"]');
    const kr = back && back.getBoundingClientRect();
    const hasBack = !!(kr && kr.width > 0 && kr.height > 0);
    const offTop = hasBack ? kr.bottom + 8 - r.top : 64;
    const left = Math.min(Math.max(8, hasBack ? kr.left : r.left + 8), window.innerWidth - bw - 8);
    // Stay inside the visible part of the media (below the sticky header);
    // once the media scrolls away the button goes with it.
    const top = Math.min(Math.max(r.top + offTop, 88), r.bottom - bh - 12);
    set('right', 'auto');
    set('left', Math.round(left) + 'px');
    set('top', Math.round(top) + 'px');
    // The button is in the top layer, above Pinterest's menus and flyouts:
    // hide it while one of them covers this spot of the pin.
    let under = null;
    try {
      under = document.elementsFromPoint(left + bw / 2, top + bh / 2)
        .find((el) => el !== btn && !btn.contains(el)) || null;
    } catch {}
    const area = media.closest(
      '[data-test-id="closeup-image"], [data-test-id="pin-detail-media"], [data-test-id="closeup"]'
    ) || media.parentElement;
    const covered = !!under && !under.contains(media) && !(area && area.contains(under));
    set('visibility', covered ? 'hidden' : 'visible');
    return true;
  };
  let placeRaf = 0;
  const schedulePlace = () => {
    if (!placeRaf) placeRaf = requestAnimationFrame(() => { placeRaf = 0; placeBtn(); });
  };
  const placeTimer = setInterval(placeBtn, 300);
  window.addEventListener('resize', schedulePlace, { passive: true });
  window.addEventListener('scroll', schedulePlace, { passive: true, capture: true });
  pdCleanup = () => {
    clearInterval(placeTimer);
    cancelAnimationFrame(placeRaf);
    window.removeEventListener('resize', schedulePlace);
    window.removeEventListener('scroll', schedulePlace, { capture: true });
  };
  placeBtn();

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.classList.contains('pd-loading')) return;
    setDownloadLoading(btn, true);

    // 1) Is this pin really video? (look only at main media; do not bind
    //    related pins' videos to this pin)
    let hasVideoHere = false;
    try {
      const mediaRoot =
        document.querySelector('[data-test-id="pin-detail-media"]') ||
        document.querySelector('[data-test-id="closeup"]');
      hasVideoHere =
        !!(mediaRoot && mediaRoot.querySelector('video')) ||
        looksLikeVideoPin(mediaRoot);
    } catch {}

    try {
      if (hasVideoHere) {
        // If video fails, do NOT fall back to the image (cover): the user
        // wants video, silently downloading the thumbnail would mislead.
        const r = await downloadVideoFor(pinId);
        if (!r || !r.ok) throw new Error((r && r.error) || 'Video could not be downloaded');
        return;
      }

      // 2) Main image (if not video)
      const img =
        document.querySelector('[data-test-id="pin-detail-media"] img') ||
        document.querySelector('[data-test-id="closeup"] img') ||
        (document.querySelectorAll('img').length
          ? [...document.querySelectorAll('img')].sort(
              (a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight)
            )[0]
          : null);

      if (!img) throw new Error('No media found on this page');

      const src = img.currentSrc || img.src;
      const isGif = /\.gif(\?|$)/i.test(src);
      const finalUrl = await resolveImageUrl(src.replace(/\/\d+x\d*\//, '/originals/'), isGif);

      const r = await pdSend({
        action: 'DOWNLOAD',
        url: finalUrl,
        type: 'image',
        filename: getFileNameFromUrl(finalUrl, pinId.slice(-6), false)
      });
      if (!r || !r.ok) throw new Error((r && r.error) || 'could not be downloaded');
    } catch (err) {
      btn.title = String(err && err.message || err);
      pdToast('❌ ' + (err && err.message || err), true);
    } finally {
      setDownloadLoading(btn, false);
      btn.title = 'Download this pin media';
    }
  });
  pdAttachError = null;
  } catch (e) {
    pdAttachError = String(e && e.message || e);
  }
}

// Only inspect newly added card nodes. Re-scanning the complete feed after
// every React mutation causes visible lag on long Pinterest pages.
let isAttaching = false;
function scheduleAttach(records) {
  if (isAttaching) return;
  isAttaching = true;
  try {
    try { pdBoardMenuSync(); } catch {}
    syncPinDetailMode();
    if (isPinDetailPage()) {
      removeDetailHoverButton();
      try { attachPinPageButton(); } catch {}
      // fall through: related-pin cards below still need their hover buttons
    }
    if (records && records.length) {
      const roots = new Set();
      records.forEach((record) => {
        const removedButton = [...record.removedNodes].some(
          (node) => node instanceof Element && node.classList.contains('pd-hover-btn')
        );
        if (removedButton && record.target instanceof Element) roots.add(record.target);

        record.addedNodes.forEach((node) => {
          if (!(node instanceof Element) || node.classList.contains('pd-hover-btn')) return;
          roots.add(node);
          const pinLink = node.matches('a[href*="/pin/"]') ? node : node.closest('a[href*="/pin/"]');
          if (pinLink) roots.add(pinLink);
        });
      });
      roots.forEach((root) => { try { attachHoverButtons(root); } catch {} });
    } else {
      try { attachHoverButtons(); } catch {}
    }
  } finally {
    isAttaching = false;
  }
}

// Pinterest re-renders with React; the button can be removed from DOM.
// That's why we periodically check its presence.
function ensurePinPageButton() {
  syncPinDetailMode();
  const pinId = extractPinIdFromUrl(location.href);
  const existing = document.getElementById('pd-pinpage-btn');

  if (!pinId) {
    if (existing) {
      if (pdCleanup) pdCleanup();
      existing.remove();
    }
    return;
  }

  if (!existing || existing.dataset.pinId !== pinId) {
    attachPinPageButton();
  }
}

// ============ BOARD: DOWNLOAD ALL ============
// A "Download all" pill appears on board pages (/<user>/<board>/). It collects
// EVERY pin of the board (not just the ones currently rendered) and downloads
// them into Downloads/pinterest/<user>-<board>/.
//   1) Preferred: Pinterest's same-origin JSON API (BoardResource +
//      BoardFeedResource, paginated with bookmarks) -> full list, original URLs.
//   2) Fallback: auto-scroll the page and collect cards as they render
//      (used when the API gives nothing, and for board SECTION pages).
// Click again while it runs to stop.
const pdSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PD_RESERVED_ROOTS = new Set([
  'pin', 'idea-pin', 'search', 'ideas', 'today', 'news_hub', 'settings', 'business',
  'login', 'logout', 'signup', 'explore', 'videos', 'shop', 'following', 'topics',
  'resource', 'about', 'help', 'create', 'pin-creation-tool', 'pin-builder',
  'notifications', 'messages', 'homefeed', 'collage', 'news', '_', 'user', 'sent',
  'policy', 'terms', 'static'
]);

// Board URL: /<user>/<board>/  or  /<user>/<board>/<section>/
function pdBoardInfo() {
  const raw = location.pathname.split('/').filter(Boolean);
  if (raw.length < 2 || raw.length > 3) return null;
  const dec = raw.map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  if (PD_RESERVED_ROOTS.has(dec[0].toLowerCase())) return null;
  if (dec[1].startsWith('_') || (dec[2] && dec[2].startsWith('_'))) return null; // _saved / _created
  if (isPinDetailPage()) return null;
  return {
    username: dec[0],
    slug: dec[1],
    section: dec[2] || null,
    boardPath: '/' + raw.slice(0, 2).join('/') + '/'
  };
}

async function pdPinterestGet(resource, sourceUrl, payload) {
  const api =
    location.origin + '/resource/' + resource + '/get/?source_url=' + encodeURIComponent(sourceUrl) +
    '&data=' + encodeURIComponent(JSON.stringify(payload)) + '&_=' + Date.now();
  const res = await fetch(api, {
    credentials: 'include',
    headers: {
      'X-Pinterest-PWS-Handler': 'www/[username]/[slug].js',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json'
    }
  });
  if (!res.ok) throw new Error(resource + ' HTTP ' + res.status);
  return res.json();
}

// Pin object from the feed -> { id, kind, url, isGif }
function pdItemFromPinData(d) {
  if (!d || typeof d !== 'object' || !d.id) return null;
  if (d.type && d.type !== 'pin') return null;                       // boards, sections, ...
  if (d.is_promoted || d.promoter || d.ad_match_reason || d.is_ad) return null; // ads
  const id = String(d.id);

  const videoUrl = videoSourceFromPinData(d);
  if (videoUrl || d.is_video) return { id, kind: 'video', url: videoUrl || null };

  const imgs = d.images || {};
  let url = imgs.orig && imgs.orig.url;
  if (!url) {                                                         // largest available
    let best = null;
    for (const f of Object.values(imgs)) {
      if (f && f.url && (!best || (f.width || 0) > (best.width || 0))) best = f;
    }
    url = best && best.url;
  }
  if (!url) return null;
  return { id, kind: 'image', url, isGif: /\.gif(\?|$)/i.test(url) };
}

async function pdBoardCollectViaApi(info, run, onCount) {
  if (info.section) throw new Error('section pages use the scroll collector');
  const b = await pdPinterestGet('BoardResource', info.boardPath, {
    options: { username: info.username, slug: info.slug, field_set_key: 'detail' },
    context: {}
  });
  const board = b && b.resource_response && b.resource_response.data;
  if (!board || !board.id) throw new Error('board id not found');

  const found = new Map();
  let bookmarks = null;
  let emptyPages = 0;
  for (let page = 0; page < 500 && !run.cancel; page++) {
    const options = {
      board_id: String(board.id),
      board_url: info.boardPath,
      field_set_key: 'react_grid_pin',
      layout: 'default',
      page_size: 50
    };
    if (bookmarks) options.bookmarks = bookmarks;

    let j;
    try {
      j = await pdPinterestGet('BoardFeedResource', info.boardPath, { options, context: {} });
    } catch (e) {
      if (!found.size) throw e;          // nothing yet -> let the caller fall back
      break;                             // keep what we already have
    }
    const rr = j && j.resource_response;
    const list = Array.isArray(rr && rr.data) ? rr.data : [];
    let added = 0;
    for (const d of list) {
      const it = pdItemFromPinData(d);
      if (it && !found.has(it.id)) { found.set(it.id, it); added++; }
    }
    onCount(found.size);

    const bm = (j && j.resource && j.resource.options && j.resource.options.bookmarks) ||
               (rr && rr.bookmark ? [rr.bookmark] : null);
    if (!bm || !bm[0] || bm[0] === '-end-' || String(bm[0]).startsWith('Y2JOb25lO')) break;
    bookmarks = bm;
    emptyPages = added ? 0 : emptyPages + 1;
    if (emptyPages >= 2) break;
    await pdSleep(250);
  }
  return [...found.values()];
}

// Fallback: scroll through the board and collect cards while they are rendered
// (Pinterest removes off-screen cards, so everything is gathered incrementally).
async function pdBoardCollectViaScroll(run, onCount) {
  const items = new Map();
  const grab = () => {
    for (const m of collectMedia()) {
      const key = m.type === 'video' ? 'v:' + (m.pinId || m.url) : 'i:' + m.url;
      if (items.has(key)) continue;
      if (m.type === 'video') {
        if (!m.pinId) continue;
        items.set(key, { id: m.pinId, kind: 'video', url: /^https?:/i.test(m.url) ? m.url : null });
      } else {
        items.set(key, { id: null, kind: 'image', url: m.url, isGif: !!m.isGif, resolve: true });
      }
    }
    onCount(items.size);
  };

  const startY = window.scrollY;
  window.scrollTo(0, 0);
  await pdSleep(500);
  let stale = 0;
  for (let i = 0; i < 1500 && !run.cancel; i++) {
    const before = items.size;
    grab();
    window.scrollBy(0, Math.round(window.innerHeight * 0.8));
    await pdSleep(650);
    grab();
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8;
    stale = items.size === before ? stale + 1 : 0;
    if ((atBottom && stale >= 3) || stale >= 10) break;
  }
  window.scrollTo(0, startY);
  return [...items.values()];
}

async function pdBoardDownloadImage(it, idx, extra) {
  let url = it.url;
  if (it.resolve) url = await resolveImageUrl(url, it.isGif);   // DOM thumbnails need validation
  const base = it.id ? 'pin-' + it.id : getFileNameFromUrl(url, idx, false);
  const r = await pdSend({ action: 'DOWNLOAD', url, type: 'image', filename: base, isGif: !!it.isGif, ...extra });
  if (!r || !r.ok) throw new Error((r && r.error) || 'could not be downloaded');
}

// ---- UI: board download button (placed in Pinterest's top action bar) ----
let pdBoardBtn = null;
let pdBoardRun = null;
let pdBoardResetTimer = 0;
const PD_BOARD_IDLE = 'Download all';

// Find Pinterest's top-right action bar container (holds "Paylaş", "...", etc.)
// Looks for a row of buttons arranged horizontally side-by-side at the top of
// the page — NOT just any button's parent (which could be a dropdown/vertical stack).
let pdBoardActionContainerEl = null;
let pdBoardContainerRetries = 0;
function pdBoardActionContainer() {
  if (pdBoardActionContainerEl && pdBoardActionContainerEl.isConnected) {
    return pdBoardActionContainerEl;
  }
  // Stop retrying after 30 attempts (~3 seconds)
  if (pdBoardContainerRetries > 30) return null;
  pdBoardContainerRetries++;
  // Current layout: "Paylaş" and "•••" sit in one flex row but each in its
  // own wrapper, so the "row of sibling buttons" search below finds nothing.
  const share = document.querySelector('[data-test-id="share-board-button"]');
  for (let p = share && share.parentElement, i = 0; p && i < 5; p = p.parentElement, i++) {
    const cs = getComputedStyle(p);
    if (cs.display.includes('flex') && cs.flexDirection === 'row' && p.children.length > 1) {
      pdBoardContainerRetries = 0;
      pdBoardActionContainerEl = p;
      return p;
    }
  }
  const buttons = document.querySelectorAll('button');
  const topBtns = [];
  for (let i = 0; i < buttons.length; i++) {
    const btn = buttons[i];
    const r = btn.getBoundingClientRect();
    // Top header area buttons
    if (r.top >= 0 && r.top < 140 && r.width > 30 && r.height > 20 && r.left > 0) {
      topBtns.push(btn);
    }
  }
  // Group buttons by shared parent; the action bar row has >=2 buttons side-by-side.
  const byParent = new Map();
  for (const b of topBtns) {
    const p = b.parentElement;
    if (!p || p === document.body) continue;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(b);
  }
  let best = null, bestCount = 0;
  for (const [p, bs] of byParent) {
    // Prefer parents with multiple buttons (horizontal row). Check they are
    // arranged side-by-side (similar top, different left).
    let sideBySide = false;
    for (let a = 0; a < bs.length; a++) {
      for (let c = a + 1; c < bs.length; c++) {
        const ra = bs[a].getBoundingClientRect();
        const rc = bs[c].getBoundingClientRect();
        if (Math.abs(ra.top - rc.top) < 20 && Math.abs(ra.left - rc.left) > 10) {
          sideBySide = true;
          break;
        }
      }
      if (sideBySide) break;
    }
    if (sideBySide && bs.length > bestCount) {
      best = p;
      bestCount = bs.length;
    }
  }
  if (best) {
    pdBoardContainerRetries = 0;
    pdBoardActionContainerEl = best;
    return best;
  }
  return null;
}

const PD_BOARD_BG = '#e5e5e0';         // Pinterest's "Paylaş" button gray
const PD_BOARD_BG_HOVER = '#d6d6d0';

// Idle label gets a drawn download icon like "Paylaş" has (the ⬇ character
// turns into a blue emoji on Windows).
function pdBoardSetLabelContent(text) {
  if (!pdBoardBtn) return;
  pdBoardBtn.textContent = text;
  if (text !== PD_BOARD_IDLE) return;
  // Built with DOM calls, not innerHTML (Trusted Types on the page).
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  const attrs = {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': 2.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  svg.style.cssText = 'display:block;flex:none';
  for (const d of ['M12 4v12', 'm6 11 6 6 6-6', 'M5 21h14']) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  pdBoardBtn.prepend(svg);
}

function pdBoardSetLabel(text, cls) {
  if (!pdBoardBtn) return;
  pdBoardSetLabelContent(text);
  pdBoardBtn.dataset.state = cls || 'idle';
  if (cls === 'run') { pdBoardBtn.style.background = '#e60023'; pdBoardBtn.style.color = '#fff'; }
  else if (cls === 'err') { pdBoardBtn.style.background = '#b00020'; pdBoardBtn.style.color = '#fff'; }
  else { pdBoardBtn.style.background = PD_BOARD_BG; pdBoardBtn.style.color = '#111'; }
}

function pdBoardBuildUi() {
  const btn = document.createElement('button');
  btn.id = 'pd-board-all';
  btn.type = 'button';
  // Same size and look as Pinterest's "Paylaş" button next to it.
  btn.style.cssText =
    'all:initial;display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;' +
    'font:600 16px "Pin Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,' +
    'Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",Helvetica,Arial,sans-serif;' +
    'background:' + PD_BOARD_BG + ';color:#111;border:none;border-radius:16px;padding:0 14px;' +
    'height:48px;cursor:pointer;white-space:nowrap;align-self:center;' +
    '-webkit-font-smoothing:antialiased;';
  btn.title = 'Download every pin of this board (photos + videos)';
  btn.dataset.state = 'idle';
  btn.addEventListener('mouseenter', () => {
    if (btn.dataset.state === 'idle') btn.style.background = PD_BOARD_BG_HOVER;
  });
  btn.addEventListener('mouseleave', () => {
    if (btn.dataset.state === 'idle') btn.style.background = PD_BOARD_BG;
  });
  pdBoardBtn = btn;
  pdBoardSetLabelContent(PD_BOARD_IDLE);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (pdBoardRun) { pdBoardRun.cancel = true; pdBoardSetLabel('Stopping…', 'run'); }
    else pdBoardStart();
  });
  return btn;              // pdBoardBtn (set above) prevents a duplicate every 500ms
}

// Show the button in Pinterest's top-right action bar on board pages.
// Cached board-page detection (URL-based, cheap). Invalidate on navigation.
let pdBoardInfoCache = null;
let pdBoardInfoCacheUrl = '';
function pdBoardInfoCached() {
  if (pdBoardInfoCache && location.href === pdBoardInfoCacheUrl) return pdBoardInfoCache;
  pdBoardInfoCacheUrl = location.href;
  pdBoardInfoCache = pdBoardInfo();
  return pdBoardInfoCache;
}

// Have we seen any rendered pin link on this board page?
let pdBoardHasPinsCache = false;
function pdBoardHasPins() {
  if (pdBoardHasPinsCache) return true;
  pdBoardHasPinsCache = !!document.querySelector('a[href*="/pin/"]');
  return pdBoardHasPinsCache;
}

// Show the button in Pinterest's top-right action bar on board pages.
// Runs only on navigation + a lightweight interval — NOT on every DOM mutation.
function pdBoardSync() {
  const want = PD_SETTINGS.showBoardBtn && !!pdBoardInfoCached() && pdBoardHasPins();
  const container = pdBoardActionContainer();
  const has = !!(pdBoardBtn && pdBoardBtn.isConnected);
  if (want && container && !has) {
    const ui = pdBoardBuildUi();
    container.prepend(ui);                   // left of "Paylaş"
    // "Paylaş" sits a few px down inside its own wrapper; line up with it.
    const share = container.querySelector('[data-test-id="share-board-button"]');
    if (share) {
      ui.style.alignSelf = 'flex-start';
      const dy = share.getBoundingClientRect().top - ui.getBoundingClientRect().top;
      if (dy > 0 && dy < 40) ui.style.marginTop = Math.round(dy) + 'px';
    }
  } else if ((!want || !container) && has && !pdBoardRun) {
    pdBoardBtn.remove();
    pdBoardBtn = null;
  }
}

// "Download all pins" entry in Pinterest's board "•••" menu
// (div[role=menu]#board_options). It is a clone of the menu's own last item so
// it looks native; a clone carries no React handlers, so our listener does
// all the work and the event never reaches React.
function pdBoardMenuSync() {
  const menu = document.getElementById('board_options');
  if (!menu || menu.querySelector('[data-pd-board-item]')) return;
  if (!PD_SETTINGS.showBoardBtn || !pdBoardInfo()) return;
  const items = menu.querySelectorAll('[role="menuitem"]');
  const last = items[items.length - 1];
  if (!last) return;

  const item = last.cloneNode(true);
  item.dataset.pdBoardItem = '1';
  item.removeAttribute('data-test-id');
  item.removeAttribute('id');
  [...item.classList].filter((c) => /^hovered/i.test(c)).forEach((c) => item.classList.remove(c));
  // The label is the deepest element that holds the native item's text.
  const label = [...item.querySelectorAll('*')].reverse()
    .find((el) => !el.children.length && el.textContent.trim());
  if (label) label.textContent = pdBoardRun ? 'Stop downloading' : 'Download all pins';

  const hoverBox = item.firstElementChild || item;
  item.addEventListener('mouseenter', () => { hoverBox.style.background = 'rgba(0,0,0,.06)'; });
  item.addEventListener('mouseleave', () => { hoverBox.style.background = ''; });
  item.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Close Pinterest's menu the same way the keyboard does.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    if (pdBoardRun) {
      pdBoardRun.cancel = true;
      pdBoardSetLabel('Stopping…', 'run');
      return;
    }
    const r = pdBoardStart();
    if (!r.ok) pdToast('❌ ' + r.error, true);
  });
  last.after(item);
}

// Throttled board-button check (runs every 500ms, not on every DOM mutation).
let pdBoardCheckTimer = null;
function pdBoardStartCheckLoop() {
  if (pdBoardCheckTimer) return;
  pdBoardCheckTimer = setInterval(() => {
    try { pdBoardSync(); } catch {}
  }, 500);
}
function pdBoardStopCheckLoop() {
  if (pdBoardCheckTimer) { clearInterval(pdBoardCheckTimer); pdBoardCheckTimer = null; }
}

// Validates synchronously, runs asynchronously. Returns { ok, error? }.
function pdBoardStart() {
  if (pdBoardRun) return { ok: false, error: 'A board download is already running' };
  const info = pdBoardInfo();
  if (!info) return { ok: false, error: 'Open a board page first' };
  pdBoardSync();
  const run = { cancel: false };
  pdBoardRun = run;
  clearTimeout(pdBoardResetTimer);
  pdBoardRunAll(info, run);
  return { ok: true };
}

async function pdBoardRunAll(info, run) {
  const setRun = (t) => pdBoardSetLabel(t, 'run');
  let done = 0, failed = 0, total = 0, firstErr = '';
  try {
    setRun('■ Stop · collecting…');
    let items = [];
    try {
      items = await pdBoardCollectViaApi(info, run, (n) => setRun('■ Stop · collecting ' + n + '…'));
    } catch { items = []; }
    if (!items.length && !run.cancel) {
      items = await pdBoardCollectViaScroll(run, (n) => setRun('■ Stop · collecting ' + n + '…'));
    }
    if (run.cancel) { pdBoardSetLabel('Stopped'); return; }
    if (!items.length) throw new Error('No pins found on this board');

    total = items.length;
    const tick = () => setRun('■ Stop · ' + (done + failed) + '/' + total);
    tick();

    // Never a save dialog per file here (a board can have hundreds of pins);
    // optionally one subfolder per board.
    const extra = {
      saveAs: false,
      subfolder: PD_SETTINGS.boardFolder
        ? [info.username, info.slug, info.section].filter(Boolean).join('-')
        : ''
    };

    // Photos: "parallel downloads" at a time (setting, 1-8).
    const images = items.filter((i) => i.kind === 'image');
    const videos = items.filter((i) => i.kind === 'video');
    let next = 0;
    const worker = async () => {
      while (!run.cancel) {
        const idx = next++;
        const it = images[idx];
        if (!it) return;
        try { await pdBoardDownloadImage(it, idx, extra); done++; }
        catch (e) { failed++; firstErr = firstErr || String((e && e.message) || e); }
        tick();
      }
    };
    const workers = Math.min(8, Math.max(1, parseInt(PD_SETTINGS.maxConcurrent, 10) || 4));
    await Promise.all(Array.from({ length: workers }, worker));

    // Videos: one by one (they may need the API / HLS merge).
    for (const v of videos) {
      if (run.cancel) break;
      try {
        if (!v.id) throw new Error('Pin ID not found');
        const r = await downloadVideoFor(v.id, v.url || undefined, extra);
        if (r && r.ok) done++; else throw new Error((r && r.error) || 'video failed');
      } catch (e) { failed++; firstErr = firstErr || String((e && e.message) || e); }
      tick();
    }

    if (run.cancel) {
      pdBoardSetLabel('Stopped · ' + done + '/' + total + ' saved');
    } else if (failed) {
      pdBoardSetLabel('⚠ ' + done + '/' + total + ' saved · ' + failed + ' failed', 'err');
      pdToast('❌ ' + failed + ' failed: ' + firstErr, true);
    } else {
      pdBoardSetLabel('✅ ' + done + ' saved');
    }
  } catch (e) {
    const m = String((e && e.message) || e);
    pdBoardSetLabel('❌ ' + m, 'err');
    pdToast('❌ ' + m, true);
  } finally {
    if (pdBoardRun === run) pdBoardRun = null;
    pdBoardResetTimer = setTimeout(() => {
      if (!pdBoardRun) pdBoardSetLabel(PD_BOARD_IDLE);
    }, 8000);
  }
}

const obs = new MutationObserver(scheduleAttach);
obs.observe(document.documentElement, { childList: true, subtree: true });
syncPinDetailMode();
attachPinPageButton();
attachHoverButtons();
try { pdBoardSync(); } catch {}
pdBoardStartCheckLoop();

// SPA navigation: update the button when URL changes
let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    if (pdBoardRun) pdBoardRun.cancel = true;     // navigated away from the board
    pdBoardContainerRetries = 0;
    pdBoardActionContainerEl = null;
    pdBoardInfoCache = null;
    pdBoardInfoCacheUrl = '';
    pdBoardHasPinsCache = false;
    try { pdBoardSync(); } catch {}
    syncPinDetailMode();
    ensurePinPageButton();
    attachHoverButtons();
  }
}, 100);
// Periodic check: re-create the pin-page button if React removed it.
setInterval(() => {
  try { if (isPinDetailPage()) attachPinPageButton(); } catch {}
}, 1500);
})();
