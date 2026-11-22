// Injected into the page's MAIN world.
// Content script runs in an isolated world, so changing window.fetch there
// does NOT let it see the page's requests. That's why the hook is injected
// directly into the page's own JS world.
(() => {
  if (window.__pdHooked) return;
  window.__pdHooked = true;
  try { document.documentElement.setAttribute('data-pd-hooked', '1'); } catch {}

  const MEDIA_RE = /\.(mp4|m3u8|ts|m4s|aac|webm)(\?|$)/i;

  // This hook runs at document_start, content.js at document_idle.
  // In between, captured URLs would be lost before content.js starts listening.
  // That's why we store them all; when content.js is ready it sends
  // { __pdResend: true } and gets them all back.
  const seen = new Set();

  const post = (url) => {
    try { window.postMessage({ __pdMedia: true, url }, location.origin); } catch {}
  };

  // Convert fetch(Request) / fetch(URL) / XHR.open(URL) forms to strings too.
  const toUrl = (x) => {
    if (!x) return '';
    if (typeof x === 'string') return x;
    if (typeof x.url === 'string') return x.url;     // Request
    if (typeof x.href === 'string') return x.href;   // URL
    return '';
  };

  const send = (raw) => {
    const url = toUrl(raw);
    if (!url || !MEDIA_RE.test(url)) return;
    if (!/pinimg\.com/i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    post(url);
  };

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.__pdResend === true) seen.forEach(post);
  });

  // fetch
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    try { send(args[0]); } catch {}
    // Preserving the `this` context is MANDATORY (otherwise Chrome throws
  // "Illegal invocation").
    return origFetch.apply(window, args);
  };

  // XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try { send(url); } catch {}
    return origOpen.call(this, method, url, ...rest);
  };

  // Performance entries (catches already-loaded ones too)
  const scan = () => {
    try {
      performance.getEntriesByType('resource').forEach((e) => send(e.name));
    } catch {}
  };
  scan();
  try {
    new PerformanceObserver(scan).observe({ type: 'resource', buffered: true });
  } catch {}
  setInterval(scan, 1500);
})();
