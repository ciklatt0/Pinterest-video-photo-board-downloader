# 📌 Pinterest Downloader (Chrome Extension)

Downloads Pinterest photos and videos in high quality.

## Features
- Downloads photos in **original quality** (`236x` → `originals` conversion)
- Downloads videos as `.mp4`
- Two ways to use:
  1. **Hover button:** A `⬇ Download` button appears when you hover over a Pin
  2. **Popup list:** Click the extension icon → view all media → download one by one or "Download All"

## Installation (Developer Mode)
1. Open `chrome://extensions` in Chrome
2. Turn on **Developer mode** in the top right
3. **Load unpacked** → select this `pinterest-downloader` folder
4. Go to `pinterest.com` and click the extension icon

## Files
- `manifest.json` → MV3 settings
- `page-hook.js` → captures video requests in the page's main world
- `content.js` → collects images/videos on the page + adds the hover button + merges HLS
- `background.js` → downloads via `chrome.downloads` + CORS-less verification (PROBE)
- `icons/` → 16/48/128 px extension icons
- `popup.html` / `popup.js` → media list UI

## Notes
- Downloads go to `Downloads/pinterest/`
- Some videos are protected on Pinterest's side; in that case open the video pin page and try again
- To publish to the store, add a 128px icon and a privacy policy

## v4.2.1 fixes
- **CORS:** Image/MP4 validation was done from the content script and got stuck on `i.pinimg.com` CORS, always failing (GIFs downloaded as `.jpg`, audio MP4 never found). Validation is now done in background (`PROBE`).
- `icons/` folder was missing → extension couldn't load. Icons added.
- `page-hook.js` runs at `document_start`, `content.js` at `document_idle`; video requests in between were lost. Now content.js re-requests them once ready.
- When the server ignores the `Range` header (HTTP 200), every HLS part was added as a full file → corrupted video. Now the byte range is cut manually; 403/404 parts throw errors.
- MPEG-TS HLS parts were saved as `.mp4` → now saved as `.ts`.
- When downloading a video from the popup with the real mp4 link, the URL itself was mistaken for the pin ID.
- On the pin page, if video download failed, the cover image was silently downloaded instead → now shows an error.
- Hover button, once removed by React, was never re-added.
- Pin page button: if no media found, scanning every 300 ms forever and jumping to a random place on scroll fixed.
- Video result failed but hover button still showed ✅.
- 'page' video record got stuck on the first video during SPA navigation.
- Popup: fake URLs containing `pinterest.com` were accepted; counter wasn't reset.
- Other: comments with broken characters cleaned; `fetch(new URL())`/`Request` formats are caught by the hook; list only includes `i.pinimg.com` images.

## v4.2.2 — Images saved as `.xml`
- Cause: If `originals/<hash>.<ext>` doesn't exist, Pinterest returns 403 + `application/xml`; this error document was downloaded as a file.
- Fix: The correct address is tried sequentially in `background.js` (jpg/png/gif/webp, then `1200x/736x/564x/474x`); only 200 + `image/*` responses are downloaded.
- If verification is blocked but XML/HTML arrives, the file is automatically deleted and a warning is shown on the page.

## v4.2.3 — Pin page button
- The button now follows the media's top-left corner as you scroll; it is hidden when the media (or its corner) leaves the screen.

## v4.4.3
- Hover button: if the floating mirror fails, the real button is now shown instead of nothing.
- The "Show hover button" setting now applies instantly (no page refresh).
- Popup: the settings gear icon is no longer replaced by text.
- `icons/` folder added (the extension does not load without it).
- Pin detail page: the Download button had no label and was not placed on the media (code was missing); it now shows `⬇ Download` on the media's top-left corner.
