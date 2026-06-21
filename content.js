// content.js v1
//
// Poetrystack content script, runs on every Substack post/note page and
// adds a "Restack with note" / "Copy quote" toolbar whenever the user
// selects text inside a poetry block (a <pre>, or anything tagged/classed
// as a poem). Picking "Restack with note" drives Substack's own UI to open
// the notes composer, builds a styled quote card out of the selection,
// screenshots it (via background.js), and attaches that screenshot as the
// note's image, along with a clean, UTM-tagged link back to the post.
//
// Everything here is best-effort DOM automation against Substack's live
// site, so most of the file is defensive: lots of selector fallbacks,
// polling instead of fixed waits, and a manual fallback (copy-to-clipboard)
// for whenever the automated path can't find what it's looking for.

(async function () {
  'use strict';

  // Bail out immediately on any non-Substack page. host_permissions in the
  // manifest is "<all_urls>" (needed so this also works on custom domains
  // like yourname.substack.com), so this guard is what keeps the script
  // from doing anything on sites that have nothing to do with Substack.
  const isSubstack = document.querySelector('meta[name="generator"][content*="Substack" i]') ||
                     document.querySelector('link[rel="alternate"][href*="substack.com"]') ||
                     window.location.hostname.includes('substack.com');

  if (!isSubstack) return;

  // Guard against the script running twice (e.g. if Chrome re-injects it
  // after a SPA navigation that doesn't actually reload the page).
  if (window.__sptLoaded) return;
  window.__sptLoaded = true;

  const DEBUG = false; // flip to true locally to get [SPT] console logs
  const log = DEBUG ? (...args) => console.log('[SPT]', ...args) : () => {};

  // Minimal HTML-escaper used anywhere we build raw innerHTML strings out of
  // user-controlled or page-derived text (titles, URLs), so we don't leave
  // an XSS hole when that text gets dropped straight into the DOM.
  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[c]));
  }

  // Shared state for whatever selection is currently "armed", set by
  // checkSelection() when a valid poetry selection is made, read by
  // handleRestack/handleCopy when the user actually clicks a button.
  let bar = null, toast = null, hideTimer = null;
  let pendingText = '', pendingUrl = '', pendingTitle = '', pendingAuthor = '';
  let pendingSegments = [];
  let clickedInsideBar = false;
  let restackInProgress = false;
  let pendingNode = null;

  // Injects the stylesheet for everything that only exists once the notes
  // composer is open: the theme/alignment picker panel and the from-scratch
  // mock card used as a fallback when we can't re-skin Substack's own
  // preview card. (The selection toolbar and toast live in styles.css
  // instead, since they're needed as soon as the page loads.)
  function injectCSS() {
    if (document.getElementById('spt-css')) return;
    const s = document.createElement('style');
    s.id = 'spt-css';
    s.textContent = `
      /* UI THEME PICKER PANEL */
      .spt-theme-container { display: flex; flex-direction: column; align-items: center; padding: 16px; background: #ffffff; width: 100%; box-sizing: border-box; border-top: 1px solid #f0f0f0; }
      .spt-controls-row { display: flex; width: 100%; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 16px; }
      .spt-theme-strip { display: flex; gap: 12px; overflow-x: auto; padding: 4px; flex-grow: 1; justify-content: flex-start; }
      .spt-theme-dot { width: 34px; height: 34px; border-radius: 8px; cursor: pointer; border: 2px solid transparent; transition: all 0.2s ease; background-size: cover; background-position: center; flex-shrink: 0; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.15); }
      .spt-theme-dot.active { border-color: #ff6719; transform: scale(1.1); box-shadow: 0 0 0 1px #fff, 0 0 0 3px #ff6719; }

      /* ALIGNMENT CONTROLS */
      .spt-align-group { display: flex; gap: 4px; background: rgba(0,0,0,0.06); padding: 4px; border-radius: 8px; flex-shrink: 0; }
      .spt-align-btn { width: 32px; height: 32px; border-radius: 6px; border: none; background: transparent; cursor: pointer; display: flex; align-items: center; justify-content: center; color: #555; transition: all 0.15s ease; }
      .spt-align-btn:hover { background: rgba(0,0,0,0.05); }
      .spt-align-btn.active { background: #ffffff; color: #ff6719; box-shadow: 0 1px 3px rgba(0,0,0,0.15); }

      /* Mock card, the from-scratch fallback card, used when we can't find a real attachment card to re-skin */
      #spt-mock-card {
        position: relative;
        width: 720px !important;
        height: 720px !important;
        aspect-ratio: 1 / 1 !important;
        max-width: 720px !important;
        min-width: 720px !important;
        margin: 24px auto;
        display: flex; flex-direction: column; justify-content: center; align-items: center;
        overflow: hidden; border-radius: 6px;
        padding: 52px 48px 72px 48px; box-sizing: border-box;
      }

      .spt-card-content {
        z-index: 2; color: #FFFFFF !important;
        font-family: "Spectral", Georgia, serif;
        font-size: 1.42rem; line-height: 1.55;
        white-space: pre-wrap !important;
        margin-bottom: 12px;
        width: 100% !important;
        display: block !important;
        box-sizing: border-box !important;
        word-break: normal !important;
        word-wrap: break-word !important;
      }

      #spt-mock-card.align-center { align-items: center; }
      #spt-mock-card.align-center .spt-card-content { text-align: center !important; }
      #spt-mock-card.align-left { align-items: flex-start; }
      #spt-mock-card.align-left .spt-card-content { text-align: left !important; }
      #spt-mock-card.align-left .spt-card-meta { text-align: left !important; align-self: flex-start; }
      #spt-mock-card.align-center .spt-card-meta { text-align: center !important; align-self: center; }

      .spt-card-content span {
        white-space: pre-wrap !important;
        display: inline !important;
        word-break: normal !important;
        word-wrap: normal !important;
      }

      .spt-card-bg { position: absolute; top:0; left:0; width:100%; height:100%; z-index: 1; background-size: cover; background-position: center; display:none; }
      .spt-card-overlay { position: absolute; top:0; left:0; width:100%; height:100%; z-index: 2; display:none; pointer-events: none; }
      .spt-card-meta {
        position: absolute; left: 48px; bottom: 28px; z-index: 3;
        color: rgba(255,255,255,0.82); font-family: system-ui, sans-serif;
        font-size: 14px; line-height: 1; letter-spacing: .01em;
      }

      .theme-1 { background: #36322F; }
      .theme-2 { background: #544F47; }
      .theme-3 { background: #284A42; }
      .theme-4 { background: #A74D1E; }
      .theme-5 { background: #252525; }

      .theme-6 .spt-card-bg, .theme-7 .spt-card-bg, .theme-8 .spt-card-bg, .theme-9 .spt-card-bg { display: block; }
      .theme-6 .spt-card-bg { filter: blur(35px) brightness(0.65); transform: scale(1.4); }
      .theme-7 .spt-card-overlay { display: block; background: rgba(0, 0, 0, 0.45); }
      .theme-8 .spt-card-overlay { display: block; background: rgba(57, 49, 45, 0.45); }
      .theme-9 .spt-card-overlay { display: block; background: rgba(57, 49, 45, 0.65); }

      /* Real-attachment reskin, styling applied when we re-skin Substack's own preview card instead of building a mock one */
      .spt-card-content-real {
        color: #FFFFFF !important;
        font-family: "Spectral", Georgia, serif !important;
        font-size: 1.3rem !important; line-height: 1.5 !important;
        white-space: pre-wrap !important;
        width: 100% !important; max-width: 100% !important;
        display: block !important;
        word-break: normal !important; word-wrap: break-word !important;
      }
      .spt-card-content-real span { white-space: pre-wrap !important; display: inline !important; }
      .spt-card-meta-real {
        color: rgba(255,255,255,0.82) !important;
        font-family: system-ui, sans-serif !important;
        font-size: 13px !important; line-height: 1.3 !important;
      }
      .spt-real-overlay { position: absolute; inset: 0; pointer-events: none; }

      #spt-finalize-custom-btn {
        background: #ff6719; color: white; border: none; border-radius: 999px;
        padding: 12px 36px; font-weight: bold; cursor: pointer; font-size: 15px; width: 100%; max-width: 250px;
        transition: transform 0.1s ease;
      }
      #spt-finalize-custom-btn:active { transform: scale(0.97); }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  // Disables (or re-enables) every native composer button while we're busy
  // building/capturing the quote card, so the user can't hit "Post" mid-way
  // through and publish a note with a half-finished attachment. Skips our
  // own picker UI buttons since those need to stay clickable.
  function toggleComposerButtons(disable) {
    const modal = document.querySelector('[class*="composerModal"]');
    if (!modal) return;
    
    const buttons = Array.from(modal.querySelectorAll('button')).filter(b => 
      b.id !== 'spt-finalize-custom-btn' && 
      !b.classList.contains('spt-theme-dot') && 
      !b.classList.contains('spt-align-btn')
    );
    
    buttons.forEach(b => {
      b.disabled = disable;
      b.style.opacity      = disable ? '0.4' : '';
      b.style.cursor       = disable ? 'not-allowed' : '';
      b.style.pointerEvents = disable ? 'none' : '';
      
      // The submit/publish button gets a tooltip explaining the disabled
      // state, instead of being matched purely by type. We check against
      // a list of "Post"-equivalent labels because Substack's button text
      // changes per the viewer's locale.
      if (b.type === 'submit' || b.querySelector('svg[class*="lucide-send"]') ||
    /^(Post|Publish|Send|Publicar|Publier|Publizieren|Veröffentlichen|Senden|Pubblica|Invia|Publicera|Skicka|Plaatsen|Publiceren|Opublikuj|Wyślij|Yayınla|Gönder|Paylaş|Udgiv|نشر|إرسال|投稿|送信)$/i.test(b.textContent.trim())) {
        b.title = disable ? 'Generating your quote card...' : '';
      }
    });
  }

  // Inline SVG icons for the toolbar buttons (restack arrows / copy icon).
  // Kept as small template strings rather than separate asset files since
  // there are only two of them and they need to inherit currentColor.
  function iconRestack() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
  }
  function iconCopy() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  }

  // Builds the floating toolbar element once at page load. It stays in the
  // DOM permanently and just gets repositioned/shown/hidden as selections
  // change, rather than being created and torn down on every selection.
  function buildBar() {
    const el = document.createElement('div');
    el.id = 'spt-bar';
    el.setAttribute('role', 'toolbar');
    el.innerHTML = `
      <button id="spt-btn-restack" class="spt-btn spt-primary">${iconRestack()} <span>Restack with note</span></button>
      <div class="spt-divider"></div>
      <button id="spt-btn-copy" class="spt-btn spt-secondary">${iconCopy()} <span>Copy quote</span></button>
    `;
    // Prevent the toolbar's mousedown from clearing the user's text
    // selection, without this, clicking a button would deselect the
    // text before the click handler even runs.
    el.addEventListener('mousedown', e => e.preventDefault());
    el.querySelector('#spt-btn-restack').addEventListener('click', handleRestack);
    el.querySelector('#spt-btn-copy').addEventListener('click', handleCopy);
    return el;
  }

  // Positions the toolbar just above the selected text and fades it in.
  // Clamped so it never renders off the top/left/right edge of the viewport.
  function showBar(rect) {
    clearTimeout(hideTimer);
    const W = 290;
    let top  = rect.top  + window.scrollY - 54;
    let left = rect.left + window.scrollX + rect.width / 2 - W / 2;
    top  = Math.max(window.scrollY + 8, top);
    left = Math.max(8, Math.min(left, window.innerWidth - W - 8));
    bar.style.top = top + 'px';
    bar.style.left = left + 'px';
    bar.classList.add('spt-visible');
  }

  // Hides the toolbar. `now=true` hides instantly (used right before an
  // action runs); otherwise there's a short delay so a brief, accidental
  // deselect (e.g. a stray click) doesn't make the toolbar flicker away.
  function hideBar(now = false) {
    clearTimeout(hideTimer);
    if (now) { bar.classList.remove('spt-visible'); return; }
    hideTimer = setTimeout(() => bar.classList.remove('spt-visible'), 200);
  }

  // Tracks whether a mousedown originated inside the toolbar, so the
  // upcoming selectionchange/pointerup handlers know not to treat a
  // toolbar click as "the user cleared their selection."
  function onMouseDown(e) { clickedInsideBar = bar.contains(e.target); }
  function onPointerUp()  { if (!clickedInsideBar) setTimeout(checkSelection, 60); }
  function onSelectionChange() {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.toString().trim()) hideBar();
  }

  // Runs after every mouseup/touchend: validates the current selection is
  // non-trivial, inside a recognized poetry block, and has a measurable
  // bounding rect, then caches everything the rest of the script needs
  // (text, source node, canonical URL, title, author, rich formatting) and
  // shows the toolbar pointing at it.
  function checkSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return hideBar();
    const text = sel.toString().trim();
    if (text.length < 2) return hideBar();
    let range; try { range = sel.getRangeAt(0); } catch { return; }
    if (!isInPoetryBlock(range.commonAncestorContainer)) return;
    let rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      // Some browsers return an empty rect for collapsed-looking ranges
      // inside certain inline elements, fall back to the parent element's
      // rect so the toolbar still has somewhere to anchor to.
      const el = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer;
      rect = el?.getBoundingClientRect() ?? rect;
    }
    if (!rect.width && !rect.height) return;
    
    pendingText     = text;
    pendingNode     = range.commonAncestorContainer;
    pendingUrl      = canonicalUrl(pendingNode);     
    pendingTitle    = postTitle();
    pendingAuthor   = postAuthor(pendingNode); 
    pendingSegments = extractRichSegments(range);
    
    showBar(rect);
  }

  // Walks up from the selection to confirm it's actually inside something
  // that looks like a poem: a <pre> block, or any ancestor classed/typed
  // as "poem"/"poetry", as long as that ancestor is also inside a
  // recognizable post/note container (so we don't match stray <pre> tags
  // used for code blocks elsewhere on the page).
  function isInPoetryBlock(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const postContainer = el.closest('article, [class*="post-"], [class*="postContent"], .available-content, .post-content, [data-testid="feed-item"], [data-testid="note-card"]');
  if (!postContainer) return false;
  let curr = el;
  while (curr) {
    if (curr.tagName === 'PRE') return true;
    const cls = (curr.getAttribute?.('class') ?? '').toLowerCase();
    if (cls.includes('poem') || cls.includes('poetry') || curr.getAttribute?.('data-type') === 'poem') return true;
    if (curr === postContainer) break;
    curr = curr.parentElement;
  }
  return false;
}

  // Walks the selected range text-node by text-node, capturing bold/italic
  // formatting for each chunk so the quote card can reproduce the poem's
  // original styling instead of flattening everything to plain text.
  function extractRichSegments(range) {
    const segments = [];
    const container = range.commonAncestorContainer;

    const walker = document.createTreeWalker(
      container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );

    let node;
    while (node = walker.nextNode()) {
      let text = node.textContent;
      let start = (node === range.startContainer) ? range.startOffset : 0;
      let end = (node === range.endContainer) ? range.endOffset : text.length;
      text = text.substring(start, end);

      if (!text) continue;

      const style = window.getComputedStyle(node.parentElement);
      const isBold = style.fontWeight === 'bold' || parseInt(style.fontWeight) >= 700;
      const isItalic = style.fontStyle === 'italic' || node.parentElement.closest('em, i, .italic, [style*="italic"]');

      segments.push({ text, bold: !!isBold, italic: !!isItalic });
    }

    return segments.length ? segments : [{ text: pendingText, bold: false, italic: false }];
  }
  function forceSquareFrame(el) {
    el.style.setProperty('width', '720px', 'important');
    el.style.setProperty('max-width', '720px', 'important');
    el.style.setProperty('min-width', '720px', 'important');
    el.style.setProperty('height', '720px', 'important');
    el.style.setProperty('max-height', '720px', 'important');
    el.style.setProperty('aspect-ratio', '1 / 1', 'important');
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Treats an element as "not really there" if it's detached from the DOM
  // or hidden via display/visibility. Used everywhere we're picking a
  // button or menu item out of several DOM matches, since Substack often
  // keeps hidden/duplicate copies of elements around (e.g. for animations
  // or different breakpoints).
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  // Finds the native "Restack" button (or its menu-trigger equivalent) for
  // whichever post the current selection belongs to. This has to cast a
  // wide net because Substack's restack button shows up differently across
  // contexts: a plain icon-button on the default theme, a dropdown-menu
  // trigger on custom domains (user.substack.com), and sometimes with no
  // stable class name at all, hence multiple selector strategies and a
  // same-document-position fallback search.
 function findFooterRestackButton() {
  if (!pendingNode) return null;

  const postContainer = pendingNode.nodeType === Node.ELEMENT_NODE
    ? pendingNode.closest('article, .post-p, .post-H_t1A1, .post-content, .available-content')
    : pendingNode.parentElement?.closest('article, .post-p, .post-H_t1A1, .post-content, .available-content');

  if (postContainer) {
    const btn = postContainer.querySelector('button[aria-label="Restack"], button[aria-label*="restack" i]')
      || postContainer.querySelector('svg polyline[points="17 1 21 5 17 9"]')?.closest('button');
    if (btn && isVisible(btn)) return btn;

    // On custom domains (user.substack.com) restack isn't a direct button —
    // it's hidden behind a "..." menu trigger instead.
    const ufiMenu = postContainer.querySelector('button[aria-haspopup="menu"][data-state].post-ufi-button');
    if (ufiMenu && isVisible(ufiMenu)) return ufiMenu;
  }

  // Couldn't find a container-scoped match, broaden the search to the
  // whole page and just take the first visible restack button that comes
  // after the selected node in document order (i.e. belongs to the same
  // post, just further down in its footer).
  const allRestackBtns = Array.from(document.querySelectorAll('button[aria-label*="restack" i]'));
  const found = allRestackBtns.find(b =>
    (pendingNode.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) && isVisible(b)
  );
  if (found) return found;

  // Last resort: same idea, but for the menu-trigger pattern.
  return Array.from(document.querySelectorAll('button[aria-haspopup="menu"][data-state].post-ufi-button'))
    .find(b => (pendingNode.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) && isVisible(b))
    || null;
}

  // Resolves the "real" shareable URL for whatever post/note the selection
  // came from. Substack's own canonical <link> tag isn't always reliable
  // (it can point at the feed root or get skipped on note pages), so we
  // prefer pulling a direct post link out of the matched container first,
  // and only fall back to the canonical tag or current location after that.
  function canonicalUrl(node) {
    let url = '';

    if (node) {
      let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const postContainer = el.closest('article, [class*="post-"], [class*="postContent"], .available-content, [data-testid="feed-item"], [data-testid="note-card"], [data-testid="post-card"]');
      if (postContainer) {
        const postLink = postContainer.querySelector('a[data-testid="post-title"], a.post-title, h1 a, a[href*="/p/"]:not([href*="comments"]), a[href*="/note/"]');
        if (postLink && postLink.href) {
          url = postLink.href;
        }
      }
    }

    if (!url) {
      url = document.querySelector('link[rel="canonical"]')?.href;
    }

    // Reject obviously-wrong results (bare domain root, inbox view) and
    // fall back to the page's own URL instead.
    if (!url || url.endsWith('substack.com/') || url.includes('/inbox')) {
      url = location.href;
    }

    return url.split('?')[0];
  }

  // Best-effort post/note title lookup, checking the most specific sources
  // first (og:title meta tag, then various heading selectors) and falling
  // back to a cleaned-up <title> tag as a last resort.
  function postTitle() {
    for (const s of ['meta[property="og:title"]','h1.post-title','h1[class*="title" i]','h1']) {
      const el = document.querySelector(s);
      let t = el?.getAttribute('content') || el?.textContent?.trim();
      if (t && t !== 'Substack') return t;
    }
    // Clean up generic titles for shortform
    if (document.title.includes('Substack Notes') || document.title === 'Substack') return 'Note';
    return document.title.split('-')[0].split('|')[0].trim();
  }

  // Resolves the author's display name for the current selection. Tries
  // a contextual lookup scoped to the specific post/note first (so a
  // multi-author feed page doesn't grab the wrong byline), then falls
  // back to page-wide selectors. Filters out obvious non-name junk like
  // "Comment", "Restack", or subscriber counts that share the same CSS
  // classes as the real author name on some layouts.
  function isJunkAuthorName(val) {
  const lower = (val || '').toLowerCase();
  return !val || lower === 'substack' || lower === 'substack creator' ||
         lower.includes('subscriber') || /^[0-9.,KkMm+ ]+$/.test(val);
}
  function postAuthor(node) {
  if (node) {
    const postContainer = node.nodeType === Node.ELEMENT_NODE
      ? node.closest('article, [data-testid="feed-post"], [class*="post-container"], .post, .custom-component')
      : node.parentElement?.closest('article, [data-testid="feed-post"], [class*="post-container"], .post, .custom-component');

    if (postContainer) {
      const authorEls = postContainer.querySelectorAll('a[href*="/@"], [class*="author-name"], [data-testid="post-author"]');
      for (const el of authorEls) {
        const val = el.textContent.trim();
        const lower = val.toLowerCase();
        
        if (val && !lower.includes('comment') && !lower.includes('restack') && !lower.includes('reply') && !lower.includes('substack') && val.length > 1) {
          return val;
        }
      }
    }
  }

  // No contextual match (or no container found), fall back to page-wide
  // author selectors, which works fine on single-post pages.
  const prioritySelectors = [
    'meta[name="author"]',
    '.byline-author-name',
    '[class*="author-name"]',
    '.profile-hover-card-target'
  ];

  for (const sel of prioritySelectors) {
    const el = document.querySelector(sel);
    if (el) {
      let val = el.tagName === 'META' ? (el.getAttribute('content') || "") : (el.textContent || "");
      val = val.trim().split(',')[0].trim();
      const lower = val.toLowerCase();
      if (val && !isJunkAuthorName(val)) {
        return val;
      }
    }
  }

  return '';
}

  // Fires a full, realistic pointer/mouse event sequence at an element
  // instead of calling .click() directly. Substack's UI is built on React
  // event delegation that, in some places, listens for the individual
  // pointer/mouse events rather than the synthesized "click", so this
  // makes our automated clicks behave the same as a real user's would.
  function simulateUserClick(element) {
    if (!element) return;
    if (typeof element.focus === 'function') element.focus();
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(type => {
      element.dispatchEvent(new MouseEvent(type, { bubbles:true, cancelable:true, view:window, buttons:1 }));
    });
  }

  // Entry point for the "Restack with note" button. Wrapped in a simple
  // in-flight guard (restackInProgress) so a double-click can't kick off
  // two overlapping automation runs against the composer at once.
  async function handleRestack() {
    if (restackInProgress) return;
    restackInProgress = true;
    try { await handleRestackInner(); }
    finally { restackInProgress = false; }
  }

  async function handleRestackInner() {
    if (!pendingText) return;
    const text = pendingText, title = pendingTitle, url = pendingUrl;
    const segments = pendingSegments.length ? pendingSegments : [{ text, bold: false, italic: false }];
    hideBar(true);
    log('Restack triggered:', text.slice(0, 60));

    await openComposerViaFooterAndInsertCard(text, title, url, segments);
  }

  // Drives Substack's own UI end-to-end: finds and clicks the post's
  // restack button, scans the resulting dropdown for "Restack with a
  // note", clicks that, waits for the notes composer to actually open,
  // then hands off to setupPoemCard to build the quote card inside it.
  // Falls back to a manual copy-to-clipboard flow at any point where the
  // automation can't find what it needs.
  async function openComposerViaFooterAndInsertCard(text, title, url, segments) {
    const restackBtn = findFooterRestackButton();
    if (!restackBtn) {
      log('Footer restack button not found');
      await fallbackCopyAndOpen(text, title, url);
      return;
    }

    const bRect = restackBtn.getBoundingClientRect();
    const alreadyVisible = bRect.top >= 0 && bRect.bottom <= window.innerHeight;
    if (!alreadyVisible) {
      restackBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(600);
    } else {
      await sleep(50);
    }

    log('Activating footer restack menu...');
    simulateUserClick(restackBtn);

    log('Scanning for "Restack with a note" menu item...');
    let autoClickedMenu = false;

    // Substack renders the dropdown menu as plain divs/spans with no
    // stable attributes to hook into, so we poll for up to ~2.8s (35
    // passes x 80ms) looking for any visible element whose exact text is
    // "restack with a note" rather than relying on DOM structure.
    for (let pass = 0; pass < 35; pass++) {
      await sleep(80);

      const menuItems = Array.from(document.querySelectorAll('div, button, [role="menuitem"], span'))
        .filter(el => {
          const text = el.textContent.trim().toLowerCase();
          return text === 'restack with a note';
        });

      const targetOption = menuItems.find(el => isVisible(el));

      if (targetOption) {
        log('Found "Restack with a note" menu item via text match.');
        // The text node we matched is often just a label inside a wrapper —
        // click the nearest actually-clickable ancestor instead of the
        // label itself, so the click actually registers with the menu.
        const actionableElement = targetOption.closest('button, [role="menuitem"], [tabindex="0"], a') || targetOption;
        simulateUserClick(actionableElement);
        autoClickedMenu = true;
        break;
      }
    }

    if (autoClickedMenu) {
      showToast('Opening the notes composer...');
    } else {
      // Couldn't find/click the menu item automatically, the dropdown is
      // still open, so let the user pick it themselves instead of failing
      // silently.
      log('Menu item not found via auto-scan.');
      showToast('Select "Restack with a note" to continue');
    }

    const modal = await waitForComposer(30000);
    if (!modal) return;

    toggleComposerButtons(true);

    try {
      await setupPoemCard(modal, segments, url, text);
    } catch (err) {
      log('setupPoemCard failed:', err);
      toggleComposerButtons(false);
      showToast('Card setup failed, you can post manually.');
    }
  }

  // Removes any attachments already sitting in the composer (most often a
  // leftover link-preview card from a prior attempt). Only used on the
  // mock-card fallback path, where we need a clean composer to drop our
  // from-scratch card into. Runs several passes since Substack sometimes
  // re-renders a fresh attachment card right after the previous one closes.
  async function purgeAllAttachments(modal) {
    for (let pass = 0; pass < 6; pass++) {
      const removeBtns = modal.querySelectorAll(
        '[data-testid="remove-attachment"], button[class*="removeAttachment"], button[class*="remove-attachment"]'
      );
      for (const btn of removeBtns) {
        if (isVisible(btn)) { btn.click(); await sleep(200); }
      }

      // Also catch attachment cards that don't expose a dedicated
      // "remove" button, fall back to whatever close/delete icon they do
      // have, skipping anything that looks like it belongs to an unrelated
      // dialog rather than the attachment itself.
      const cards = modal.querySelectorAll(
        '[class*="attachmentContainer"], [class*="quoteCard"], [class*="postPreview"], [class*="embedCard"], [class*="preview-"]'
      );
      for (const card of cards) {
        const closeBtn = card.querySelector('button[aria-label*="remove" i], button[aria-label*="close" i], button[aria-label*="delete" i], svg[class*="lucide-x"]');
        if (closeBtn && !closeBtn.getAttribute('aria-label')?.toLowerCase().includes('dialog')) {
          const btnToClick = closeBtn.closest('button') || closeBtn;
          if (isVisible(btnToClick)) { btnToClick.click(); await sleep(200); }
        }
      }
      await sleep(300);
    }
    log('Attachment purge complete');
  }

  // Polls until Substack's notes composer modal exists, is visible, and has
  // a working rich-text editor inside it (ProseMirror), or gives up after
  // timeoutMs. Also bails out early if the extension context itself goes
  // away (chrome.runtime.id becomes undefined), which happens if the
  // extension gets reloaded/updated mid-flow.
  function waitForComposer(timeoutMs) {
    return new Promise(resolve => {
      const check = () => {
        const modal = document.querySelector('[class*="composerModal"]');
        if (modal && isVisible(modal) && modal.querySelector('[contenteditable="true"], .ProseMirror')) {
          return modal;
        }
        return null;
      };

      const initialCheck = check();
      if (initialCheck) return resolve(initialCheck);

      const deadline = Date.now() + timeoutMs;
      const interval = setInterval(() => {
      if (!chrome.runtime?.id) { clearInterval(interval); resolve(null); return; } 
        const modal = check();
        if (modal) {
          clearInterval(interval);
          resolve(modal);
        } else if (Date.now() > deadline) {
          clearInterval(interval);
          resolve(null);
        }
      }, 150);
    });
  }

  // Rebuilds an element's contents from rich-text segments, wrapping each
  // one in its own <span> so per-segment bold/italic styling survives
  // (a single innerText assignment would flatten all formatting to plain
  // text). Falls back to plain pendingText if no segments were captured.
  function updateDOMWithRichText(el, segments) {
    el.innerHTML = '';
    if (!segments || segments.length === 0) {
      el.innerText = pendingText;
      return;
    }
    segments.forEach(seg => {
      const span = document.createElement('span');
      span.innerText = seg.text;
      if (seg.bold) span.style.setProperty('font-weight', 'bold', 'important');
      if (seg.italic) span.style.setProperty('font-style', 'italic', 'important');
      span.style.setProperty('white-space', 'pre-wrap', 'important');
      el.appendChild(span);
    });
  }

  // When we re-skin Substack's own React-rendered preview card, writing to
  // innerHTML directly can get silently overwritten the next time React
  // re-renders, since the DOM is out of sync with React's own state. This
  // walks the React Fiber tree attached to the element to find the hook
  // that owns its text and dispatches an update through React's own state
  // setter instead, so the change actually sticks. It's best-effort, if no
  // Fiber node or matching hook is found, this just no-ops harmlessly.
  async function updateViaFiber(el, text) {
    let fEl = el, fKey = null;
    for (let i = 0; i < 10 && fEl; i++) {
      fKey = Object.keys(fEl).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (fKey) break;
      fEl = fEl.parentElement;
    }
    if (!fKey) return;
    const currentText = el.textContent?.trim() ?? '';
    const visited = new Set();
    function walk(fiber, d) {
      if (!fiber || d > 50 || visited.has(fiber)) return;
      visited.add(fiber);
      // Walk the fiber's hook list looking for a useState-style hook whose
      // current value looks like the text we're trying to replace (an
      // exact match, empty string, or a matching prefix), then dispatch
      // the new text straight through that hook's own setter.
      let h = fiber.memoizedState;
      while (h) {
        const v = h.memoizedState;
        if (typeof v === 'string' && h.queue?.dispatch) {
          if (v === currentText || v === '' || (currentText.length > 4 && v.startsWith(currentText.slice(0, 8)))) {
            h.queue.dispatch(text);
          }
        }
        h = h.next;
      }
      walk(fiber.child, d + 1);
      walk(fiber.sibling, d + 1);
    }
    walk(fEl[fKey], 0);
    await sleep(80);
  }

  // Programmatically attaches the quote-card screenshot to the composer's
  // hidden file input, the same way a real file picker selection would.
  // Substack listens for change/input events on the input rather than
  // watching the DataTransfer directly, so both are dispatched.
  async function attachImageToComposer(modal, dataUrl) {
  const input = modal.querySelector('input[type="file"]');
  if (!input) return;
  const blob = await fetch(dataUrl).then(r => r.blob());
  const file = new File([blob], 'quoted-poem.png', { type:'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files').set;
  setter.call(input, dt.files);
  input.dispatchEvent(new Event('change', { bubbles:true }));
  input.dispatchEvent(new Event('input', { bubbles:true }));

  // Wait for visual confirmation the image actually uploaded/rendered,
  // rather than assuming a fixed delay is always long enough.
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (modal.querySelector('img[src^="blob:"], [data-testid="remove-attachment"]')) break;
    await sleep(150);
  }
  await sleep(300); // brief settle buffer after the image appears
}

  // Locates Substack's own auto-generated link-preview card (the one that
  // appears after pasting a post URL) and identifies which of its child
  // elements hold the title text and author text, by matching their
  // content against the post's known title/author. This is the "real
  // attachment" path, re-skinning Substack's existing card is preferred
  // over building one from scratch, since it matches the native look.
  function findDefaultAttachmentSlots(modal, meta) {
    const containerSelectors = [
      '[class*="attachmentContainer"]',
      '[class*="postPreview"]',
      '[class*="embedCard"]',
      '[class*="linkPreview"]',
      '[class*="preview-"]'
    ];

    let container = null;
    for (const sel of containerSelectors) {
      const found = [...modal.querySelectorAll(sel)].find(isVisible);
      if (found) { container = found; break; }
    }
    if (!container) {
      const link = [...modal.querySelectorAll('a[href*="/p/"]')].find(isVisible);
      container = link?.closest('div') || link || null;
    }
    if (!container) {
      log('Attachment scan: no container found.');
      return null;
    }

    const norm = (s) => (s || '').trim().toLowerCase().replace(/[\u2026.]+$/, '');
    const titleNeedle = norm(meta.title).slice(0, 28);
    const authorNeedle = norm(meta.author);

    const candidates = [...container.querySelectorAll('*')]
      .filter(el => el.children.length === 0 && el.textContent.trim().length > 0);

    let titleEl = null, authorEl = null;
    for (const el of candidates) {
      const t = norm(el.textContent);
      if (!titleEl && titleNeedle && (t.startsWith(titleNeedle) || titleNeedle.startsWith(t.slice(0, 28)))) {
        titleEl = el;
        continue;
      }
      if (!authorEl && authorNeedle && t.includes(authorNeedle)) {
        authorEl = el;
      }
    }

    const imgEl = container.querySelector('img');

    if (!titleEl) return null;
    return { container, titleEl, authorEl, imgEl, isReal: true };
  }

  // Strips line-clamp, overflow, and max-height limits off every ancestor
  // between el and root. Substack's preview card is normally designed to
  // truncate long titles after a line or two, but a full poem needs to
  // render in full for the screenshot, so we walk up and force every
  // clipping ancestor open before capture.
  function unclampAncestors(el, root) {
  let node = el.parentElement;
  while (node && node !== root) {
    const cs = getComputedStyle(node);
    const clamp = cs.getPropertyValue('-webkit-line-clamp');
    if (clamp && clamp !== 'none') {
      node.style.setProperty('-webkit-line-clamp', 'unset', 'important');
      node.style.setProperty('display', 'block', 'important');
    }
    node.style.setProperty('overflow', 'visible', 'important');
    node.style.setProperty('max-height', 'none', 'important');
    node.style.setProperty('text-overflow', 'clip', 'important');
    node.style.setProperty('background', 'transparent', 'important');
    node = node.parentElement;
  }
}

  // Builds a quote card entirely from scratch and drops it into the
  // composer right after the editor. This is the fallback path, used only
  // when findDefaultAttachmentSlots() can't locate Substack's own preview
  // card to re-skin, for example if the link preview hasn't finished
  // generating yet, or its DOM structure doesn't match any selector.
  function buildMockCardSlots(modal, meta) {
    const mockCard = document.createElement('div');
    mockCard.id = 'spt-mock-card';
    mockCard.className = 'theme-1 align-center';
    mockCard.innerHTML = `
      <div class="spt-card-bg"></div>
      <div class="spt-card-overlay"></div>
      <div class="spt-card-content"></div>
      <div class="spt-card-meta">${escapeHtml(meta.author)}</div>
    `;
    const safeImg = meta.coverImg.replace(/["()]/g, encodeURIComponent);
    if (safeImg) {
      mockCard.querySelector('.spt-card-bg').style.backgroundImage = `url("${safeImg}")`;
    }
    const editor = modal.querySelector('[contenteditable="true"]')?.parentElement;
    if (editor) editor.parentNode.insertBefore(mockCard, editor.nextSibling);
    else modal.insertBefore(mockCard, modal.firstChild);

    return {
      container: mockCard,
      titleEl: mockCard.querySelector('.spt-card-content'),
      authorEl: mockCard.querySelector('.spt-card-meta'),
      imgEl: null,
      isReal: false
    };
  }

  // Theme colors used by themes 1-5 (flat backgrounds) and the overlay
  // tints used by themes 7-9 (laid over the post's cover image). Theme 6
  // skips this lookup entirely since it uses a blur/brightness filter on
  // the image instead of a flat overlay color.
  const SOLID_THEMES   = { 1:'#36322F', 2:'#544F47', 3:'#284A42', 4:'#A74D1E', 5:'#252525' };
  const OVERLAY_THEMES = { 7:'rgba(0,0,0,0.45)', 8:'rgba(57,49,45,0.45)', 9:'rgba(57,49,45,0.65)' };

  // Applies the selected theme + text alignment to whichever card type is
  // active. The mock card (isReal: false) just swaps its className, since
  // its CSS classes (theme-1 through theme-9) already define everything.
  // The real, re-skinned attachment card needs each property set directly
  // via inline styles instead, since we don't control its base CSS.
  function applyThemeToSlots(slots, themeId, align) {
    const { container, titleEl, authorEl, imgEl, isReal } = slots;

    if (!isReal) {
      container.className = `theme-${themeId} ${align}`;
      return;
    }

    if (getComputedStyle(container).position === 'static') {
      container.style.setProperty('position', 'relative', 'important');
    }
    container.querySelector(':scope > .spt-real-overlay')?.remove();

    if (imgEl) {
      imgEl.style.removeProperty('filter');
      imgEl.style.removeProperty('transform');
      imgEl.style.setProperty('opacity', '1', 'important');
    }

    if (themeId <= 5) {
      // Solid-color themes: hide the cover image entirely.
      container.style.setProperty('background', SOLID_THEMES[themeId], 'important');
      if (imgEl) imgEl.style.setProperty('opacity', '0', 'important');
    } else {
      // Image-based themes: show the cover image, either blurred (theme 6)
      // or with a tinted overlay layered on top (themes 7-9).
      container.style.removeProperty('background');
      if (imgEl) {
        if (themeId === 6) {
          imgEl.style.setProperty('filter', 'blur(35px) brightness(0.65)', 'important');
          imgEl.style.setProperty('transform', 'scale(1.4)', 'important');
        } else {
          const overlay = document.createElement('div');
          overlay.className = 'spt-real-overlay';
          overlay.style.setProperty('background', OVERLAY_THEMES[themeId], 'important');
          overlay.style.setProperty('z-index', '1', 'important');
          imgEl.insertAdjacentElement('afterend', overlay);
        }
      }
    }

    const pad = parseFloat(getComputedStyle(container).paddingTop) || 0;
    if (pad < 20) container.style.setProperty('padding', '24px', 'important');

    const textAlign = align === 'align-left' ? 'left' : 'center';
    titleEl.classList.add('spt-card-content-real');
    titleEl.style.setProperty('position', 'relative', 'important');
    titleEl.style.setProperty('z-index', '2', 'important');
    titleEl.style.setProperty('text-align', textAlign, 'important');

    if (authorEl) {
      authorEl.classList.add('spt-card-meta-real');
      authorEl.style.setProperty('position', 'relative', 'important');
      authorEl.style.setProperty('z-index', '2', 'important');
      authorEl.style.setProperty('text-align', textAlign, 'important');
    }
  }


  // Orchestrates the whole quote-card build: resolves the post's real
  // (non-SPA) URL, finds or builds the card slots, writes the poem text
  // into them, applies the default theme, then injects the theme/alignment
  // picker UI into the composer footer so the user can adjust the look
  // before finalizing.
  async function setupPoemCard(modal, segments, url, text) {
    const meta = getPostMetadata();

    let slots = null;
    let trueUrl = url; 

    // Substack's SPA-style profile URLs (substack.com/@user/p-123) don't
    // resolve to a stable canonical link, rewrite them to the publication's
    // own subdomain format (user.substack.com/p/123) up front, since that's
    // the URL we actually want to share.
    if (trueUrl.includes('substack.com/@')) {
      const spaMatch = trueUrl.match(/substack\.com\/@([^\/]+)\/p(?:-|_)?(\d+)/i);
      if (spaMatch) {
        const username = spaMatch[1];
        const postId = spaMatch[2];
        trueUrl = `https://${username}.substack.com/p/${postId}`;
        log('Bypassed SPA router. Clean redirect path generated:', trueUrl);
      }
    }

    // Poll briefly for Substack's link-preview card to render. Each pass
    // also re-checks for a native post link inside it, since the preview
    // sometimes resolves to a cleaner canonical URL than the one we
    // started with.
    for (let i = 0; i < 6; i++) {
      if (modal) {
        const nativeLink = modal.querySelector('[class*="attachmentContainer"] a[href*="/p/"], [class*="postPreview"] a[href*="/p/"], [class*="embedCard"] a[href*="/p/"]');
        if (nativeLink && nativeLink.href && !nativeLink.href.includes('substack.com/@')) {
          trueUrl = nativeLink.href.split('?')[0];
        }
      }

      slots = findDefaultAttachmentSlots(modal, meta);
      if (slots) break;
      await sleep(300);
    }

    if (slots) {
      log('Using real attachment card (re-skinned in place).');
      updateDOMWithRichText(slots.titleEl, segments);
      await updateViaFiber(slots.titleEl, text); // nudge React's own state first
      updateDOMWithRichText(slots.titleEl, segments); // then re-apply our DOM, in case Fiber reset it
    } else {
      log('No usable attachment slot, falling back to mock card.');
      await purgeAllAttachments(modal);
      slots = buildMockCardSlots(modal, meta);
      updateDOMWithRichText(slots.titleEl, segments);
    }

    let currentThemeId = 1;
    let currentAlign = 'align-left';
    applyThemeToSlots(slots, currentThemeId, currentAlign);

    // Theme + alignment picker UI, injected into the composer footer below
    // the card so the user can preview different looks before posting.
    const pickerContainer = document.createElement('div');
    pickerContainer.className = 'spt-theme-container';

    const controlsRow = document.createElement('div');
    controlsRow.className = 'spt-controls-row';

    const strip = document.createElement('div');
    strip.className = 'spt-theme-strip';

    // Theme IDs 1-5 are flat colors; 6-9 use the post's cover image
    // (blurred or tinted) instead, hence the colors below 6-9 are only
    // used as a placeholder if no cover image is available yet.
    const themes = [
      { id: 1, color: '#36322F' },
      { id: 2, color: '#544F47' },
      { id: 3, color: '#284A42' },
      { id: 4, color: '#A74D1E' },
      { id: 5, color: '#252525' },
      { id: 6, color: '#444' },
      { id: 7, color: '#111' },
      { id: 8, color: '#39312D' },
      { id: 9, color: '#26201E' }
    ];

    const coverForDots = slots.isReal ? (slots.imgEl?.currentSrc || slots.imgEl?.src || '') : meta.coverImg;

    themes.forEach((t, i) => {
      const dot = document.createElement('div');
      dot.className = 'spt-theme-dot' + (i === 0 ? ' active' : '');
      // Dots for the image-based themes (index 5+) show the actual cover
      // image as a thumbnail; flat-color themes just show their swatch.
      if (i >= 5 && coverForDots) {
        const safeCover = coverForDots.replace(/['()]/g, encodeURIComponent);
        dot.style.backgroundImage = `url('${safeCover}')`;
      } else {
        dot.style.backgroundColor = t.color;
      }
      dot.setAttribute('aria-label', `Theme ${t.id}`);
      dot.onclick = () => {
          strip.querySelectorAll('.spt-theme-dot').forEach(d => d.classList.remove('active'));
          dot.classList.add('active');
          currentThemeId = t.id;
          applyThemeToSlots(slots, currentThemeId, currentAlign);
        };
        dot.setAttribute('tabindex', '0');
        dot.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dot.click(); }
        });
        strip.appendChild(dot);
    });

    const alignGroup = document.createElement('div');
    alignGroup.className = 'spt-align-group';

    const btnLeft = document.createElement('button');
    btnLeft.className = 'spt-align-btn active';
    btnLeft.title = 'Left aligned';
    btnLeft.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="15" y2="12"></line><line x1="3" y1="18" x2="19" y2="18"></line></svg>`;

    const btnCenter = document.createElement('button');
    btnCenter.className = 'spt-align-btn';
    btnCenter.title = 'Center aligned';
    btnCenter.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="6" y1="12" x2="18" y2="12"></line><line x1="4" y1="18" x2="20" y2="18"></line></svg>`;
    btnLeft.onclick = (e) => {
      e.preventDefault();
      btnCenter.classList.remove('active');
      btnLeft.classList.add('active');
      currentAlign = 'align-left';
      applyThemeToSlots(slots, currentThemeId, currentAlign);
    };
    btnCenter.onclick = (e) => {
      e.preventDefault();
      btnLeft.classList.remove('active');
      btnCenter.classList.add('active');
      currentAlign = 'align-center';
      applyThemeToSlots(slots, currentThemeId, currentAlign);
    };

    alignGroup.appendChild(btnLeft);
    alignGroup.appendChild(btnCenter);
    controlsRow.appendChild(strip);
    controlsRow.appendChild(alignGroup);

    // "Continue" button: locks the picker UI, runs the actual
    // screenshot-and-attach flow (runFinalize), then either tears down the
    // picker on success or re-enables it so the user can retry.
    const finalBtn = document.createElement('button');
    finalBtn.id = 'spt-finalize-custom-btn';
    finalBtn.textContent = 'Continue';
    finalBtn.onclick = async () => {
      finalBtn.disabled = true;
      finalBtn.textContent = 'Processing Card...';
      pickerContainer.style.display = 'none';

      const ok = await runFinalize(modal, slots, meta, trueUrl, text);

      if (ok) {
        pickerContainer.remove();
        if (!slots.isReal) slots.container.remove();
        showToast('Linked your quote and saved your card!');
        toggleComposerButtons(false);
      } else {
        pickerContainer.style.display = 'flex';
        finalBtn.disabled = false;
        finalBtn.textContent = 'Retry Capture';
        toggleComposerButtons(false);
      }
    };

    pickerContainer.appendChild(controlsRow);
    pickerContainer.appendChild(finalBtn);

    const footerElement = modal.querySelector('[class*="footer"], [class*="actions"]') ||
                           modal.querySelector('button[type="submit"]')?.parentElement ||
                           modal;
    footerElement.appendChild(pickerContainer);
  }

  // The screenshot-and-attach finale: temporarily resizes the card to a
  // fixed 720x720 capture frame, auto-shrinks the text to fit, hides
  // everything else on the page so the screenshot only shows the card,
  // sends it to background.js to capture/crop, restores every style we
  // touched, then pastes the post URL (to trigger Substack's own link
  // preview) and attaches the screenshot as the note's image.
  async function runFinalize(modal, slots, meta, url, text) {
    const { container, titleEl, isReal } = slots;

    // Hide the composer's footer/toolbar for the duration of the capture —
    // otherwise those controls would visibly sit on top of the card while
    // we resize and reposition it for the screenshot.
    const composerFooters = modal.querySelectorAll('[class*="footer"], [class*="actions"], [class*="toolbar"]');
    const savedFooters = [];
    composerFooters.forEach(f => {
      savedFooters.push({ el: f, display: f.style.display });
      f.style.setProperty('display', 'none', 'important');
    });

    // Snapshot every inline style we're about to override so we can put
    // everything back exactly as it was once the capture finishes.
    const savedOuterStyle = container.style.cssText;
    const savedDescendantStyles = isReal
      ? [...container.querySelectorAll('*')].map(el => [el, el.style.cssText])
      : null;

    if (isReal) {
      // For the re-skinned real card, force it into the same fixed
      // 720x720 frame the mock card already uses by default, so both
      // paths produce a consistently-sized screenshot.
      forceSquareFrame(container);
      container.style.setProperty('overflow', 'visible', 'important');
      unclampAncestors(titleEl, container);
      container.querySelectorAll('*').forEach(el => {
        el.style.setProperty('box-sizing', 'border-box', 'important');
        el.style.setProperty('max-width', '100%', 'important');
        el.style.setProperty('aspect-ratio', 'auto', 'important');
      });
    }

    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));

    const originalParent = container.parentElement;
    const originalSibling = container.nextSibling;

    // Move the card to the end of <body> so it isn't clipped by any
    // overflow:hidden ancestor in the composer modal while we capture it.
    document.body.appendChild(container);

    // Auto-fit the poem's text to the fixed card size, shrinking the font
    // until it fits and boosting weight/spacing at small sizes so it stays
    // readable instead of just getting smaller and thinner.

    // Force grayscale antialiasing instead of subpixel/LCD rendering —
    // subpixel rendering leaves red/blue color fringing on text edges,
    // which then turns into visible blur once background.js upscales the
    // screenshot for high-DPI displays.
    container.style.setProperty('-webkit-font-smoothing', 'antialiased', 'important');
    container.style.setProperty('-moz-osx-font-smoothing', 'grayscale', 'important');
    titleEl.style.setProperty('text-rendering', 'geometricPrecision', 'important');

        let currentFontSize = parseFloat(window.getComputedStyle(titleEl).fontSize) || 24;
        let originalWeight = parseInt(window.getComputedStyle(titleEl).fontWeight) || 400;

        // Theme 6's blurred/scaled background image inflates the
        // container's scrollHeight, which would make the overflow check
        // below trigger on the background instead of the actual text. We
        // temporarily neutralize the image's transform and measure against
        // an invisible marker dropped at the end of the text flow instead,
        // so the overflow check only ever reflects the real text height.
        const savedTransform = slots.imgEl
          ? (slots.imgEl.style.getPropertyValue('transform') || 'none')
          : 'none';
        if (slots.imgEl) slots.imgEl.style.setProperty('transform', 'none', 'important');
        const marker = document.createElement('div');
        marker.style.cssText = "height:1px; margin:0; padding:0; clear:both; visibility:hidden;";
        container.appendChild(marker);

        const pb = parseFloat(window.getComputedStyle(container).paddingBottom) || 0;
        
        // Recreates what scrollHeight would tell us, but using only the
        // marker's position in the normal text flow, immune to the
        // absolute-positioned background/overlay elements that would
        // otherwise throw off a real scrollHeight reading.
        const isOverflowing = () => {
            const containerRect = container.getBoundingClientRect();
            const markerRect = marker.getBoundingClientRect();
            return ((markerRect.bottom - containerRect.top) + pb) > 720;
        };

        while (isOverflowing() && currentFontSize > 10) {
          currentFontSize -= 0.5;
          titleEl.style.setProperty('font-size', `${currentFontSize}px`, 'important');

          // Below 16px, thin text starts looking weak at this resolution —
          // bump the weight and add a touch of letter/line spacing to keep
          // small text legible instead of just shrinking it further.
          if (currentFontSize < 16) {
             titleEl.style.setProperty('font-weight', `${Math.min(originalWeight + 200, 700)}`, 'important');
             titleEl.style.setProperty('letter-spacing', '0.3px', 'important');
             titleEl.style.setProperty('line-height', '1.45', 'important');
          } else {
             titleEl.style.setProperty('line-height', '1.35', 'important');
          }
        }
        
        marker.remove();
        
        // Now that the final font size is locked in, restore the
        // background image's original scale/transform.
        if (slots.imgEl) slots.imgEl.style.setProperty('transform', savedTransform, 'important');

    // A full-viewport "shield" in the card's own background color, dropped
    // in behind the card before capture. Without it, any sliver of the
    // composer/page visible around the card's edges (from rounding, the
    // shrink-to-fit scale, etc) would show through in the screenshot.
    const themeBg = getComputedStyle(container).backgroundColor;
    const shield = document.createElement('div');
    shield.id = 'spt-capture-shield';
    shield.style.cssText = `
      position: fixed !important; top: 0 !important; left: 0 !important;
      width: 100vw !important; height: 100vh !important;
      background: ${themeBg} !important;
      z-index: 999990 !important; pointer-events: none !important;
    `;
    document.body.appendChild(shield);

    container.style.setProperty('position', 'fixed', 'important');
container.style.setProperty('top', '0px', 'important');
container.style.setProperty('left', '0px', 'important');
container.style.setProperty('margin', '0', 'important');
container.style.setProperty('z-index', '999999', 'important');
container.style.setProperty('transform-origin', 'top left', 'important');

if (!isReal) forceSquareFrame(container);

// Scale the card down (never up) so it always fits inside the current
// viewport, without this, a small or split browser window would crop
// part of the 720x720 card right out of the screenshot.
const VIEWPORT_MARGIN = 16;
const fitScale = Math.min(
  1,
  (window.innerWidth  - VIEWPORT_MARGIN) / 720,
  (window.innerHeight - VIEWPORT_MARGIN) / 720
);
container.style.setProperty('transform', `scale(${fitScale})`, 'important');

let rect = container.getBoundingClientRect(); // already reflects the scale above
container.style.setProperty('top',  `${Math.max(0, (window.innerHeight - rect.height) / 2)}px`, 'important');
container.style.setProperty('left', `${Math.max(0, (window.innerWidth  - rect.width ) / 2)}px`, 'important');

// Wait for web fonts to finish loading and give layout a moment to settle
// before measuring the final capture rect, otherwise a late font swap
// could shift text after we've already locked in the crop coordinates.
await document.fonts.ready;
await sleep(250);
rect = container.getBoundingClientRect();

// Clamp the capture rect to the viewport bounds, in case rounding or the
// centering math above pushed any edge slightly off-screen.
const clampedLeft   = Math.max(0, Math.round(rect.left));
const clampedTop    = Math.max(0, Math.round(rect.top));
const clampedRight  = Math.min(window.innerWidth,  Math.round(rect.right));
const clampedBottom = Math.min(window.innerHeight, Math.round(rect.bottom));
const captureRect = {
  x: clampedLeft,
  y: clampedTop,
  width:  Math.max(0, clampedRight  - clampedLeft),
  height: Math.max(0, clampedBottom - clampedTop)
};

    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'SPT_CAPTURE',
        rect: captureRect,
        viewportWidth: window.innerWidth
      });
    } catch (err) {
      res = { ok: false, error: String(err) };
    }

    // Capture is done (success or fail), put everything back exactly how
    // we found it: remove the shield, restore every saved inline style,
    // move the card back to its original spot in the DOM, and bring the
    // composer's footer back.
    shield.remove();
    if (savedDescendantStyles) savedDescendantStyles.forEach(([el, css]) => { el.style.cssText = css; });
    container.style.cssText = savedOuterStyle;
    if (originalSibling) originalParent.insertBefore(container, originalSibling);
    else originalParent.appendChild(container);
    savedFooters.forEach(sf => sf.el.style.display = sf.display);

    // Hide the now-restored text card immediately so it doesn't flash
    // visible for a moment before the screenshot image gets attached in
    // its place below.
    container.style.setProperty('display', 'none', 'important');

    if (!res?.ok) {
      log('Capture failed:', res?.error);
      container.style.removeProperty('display');
      return false;
    }

    if (isReal) {
      modal.querySelector('[data-testid="remove-attachment"]')?.click();
      await sleep(300);
    }

    // Paste the post's URL into the composer first so Substack generates
    // its own link-preview card on the left side of the note, this has to
    // happen before the screenshot is attached, or the two attachments
    // would land in the wrong order.
    const editorBody = modal.querySelector('[contenteditable="true"]');
    if (editorBody) {
      editorBody.focus();
      
      // Always tag the link as "web" medium, regardless of where the
      // selection itself happened (post page vs. note feed).
      const currentUrl = window.location.href;
      const utmMedium = 'web';

      // Try to pull a clean {username, slug} pair out of whichever of the
      // three URL formats we have on hand (the resolved post URL, the
      // original canonical URL, or the current page URL), checked in
      // that order since each one matches a different Substack URL style.
      let username = '';
      let slug = '';
      
      const targetUrls = [url, pendingUrl, currentUrl];
      
      for (const t of targetUrls) {
        if (!t) continue;
        
        // Standard custom-domain post URL: user.substack.com/p/slug
        let match = t.match(/https?:\/\/([^.]+)\.substack\.com\/p\/([^?#\/]+)/);
        if (match && match[1] !== 'open' && match[1] !== 'www') {
          username = match[1];
          slug = match[2];
          break;
        }
        
        // SPA profile-style URL: substack.com/@user/p-12345
        match = t.match(/https?:\/\/(?:www\.)?substack\.com\/@([^\/]+)\/p(?:-|_|\/)([^?#\/]+)/);
        if (match) {
          username = match[1];
          slug = match[2];
          break;
        }

        // Already-shortened share URL: open.substack.com/pub/user/p/slug
        match = t.match(/https?:\/\/open\.substack\.com\/pub\/([^\/]+)\/p\/([^?#\/]+)/);
        if (match) {
          username = match[1];
          slug = match[2];
          break;
        }
      }

      // If the slug we extracted is just a numeric post ID rather than a
      // readable slug, generate a human-readable one from the post title
      // instead, matches the slug format Substack's own share links use.
      if (slug && /^\d+$/.test(slug) && meta && meta.title) {
        const sevenWords = meta.title.trim().split(/\s+/).slice(0, 7).join(' ');
        const slugifiedTitle = sevenWords
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s-]/gu, '')
          .replace(/[\s_-]+/g, '-')
          .replace(/^-+|-+$/g, '');

        if (slugifiedTitle) {
          slug = slugifiedTitle;
        }
      }

      // Build the final shareable link: the clean open.substack.com short
      // form when we managed to extract a username/slug, otherwise fall
      // back to just tagging UTM params onto whatever URL we already had.
      let finalShareUrl = url;
      if (username && slug) {
        finalShareUrl = `https://open.substack.com/pub/${username}/p/${slug}?utm_campaign=post-expanded-share&utm_medium=${utmMedium}`;
      } else {
        let shareUrlObj;
        try {
          shareUrlObj = new URL(url);
        } catch {
          finalShareUrl = url;
          shareUrlObj = null;
        }
        if (shareUrlObj) {
          shareUrlObj.searchParams.set('utm_campaign', 'post-expanded-share');
          shareUrlObj.searchParams.set('utm_medium', utmMedium);
          finalShareUrl = shareUrlObj.toString().replace(/\+/g, '%20');
        }
      }

      // Insert the URL as a simulated clipboard paste rather than typing
      // it character-by-character, Substack's editor specifically listens
      // for paste events to trigger its link-preview generation, so a
      // regular text insertion wouldn't create the preview card at all.
      const dt = new DataTransfer();
      dt.setData('text/plain', finalShareUrl);
      const escapedUrl = escapeHtml(finalShareUrl);
      dt.setData('text/html', `<a href="${escapedUrl}">${escapedUrl}</a> `);
      
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      });
      editorBody.dispatchEvent(pasteEvent);
      
      setTimeout(() => {
        editorBody.dispatchEvent(new Event('input', { bubbles: true }));
      }, 100);

      // Once Substack finishes generating the link-preview card, delete
      // the now-redundant pasted URL text from the note body, the user
      // only wants the visual card, not the raw link sitting above it.
      await new Promise((resolve) => {
        let urlDeleted = false;

        const deleteUrlText = () => {
          if (urlDeleted) return;
          urlDeleted = true;

          editorBody.focus();

          const urlPara = [...editorBody.querySelectorAll('p')].find(p =>
            p.querySelector('a[href*="substack.com"]') ||
            p.textContent.trim().includes('substack.com')
          );

          if (urlPara) {
            const range = document.createRange();
            range.selectNode(urlPara);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('delete', false, null);
            editorBody.dispatchEvent(new Event('input', { bubbles: true }));
          }
          
          resolve(true); 
        };

        // Watches for the preview card actually appearing in the editor
        // (any added node that isn't a plain <p>/<br>) so we delete the
        // URL text right after the card shows up, rather than guessing at
        // a fixed delay. Falls back to a flat 3s timeout regardless, in
        // case the preview card never renders for some reason.
        const cardWatcher = new MutationObserver((mutations, obs) => {
          for (const { addedNodes } of mutations) {
            for (const node of addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== 'P' && node.tagName !== 'BR') {
                obs.disconnect();
                setTimeout(deleteUrlText, 400);
                return;
              }
            }
          }
        });
        cardWatcher.observe(editorBody, { childList: true });

        setTimeout(() => { cardWatcher.disconnect(); deleteUrlText(); }, 3000);
      });
    }

    // Finally, attach the quote-card screenshot. Doing this after the link
    // preview (rather than at the same time) keeps the two attachments in
    // a predictable left-to-right order in the finished note.
    await attachImageToComposer(modal, res.dataUrl);

    return true;
  }

  // Manual fallback used whenever the automated restack flow can't find
  // what it needs (no native restack button, composer never opens, etc):
  // just copies the quote text to the clipboard instead, so the user can
  // paste it in manually.
  async function fallbackCopyAndOpen(text) {
    const quote = buildQuoteText(text);
    await copyToClipboard(quote);
    showToast('Copied the quote!');
  }

  // Entry point for the "Copy quote" button, just puts the raw selected
  // text on the clipboard. (buildQuoteText is a placeholder hook for future
  // formatting; right now it just returns the text unchanged.)
  async function handleCopy() {
    if (!pendingText) return;
    hideBar(true);
    const ok = await copyToClipboard(buildQuoteText(pendingText, pendingTitle, pendingUrl));
    showToast(ok ? 'Quote copied!' : 'Copy failed.');
  }

  function buildQuoteText(text) {
  return text;
}

  // Copies text to the clipboard via the modern Clipboard API, falling
  // back to the old execCommand('copy') trick (via a temporary, invisible
  // textarea) for any context where navigator.clipboard isn't available
  // or permitted.
  async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    let ta;
    try {
      ta = document.createElement('textarea'); ta.value = text;
      Object.assign(ta.style, { position:'fixed', opacity:'0', top:'0', left:'0' });
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch { ta?.remove(); return false; }
      }

  // Shows a short-lived toast at the bottom of the screen for status
  // messages. Only one toast exists at a time, calling this again removes
  // whatever's currently showing first.
  function showToast(msg) {
    toast?.remove();
    toast = document.createElement('div');
    toast.id = 'spt-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.add('spt-toast-on');
      setTimeout(() => { toast?.classList.remove('spt-toast-on'); setTimeout(() => { toast?.remove(); toast = null; }, 400); }, 3000);
    });
  }

  // Gathers the author name, cover image, and title for the mock-card
  // fallback path. Reuses pendingAuthor/pendingTitle where possible (set
  // earlier by checkSelection), and only falls back to fresh page-wide
  // lookups if those came back empty or clearly wrong (e.g. picked up a
  // subscriber count instead of a name).
  function getPostMetadata() {
    let author = pendingAuthor || "";

    if (isJunkAuthorName(author)) {
      const prioritySelectors = [
        '[data-testid="user-name"]',
        '.p-name',
        'meta[name="author"]',
        '.byline-author-name',
        '[class*="author-name"]',
        '.profile-hover-card-target'
      ];
      for (const sel of prioritySelectors) {
        const el = document.querySelector(sel);
        if (el) {
          let val = el.tagName === 'META' ? (el.getAttribute('content') || "") : (el.textContent || "");
          val = val.trim().split(/[,•|]/)[0].trim();
          if (val && !isJunkAuthorName(val)) {
            author = val;
            break;

          }
        }
      }
    }

    // Still nothing usable, fall back to a generic label rather than
    // leaving the card's author line blank.
    if (isJunkAuthorName(author)) {
      author = "Author";
    }

    const ogImage = document.querySelector('meta[property="og:image"]')?.content ||
                document.querySelector('meta[name="twitter:image"]')?.content ||
                "";

    let title = pendingTitle;
    if (!title) {
        title = document.querySelector('h1.post-title')?.textContent.trim() ||
                document.querySelector('meta[property="og:title"]')?.content ||
                "Post Link";
    }

    return { author, coverImg: ogImage, title };
  }

  // Bootstraps the extension on this page: inject the toolbar's CSS, build
  // and mount the (initially hidden) selection toolbar, then wire up the
  // listeners that drive everything else.
  injectCSS();
  bar = buildBar();
  if (document.body) document.body.appendChild(bar);
  else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(bar));

  log(`Poetrystack ${chrome.runtime.getManifest().version} loaded`);

  document.addEventListener('mouseup', onPointerUp, true);
  document.addEventListener('touchend', onPointerUp, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('selectionchange', onSelectionChange);

  // Substack is a single-page app, so most "navigation" never triggers a
  // real page load, it just calls history.pushState/replaceState under
  // the hood. We patch both so we can reset all pending-selection state
  // and re-inject CSS whenever the user moves to a different post/note,
  // since otherwise stale state could carry over from the previous page.
  let lastPath = location.pathname;
  function onNavigate() {
  injectCSS();
  hideBar(true);
  pendingText = ''; pendingUrl = ''; pendingTitle = '';
  pendingAuthor = ''; pendingSegments = []; pendingNode = null;
}
  for (const fn of ['pushState','replaceState']) {
    const orig = history[fn];
    history[fn] = function(...a) { const r = orig.apply(this, a); onNavigate(); return r; };
  }
  window.addEventListener('popstate', onNavigate);
})();