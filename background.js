// background.js
//
// Service worker for the Poetrystack extension. Its only job is screenshotting
// the on-screen quote card so content.js can attach it as an image in the
// Substack composer.
//
// Why this can't live in content.js: capturing pixels off the visible tab
// requires chrome.tabs.captureVisibleTab, which is a privileged API only
// available to the background/service-worker context, not a content script.
//
// DPR handling: captureVisibleTab returns a full-tab PNG at the device's
// native pixel density (DPR), but the crop rect we get from content.js is in
// CSS pixels. We don't have direct access to devicePixelRatio here, so we
// back it out by comparing the captured bitmap's actual width against the
// CSS viewport width the content script sends along. That ratio is the DPR,
// and we use it to scale the crop rect into device pixels before cropping.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'SPT_CAPTURE') return;
  if (!sender.tab) { sendResponse({ ok: false, error: 'No tab context' }); return; }

  chrome.tabs.captureVisibleTab(
    sender.tab.windowId,
    { format: 'png' },            // PNG keeps this lossless, no JPEG artifacts on text edges
    async dataUrl => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({ ok: false, error: chrome.runtime.lastError?.message || 'No data URL returned' });
        return;
      }
      try {
        const response = await fetch(dataUrl);
        const blob     = await response.blob();
        const bitmap = await createImageBitmap(blob, {
          premultiplyAlpha:     'none',
          colorSpaceConversion: 'none'
        });

        // bitmap.width is the captured screenshot's real width in device pixels.
        // viewportWidth is the CSS width content.js measured with window.innerWidth.
        // Dividing the two gives us the tab's actual DPR. If viewportWidth wasn't
        // sent for some reason, we fall back to treating DPR as 1 (no scaling).
        const viewportWidth = msg.viewportWidth || bitmap.width;
        const dpr = bitmap.width / viewportWidth;

        // Scale the CSS-pixel crop rect from content.js up to device pixels,
        // then clamp the crop so it can never run past the bitmap's edges.
        const sx = Math.max(0, Math.round(msg.rect.x * dpr));
        const sy = Math.max(0, Math.round(msg.rect.y * dpr));
        const rawW = Math.round(msg.rect.width  * dpr);
        const rawH = Math.round(msg.rect.height * dpr);
        const sw = Math.min(rawW, bitmap.width  - sx);
        const sh = Math.min(rawH, bitmap.height - sy);
        if (sw <= 0 || sh <= 0) {
          sendResponse({ ok: false, error: 'Zero-size crop rect' });
          return;
        }

        const canvas = new OffscreenCanvas(sw, sh);
        const ctx    = canvas.getContext('2d');

        // Turn off smoothing so the canvas doesn't anti-alias or soften pixels
        // while drawing, keeps text edges crisp instead of slightly blurred.
        ctx.imageSmoothingEnabled = false;

        ctx.drawImage(
          bitmap,
          sx, sy, sw, sh,    // source: the device-pixel crop region
          0,  0,  sw, sh     // dest: drawn at native size, no resampling
        );
        bitmap.close()

        // Encode the crop back out as PNG and base64 it for sending over
        // chrome.runtime messaging (which can't pass raw binary/blobs).
        const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
        const buf = await croppedBlob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const CHUNK = 8192;
        let binary = '';
        for (let i = 0; i < bytes.length; i += CHUNK)
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        sendResponse({ ok: true, dataUrl: `data:image/png;base64,${btoa(binary)}` });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    }
  );
  return true;   // keep the message channel open, sendResponse fires async
});
