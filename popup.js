// popup.js
// Fills in the version number shown in the extension's popup UI, pulling it
// straight from manifest.json so it never drifts out of sync with a release.

document.getElementById('spt-version').textContent =
  'v' + chrome.runtime.getManifest().version;
