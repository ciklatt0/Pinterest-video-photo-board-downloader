// Background: media download + CORS-less query (v4.2.2)
//
// IMPORTANT: HLS/part merging is NOT done here.
// MV3 service workers have no URL.createObjectURL. HLS merging is done
// in content.js, in the page context.
//
// This file's jobs:
//  1) PROBE         : returns whether a URL exists / its type.
//  2) RESOLVE_IMAGE : finds a URL that REALLY works for an image.
//  3) DOWNLOAD      : downloads. For images, first finds a working URL; if an
//                     error document (XML/HTML) arrives, the file is deleted.
// Content scripts are subject to the page's CORS rules and cannot READ
// i.pinimg.com responses; the service worker can, thanks to host_permissions.

function sanitizeFilename(name) {
  return String(name || '')
    .split('/').pop().split('?')[0]
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[. ]+$/, '')
    .slice(0, 80);
}

// Folder path inside Downloads: <folder>/[<subfolder>/]<file>. "a/b" style
// nesting is allowed; each segment is cleaned on its own.
function sanitizeFolder(name) {
  return String(name || '')
    .split(/[\\/]+/)
    .map((seg) => seg
      .replace(/[<>:"|?*\u0000-\u001f]/g, '-')
      .replace(/^[. ]+/, '')
      .replace(/[. ]+$/, '')
      .slice(0, 60))
    .filter(Boolean)
    .join('/');
}

// The real content type returned by the server. NEVER throws on error.
async function probeContentType(url) {
  try {
    let res = await fetch(url, { method: 'HEAD' });
    if (!res.ok || !res.headers.get('content-type')) {
      res = await fetch(url, { headers: { Range: 'bytes=0-1' } });
      try { res.body && res.body.cancel(); } catch {}
    }
    if (!res.ok && res.status !== 206) return { ct: '', ok: false, status: res.status };
    return {
      ct: (res.headers.get('content-type') || '').toLowerCase(),
      ok: true,
      status: res.status
    };
  } catch (e) {
    return { ct: '', ok: false, status: 0, err: String((e && e.message) || e) };
  }
}

const isErrorDoc = (ct) =>
  /xml|html|json/.test(ct || '') || String(ct || '').startsWith('text/');

// ---- Image URL resolution ----
// If originals/<hash>.<ext> doesn't exist on Pinterest, the server returns
// 403 + application/xml (and the file is saved as .xml). The correct
// extension can't be guessed from the thumbnail (jpg/png/gif/webp possible)
// and some images have no 'originals' at all. So candidates are tried in
// order; the FIRST returning 200 + image/* wins.
function imageCandidates(url, isGifHint) {
  const q = (url.match(/\?.*$/) || [''])[0];
  const noQ = url.replace(/\?.*$/, '');
  const base = noQ.replace(/\.[a-z0-9]{2,5}$/i, '');
  const withExt = (e) => base + '.' + e + q;
  const c = [];

  if (isGifHint || /\.gif$/i.test(noQ)) c.push(withExt('gif'));
  c.push(url, withExt('jpg'), withExt('png'), withExt('gif'), withExt('webp'));

  // If there's no 'originals' at all: smaller versions found on every pin.
  if (/\/originals\//.test(noQ)) {
    for (const size of ['1200x', '736x', '564x', '474x']) {
      for (const e of ['jpg', 'png', 'webp']) {
        c.push(withExt(e).replace('/originals/', '/' + size + '/'));
      }
    }
  }
  return [...new Set(c)];
}

async function pickWorkingImage(url, isGifHint) {
  for (const cand of imageCandidates(url, isGifHint)) {
    const p = await probeContentType(cand);
    if (p.ok && String(p.ct).startsWith('image/')) return { url: cand, ct: p.ct };
  }
  return null;
}

// Content-Type -> file extension
function extensionFor(contentType, url, isVideo) {
  const ct = String(contentType || '').toLowerCase();
  if (isVideo) return 'mp4';
  if (ct) {
    if (ct.includes('gif')) return 'gif';
    if (ct.includes('png')) return 'png';
    if (ct.includes('webp')) return 'webp';
    if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
    if (ct.includes('avif')) return 'avif';
    if (ct.includes('bmp')) return 'bmp';
  }
  const m = String(url || '').match(/\.(gif|png|webp|jpg|jpeg|avif|bmp)(\?|$)/i);
  if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  return 'jpg';
}

function saveWithDownloads(url, filename, opts = {}) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url,
        filename,
        conflictAction: opts.conflict === 'overwrite' ? 'overwrite' : 'uniquify',
        saveAs: !!opts.saveAs
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else if (downloadId === undefined) {
          resolve({ ok: false, error: 'Download could not be started' });
        } else {
          resolve({ ok: true, downloadId, filename });
        }
      }
    );
  });
}

// ---- Last line of defense: delete if error document ----
// Even if validation (HEAD/Range) is blocked, .xml/.html files must not
// remain on disk. Stateless (service worker may sleep): when the event
// arrives, checks whether this extension started the download (the folder
// is configurable, so it cannot be recognised by its path).
function notifyPinterestTabs(text) {
  try {
    chrome.tabs.query({ url: ['https://*.pinterest.com/*'], active: true }, (tabs) => {
      void chrome.runtime.lastError;
      (tabs || []).forEach((t) =>
        chrome.tabs.sendMessage(t.id, { action: 'TOAST', text, error: true }, () => void chrome.runtime.lastError)
      );
    });
  } catch {}
}

chrome.downloads.onChanged.addListener((delta) => {
  const done = delta.state && delta.state.current === 'complete';
  const failed = delta.state && delta.state.current === 'interrupted';
  if (!done && !failed) return;
  chrome.downloads.search({ id: delta.id }, (items) => {
    void chrome.runtime.lastError;
    const it = items && items[0];
    if (!it || it.byExtensionId !== chrome.runtime.id) return;

    if (failed) {
      if (/FORBIDDEN|NOT_FOUND|BAD_CONTENT/.test(it.error || '')) {
        notifyPinterestTabs('❌ Server did not provide the file (' + it.error + ')');
      }
      return;
    }
    const bad = isErrorDoc((it.mime || '').toLowerCase()) || /\.(xml|html?|json)$/i.test(it.filename || '');
    if (bad) {
      chrome.downloads.removeFile(delta.id, () => {
        void chrome.runtime.lastError;
        chrome.downloads.erase({ id: delta.id });
      });
      notifyPinterestTabs('❌ Pinterest returned an error page instead of a file; download deleted.');
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  // --- CORS-less validation ---
  if (msg.action === 'PROBE') {
    (async () => {
      if (!msg.url || !/^https:\/\//i.test(msg.url)) {
        sendResponse({ ok: false, status: 0, ct: '' });
        return;
      }
      sendResponse(await probeContentType(msg.url));
    })();
    return true;
  }

  // --- Find a working image URL ---
  if (msg.action === 'RESOLVE_IMAGE') {
    (async () => {
      if (!msg.url || !/^https:\/\//i.test(msg.url)) { sendResponse({ ok: false }); return; }
      const found = await pickWorkingImage(msg.url, !!msg.isGif);
      sendResponse(found ? { ok: true, url: found.url, ct: found.ct } : { ok: false });
    })();
    return true;
  }

  if (msg.action === 'DOWNLOAD') {
    (async () => {
      try {
        if (!msg.url || !/^https?:/i.test(msg.url)) {
          sendResponse({ ok: false, error: 'No valid media link' });
          return;
        }
        if (/\.m3u8(\?|$)/i.test(msg.url)) {
          sendResponse({ ok: false, error: 'HLS playlist cannot be downloaded directly' });
          return;
        }
        const isVideo = msg.type === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(msg.url);

        let finalUrl = msg.url;
        let probe = await probeContentType(finalUrl);

        // IMAGE: if the given URL doesn't work (403/XML/HTML), find a working candidate.
        // Popup's fallback path and all calls that skip validation pass through here.
        if (!isVideo && !(probe.ok && String(probe.ct).startsWith('image/'))) {
          const found = await pickWorkingImage(msg.url, !!msg.isGif);
          if (found) {
            finalUrl = found.url;
            probe = { ok: true, ct: found.ct, status: 200 };
          }
        }

        // Only download if we're SURE it's an error document.
        if (probe.ok && isErrorDoc(probe.ct)) {
          sendResponse({
            ok: false,
            error:
              'Server returned an error page instead of a file (' + (probe.ct || 'unknown') + ') and ' +
              'no working alternative was found. Open the pin page and try again.'
          });
          return;
        }

        const ext = extensionFor(probe.ct, finalUrl, isVideo);

        let base = msg.filename || `pin-${Date.now()}`;
        base = sanitizeFilename(base).replace(/\.[^.]*$/, '') || `pin-${Date.now()}`;
        // Even if validation is BLOCKED (probe.ok=false) it is still tried; if an
        // error document arrives, the onChanged listener deletes the file.
        const folder = sanitizeFolder(msg.folder) || 'pinterest';
        const sub = sanitizeFolder(msg.subfolder);
        sendResponse(await saveWithDownloads(
          finalUrl,
          folder + '/' + (sub ? sub + '/' : '') + base + '.' + ext,
          { saveAs: msg.saveAs, conflict: msg.conflict }
        ));
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.action === 'DOWNLOAD_HLS') {
    sendResponse({
      ok: false,
      error: "HLS can't be processed in the service worker — downloading from the page."
    });
    return true;
  }
});
