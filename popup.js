const grid = document.getElementById('grid');
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const refreshBtn = document.getElementById('refresh');
const allBtn = document.getElementById('downloadAll');

let currentMedia = [];

document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

// --- Tabs ---
const tabs = {
  media: [document.getElementById('tabMedia'), document.getElementById('mediaView')],
  settings: [document.getElementById('tabSettings'), document.getElementById('settingsView')]
};
function showTab(name) {
  for (const [key, [tab, view]] of Object.entries(tabs)) {
    tab.setAttribute('aria-selected', String(key === name));
    view.hidden = key !== name;
  }
}
tabs.media[0].onclick = () => showTab('media');
tabs.settings[0].onclick = () => showTab('settings');

// --- Settings (persisted in chrome.storage.local, saved on every change) ---
// Keep in sync with PD_SETTING_KEYS in content.js.
const PD_DEFAULTS = {
  pdFolder: 'pinterest',
  pdMaxConcurrent: 4,
  pdShowHover: true,
  pdShowPinBtn: true,
  pdShowBoardBtn: true,
  pdBoardFolder: true,
  pdSaveAs: false,
  pdConflict: 'uniquify',
  pdProgressToasts: false
};
let SETTINGS = { ...PD_DEFAULTS };

const $ = (id) => document.getElementById(id);
const switches = {
  setSaveAs: 'pdSaveAs',
  setBoardBtn: 'pdShowBoardBtn',
  setBoardFolder: 'pdBoardFolder',
  setHover: 'pdShowHover',
  setPinBtn: 'pdShowPinBtn',
  setToasts: 'pdProgressToasts'
};
const conflictSeg = $('setConflict');

function renderSettings() {
  $('setFolder').value = SETTINGS.pdFolder;
  $('setMax').value = SETTINGS.pdMaxConcurrent;
  $('setMaxOut').textContent = SETTINGS.pdMaxConcurrent;
  for (const [id, key] of Object.entries(switches)) $(id).checked = !!SETTINGS[key];
  conflictSeg.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.value === SETTINGS.pdConflict));
  });
}

async function loadSettings() {
  const res = await chrome.storage.local.get(Object.keys(PD_DEFAULTS));
  for (const key of Object.keys(PD_DEFAULTS)) {
    if (res[key] !== undefined && res[key] !== '') SETTINGS[key] = res[key];
  }
  renderSettings();
}

let savedTimer = 0;
async function saveSettings(patch) {
  Object.assign(SETTINGS, patch);
  await chrome.storage.local.set(patch);
  const el = $('saved');
  el.classList.add('on');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('on'), 1200);
}

for (const [id, key] of Object.entries(switches)) {
  $(id).onchange = (e) => saveSettings({ [key]: e.target.checked });
}
let folderTimer = 0;
$('setFolder').oninput = (e) => {
  clearTimeout(folderTimer);
  folderTimer = setTimeout(() => saveSettings({ pdFolder: e.target.value.trim() || PD_DEFAULTS.pdFolder }), 400);
};
$('setFolder').onblur = (e) => {
  if (!e.target.value.trim()) e.target.value = PD_DEFAULTS.pdFolder;
};
$('setMax').oninput = (e) => {
  $('setMaxOut').textContent = e.target.value;
};
$('setMax').onchange = (e) => saveSettings({ pdMaxConcurrent: parseInt(e.target.value, 10) || 4 });
conflictSeg.onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  saveSettings({ pdConflict: b.dataset.value });
  renderSettings();
};
$('resetSettings').onclick = async () => {
  await saveSettings({ ...PD_DEFAULTS });
  renderSettings();
};

function filenameFor(url, i, type) {
  // NOTE: The extension here is only a SUGGESTION. The real extension is
  // determined in background from the server's Content-Type (GIFs were .jpg).
  const base = url.startsWith('pin:') ? 'pinterest-' + (url.slice(4, 10) || i) : url;
  const ext = type === 'video' ? 'mp4' : 'jpg';
  try {
    let name = new URL(base).pathname.split('/').pop() || `pinterest-${i}`;
    name = name.split('?')[0].replace(/\.[^.]*$/, '').replace(/[<>:"/\\|?*]/g, '-').slice(0, 50);
    return `pinterest/${name || 'pin-' + i}-${i}.${ext}`;
  } catch {
    return `pinterest/pin-${Date.now()}-${i}.${ext}`;
  }
}

function showEmpty(title, text) {
  grid.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'empty';
  const strong = document.createElement('strong');
  strong.textContent = title;
  div.append(strong, text);
  grid.appendChild(div);
}

async function loadMedia() {
  grid.innerHTML = '';
  statusEl.textContent = 'Looking for media…';
  allBtn.disabled = true;

  countEl.textContent = '0';
  currentMedia = [];

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // includes('pinterest.com') would also accept addresses like evil.com/?pinterest.com.
  let onPinterest = false;
  try { onPinterest = /(^|\.)pinterest\.com$/i.test(new URL(tab.url).hostname); } catch {}
  checkBoard(tab);
  if (!tab || !onPinterest) {
    statusEl.textContent = '';
    showEmpty('Not a Pinterest tab', 'Open pinterest.com and try again.');
    return;
  }

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'GET_MEDIA' });
    if (!res?.ok) throw new Error(res?.error || 'Content script did not respond');
    currentMedia = res.media || [];
    } catch (e) {
    // content.js may not be loaded → try manual injection
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['page-hook.js'],
        world: 'MAIN'
      });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      try {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      } catch {}
      const res2 = await chrome.tabs.sendMessage(tab.id, { action: 'GET_MEDIA' });
      if (!res2?.ok) throw new Error(res2?.error || 'Content script did not respond');
      currentMedia = res2.media || [];
    } catch (e2) {
      statusEl.textContent = 'Error: ' + e2.message + ' Refresh the page and try again.';
      return;
    }
  }

  if (currentMedia.length === 0) {
    statusEl.textContent = '';
    showEmpty('No media found', 'Scroll the page a bit, then press Refresh.');
    return;
  }

  const videoCount = currentMedia.filter((m) => m.type === 'video').length;
  const imageCount = currentMedia.length - videoCount;
  statusEl.textContent = `${imageCount} photo${imageCount === 1 ? '' : 's'} · ${videoCount} video${videoCount === 1 ? '' : 's'} on this page`;
  countEl.textContent = String(currentMedia.length);
  allBtn.disabled = false;

  currentMedia.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'card';

    if (item.type === 'video') {
      // Do NOT put pin:ID / blob: pseudo-URLs into <video src>:
      // the extension looks for a file at chrome-extension://.../pin:ID and
      // throws "Failed to load resource: net::ERR_FILE_NOT_FOUND".
      const isPseudo = !item.url || item.url.startsWith('pin:') || item.url.startsWith('blob:');
      if (isPseudo && item.thumb) {
        const img = document.createElement('img');
        img.src = item.thumb;
        img.loading = 'lazy';
        img.title = 'Preview — resolved via Download/Open Link';
        card.appendChild(img);
      } else if (!isPseudo) {
        const v = document.createElement('video');
        v.src = item.url;
        v.poster = item.thumb || '';
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.preload = 'none';
        v.onmouseenter = () => v.play().catch(() => {});
        v.onmouseleave = () => v.pause();
        v.controls = false;
        card.appendChild(v);
      } else {
        const div = document.createElement('div');
        div.className = 'placeholder';
        div.textContent = 'Video (resolved on pin page)';
        card.appendChild(div);
      }
    } else {
      const img = document.createElement('img');
      img.src = item.thumb || item.url;
      img.loading = 'lazy';
      card.appendChild(img);
    }

    const isGif = item.type !== 'video' && (item.isGif || /\.gif(\?|$)/i.test(item.url || ''));
    const badge = document.createElement('span');
    badge.className = 'badge ' + (item.type === 'video' ? 'video' : (isGif ? 'gif' : ''));
    badge.textContent = item.type === 'video' ? 'VIDEO' : (isGif ? 'GIF' : 'PHOTO');
    card.appendChild(badge);

    const foot = document.createElement('div');
    foot.className = 'foot';
    const dims = document.createElement('span');
    dims.className = 'dims';
    dims.textContent = item.width && item.height ? `${item.width}×${item.height}` : '';
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Download';
    btn.onclick = () => downloadOne(item.url, i, item.type, item.pinId, item.isGif);
    foot.append(dims, btn);
    card.appendChild(foot);

    grid.appendChild(card);
  });
}



// Board pages get an extra "Download whole board" button.
const boardBar = document.getElementById('boardBar');
const boardBtn = document.getElementById('boardAll');
async function checkBoard(tab) {
  boardBar.style.display = 'none';
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { action: 'BOARD_INFO' });
    if (r && r.ok && r.board) boardBar.style.display = 'block';
  } catch {}
}
boardBtn.onclick = async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { action: 'BOARD_DOWNLOAD_ALL' }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      const m = chrome.runtime.lastError ? chrome.runtime.lastError.message : res?.error;
      statusEl.textContent = 'Error: ' + (m || 'could not start');
    } else {
      // Progress is shown on the page itself; the popup is not needed any more.
      window.close();
    }
  });
};

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function downloadOne(url, i, type, pinId, isGif) {
  // Video: let the content script API resolve the real mp4; image: download directly.
  const action = type === 'video' ? 'DOWNLOAD_VIDEO' : 'DOWNLOAD_IMAGE';
  getActiveTab().then((tab) => {
    if (!tab) return fallback();
    chrome.tabs.sendMessage(
      tab.id,
      { action, url, pinId: pinId || null, filename: filenameFor(url, i, type), type, isGif: !!isGif },
      (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          fallback(res?.error);
        } else {
          statusEl.textContent = `Download started (${i + 1})`;
        }
      }
    );
  }).catch(() => fallback());

  function fallback(detail) {
    // Last resort if content is unreachable: let background try directly
    if (type === 'video' && (!url || url.startsWith('pin:') || url.startsWith('blob:'))) {
      statusEl.textContent = 'Open the pin page (/pin/...), play the video, and try again.' + (detail ? ' (' + detail + ')' : '');
      return;
    }
    chrome.runtime.sendMessage(
      {
        action: 'DOWNLOAD', url, type, filename: filenameFor(url, i, type),
        folder: SETTINGS.pdFolder, saveAs: !!SETTINGS.pdSaveAs, conflict: SETTINGS.pdConflict
      },
      (res) => {
        if (res?.ok) statusEl.textContent = `Download started (${i + 1})`;
        else statusEl.textContent = 'Error: ' + (res?.error || detail || 'could not be downloaded');
      }
    );
  }
}

allBtn.onclick = () => {
  currentMedia.forEach((item, i) => {
    setTimeout(() => downloadOne(item.url, i, item.type, item.pinId, item.isGif), i * 600);
  });
  statusEl.textContent = `Downloading ${currentMedia.length} files…`;
};

refreshBtn.onclick = loadMedia;
loadMedia();
loadSettings();
