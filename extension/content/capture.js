export function capturePage(readEditable = false) {
  const excludedSelector = readEditable
    ? 'input, textarea, select, option, script, style, noscript'
    : 'input, textarea, select, option, [contenteditable], script, style, noscript';
  const mailboxListMarkers = /\b1[–-]50 of\b|Conversationsunread|AllNoneReadUnread|LabelsInbox/;

  function isVisible(element) {
    if (!element) return false;
    for (let node = element; node; node = node.parentElement) {
      if (node.hidden || node.getAttribute?.('hidden') != null || node.getAttribute?.('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return element.checkVisibility ? element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : (element.getClientRects?.().length ?? 1) > 0;
  }

  function accessibleName(element) {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = clean(element?.innerText);
    if (visible) return visible;
    const label = clean(element?.getAttribute?.('aria-label'));
    if (label) return label;
    const ids = clean(element?.getAttribute?.('aria-labelledby')).split(' ').filter(Boolean);
    const labelledBy = clean(ids.map((id) => element?.ownerDocument?.getElementById(id)?.textContent || document.getElementById?.(id)?.textContent).join(' '));
    if (labelledBy) return labelledBy;
    const associated = clean([...(element?.labels || [])].map((label) => label.textContent).join(' '));
    if (associated) return associated;
    const placeholder = clean(element?.getAttribute?.('placeholder'));
    if (placeholder) return placeholder;
    const title = clean(element?.getAttribute?.('title'));
    if (title) return title;
    for (const child of element?.querySelectorAll?.('img[alt],svg title,[aria-label]') || []) {
      const name = clean(child.matches?.('img[alt]') ? child.getAttribute('alt') : child.matches?.('svg title') ? child.textContent : child.getAttribute('aria-label'));
      if (name) return name;
    }
    return '';
  }

  const dangerous = /(?:password|passcode|mfa|2fa|otp|verification|verify|one[ -]?time|security.?code|cc-|card|cvv|cvc|csc|expir|ssn|social.?security|routing|account.?(?:number|no)|iban|tax.?id|\bein\b|passport|license)/i;
  const writableSelector = 'input,textarea,select,[role="textbox"],[role="searchbox"],[role="combobox"],[contenteditable="true"]';
  const repeatedItemSelector = '[role=listitem], li, article, [role=article], tr, [data-testid*="card" i], [data-hook*="card" i], [class*="card" i]';
  function isRepeatedItem(element) {
    const parent = element.parentElement;
    if (!parent) return false;
    if (element.matches(repeatedItemSelector)) {
      const role = element.getAttribute('role');
      const siblings = Array.from(parent.children).filter((sibling) => sibling.matches(repeatedItemSelector)
        && (role === 'listitem' || role === 'article'
          ? sibling.getAttribute('role') === role
          : sibling.tagName === element.tagName && sibling.getAttribute('role') === role));
      if (siblings.length >= 3) return true;
    }
    const prefix = (value) => String(value || '').split(/[|\d]/, 1)[0].trim();
    const className = String(element.className || '').trim();
    const hook = prefix(element.getAttribute('data-hook'));
    const testId = prefix(element.getAttribute('data-testid'));
    if (!className && !hook && !testId) return false;
    const siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === element.tagName
      && isVisible(sibling) && String(sibling.innerText || '').trim().length >= 20
      && ((className && sibling.className === className)
        || (hook && prefix(sibling.getAttribute('data-hook')) === hook)
        || (testId && prefix(sibling.getAttribute('data-testid')) === testId)));
    return siblings.length >= 3;
  }
  function writableField(element) {
    const tag = element.tagName.toLowerCase();
    const type = tag === 'input' ? String(element.getAttribute('type') || 'text').toLowerCase() : '';
    if (tag === 'input' && !['text', 'search', 'email', 'url', 'tel', 'number'].includes(type)) return null;
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const ids = clean(element.getAttribute?.('aria-labelledby')).split(' ').filter(Boolean);
    const name = clean(element.getAttribute?.('aria-label')
      || ids.map((id) => document.getElementById?.(id)?.textContent).join(' ')
      || [...(element.labels || [])].map((label) => label.textContent).join(' ')
      || element.getAttribute?.('placeholder') || element.getAttribute?.('title')).slice(0, 200);
    const descriptor = [name, element.getAttribute?.('name'), element.getAttribute?.('id'), element.getAttribute?.('autocomplete')].join(' ');
    if (dangerous.test(descriptor)) return null;
    const ref = element.getAttribute?.('data-work-edge-ref') || `work-edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    element.setAttribute?.('data-work-edge-ref', ref);
    return { ref, tag, type, role: element.getAttribute?.('role') || (element.getAttribute?.('contenteditable') === 'true' ? 'textbox' : ''), name, hasValue: Boolean(tag === 'input' || tag === 'textarea' || tag === 'select' ? element.value : element.textContent?.trim()) };
  }

  function composedText(node) {
    const parts = [];
    const append = (target, value) => {
      const text = String(value || '').trim();
      if (text) target.push(text);
    };
    const visit = (current, target = parts, insideItem = false) => {
      if (!current) return;
      if (current.nodeType === Node.TEXT_NODE) {
        append(target, current.nodeValue);
        return;
      }
      if (current.nodeType !== Node.ELEMENT_NODE && current.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      const element = current.nodeType === Node.ELEMENT_NODE ? current : null;
      if (element && (!isVisible(element) || element.matches(excludedSelector))) return;
      if (element && !insideItem && isRepeatedItem(element)) {
        const itemParts = [];
        visit(current, itemParts, true);
        const itemText = itemParts.join('\n').trim();
        if (itemText) {
          const text = itemText.length < 300
            ? itemText.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ')
            : itemText;
          parts.push(`---\n${text}`);
        }
        return;
      }
      for (const child of current.childNodes) visit(child, target, insideItem);
      // cloneNode(...).innerText omits shadow trees. Fluent/Outlook renders
      // virtualized mail rows in open shadow roots, so compose their text too.
      if (element?.shadowRoot) visit(element.shadowRoot, target, insideItem);
    };
    visit(node);
    return parts.join('\n').trim();
  }

  function sanitizedText(element) {
    // Traverse the composed tree so open shadow roots are included while form
    // controls, hidden, and aria-hidden nodes stay excluded. Editable regions
    // are included only when the extension passes the browser-local setting.
    return composedText(element);
  }

  function hasMessageSurface(main) {
    return main.querySelectorAll('[role="document"], [role="article"], article, [data-message-id], [data-app-section="ReadingPane"], [aria-label*="Reading Pane" i], [aria-label*="Message body" i], [data-testid*="reading" i], [data-automationid*="ReadingPane" i], .adn, .a3s, .ii.gt').length > 0;
  }

  function gmailThreadText() {
    // Gmail leaves its mailbox list mounted while a conversation is open. Its
    // message-body nodes are much narrower and safer than cloning main/article.
    const bodies = Array.from(document.querySelectorAll('.a3s, .ii.gt'))
      .filter(isVisible)
      .map(sanitizedText)
      .filter((text) => text.length >= 12 && !mailboxListMarkers.test(text));
    const uniqueBodies = [...new Set(bodies)];
    if (!uniqueBodies.length) return '';

    const usableHeading = (element) => {
      const text = sanitizedText(element);
      return text.length >= 3 && text.length <= 500 && !mailboxListMarkers.test(text) ? text : '';
    };
    const gmailSubjects = Array.from(document.querySelectorAll('h2.hP, h1.hP'))
      .filter(isVisible)
      .map(usableHeading)
      .filter(Boolean);
    const headings = gmailSubjects.length ? gmailSubjects : Array.from(document.querySelectorAll('h2, h1, [role="heading"]'))
      .filter(isVisible)
      .map(usableHeading)
      .filter(Boolean);
    // Gmail's hP heading is the conversation subject. The first usable heading
    // remains a resilient fallback for layout variants.
    const subject = headings[0] || '';
    return [subject, ...uniqueBodies].filter(Boolean).join('\n');
  }

  function preferredMessageSurface() {
    // These combine durable accessibility semantics with Gmail's message-body
    // markers. A main region alone is only used when it contains a message-like
    // child; mail applications commonly keep the mailbox list mounted beside it.
    const candidates = [
      // Outlook's Fluent layouts vary by tenant and rollout. Prefer its
      // narrow reading-pane/body containers so an open message beats the
      // still-mounted folder list or its "Nothing is selected" empty pane.
      ['[data-app-section="ReadingPane"]', 140],
      ['[aria-label*="Reading Pane" i], [aria-label*="Message body" i]', 140],
      ['[data-automationid*="ReadingPane" i]', 135],
      ['[data-testid*="reading" i]', 130],
      ['[role="document"]', 95],
      ['[role="article"], article', 90],
      ['[data-message-id]', 100],
      ['.adn', 110],
      ['.a3s, .ii.gt', 120],
      ['[role="main"], main', 20]
    ];
    let selected = null;
    for (const [selector, score] of candidates) {
      for (const element of document.querySelectorAll(selector)) {
        if (!isVisible(element) || isRepeatedItem(element) || ((selector === '[role="main"], main') && !hasMessageSurface(element))) continue;
        const text = sanitizedText(element);
        // A short label, empty pane, or hidden template is not enough evidence
        // to discard the complete page context.
        if (text.length < 12) continue;
        // A nested message can sometimes inherit an outer Gmail shell. Never
        // let that beat a clean message surface merely because it is larger.
        const candidate = { element, score: score - (mailboxListMarkers.test(text) ? 200 : 0), textLength: text.length };
        if (!selected || candidate.score > selected.score || (candidate.score === selected.score && candidate.textLength > selected.textLength)) selected = candidate;
      }
    }
    return selected?.element || null;
  }

  const gmailText = gmailThreadText();
  const readable = gmailText ? null : (preferredMessageSurface() || document.body);
  const visibleText = gmailText || sanitizedText(readable) || '';
  const rowSelector = '[role="grid"] [role="row"], [role="treegrid"] [role="row"], table [role="row"], table tr, [role="listbox"] [role="option"], [role="list"] [role="listitem"], tr.zA';
  const rowRoots = [document];
  for (let index = 0; index < rowRoots.length; index += 1) {
    for (const element of rowRoots[index].querySelectorAll?.('*') || []) if (element.shadowRoot) rowRoots.push(element.shadowRoot);
  }
  const rowElements = Array.from(new Set(rowRoots.flatMap((root) => Array.from(root.querySelectorAll?.(rowSelector) || []))))
    .filter((element) => isVisible(element) && !element.closest?.('input,textarea,select,[contenteditable], [data-sensitive="true"]'))
    .filter((element) => String(element.innerText || '').trim());
  const boldSubject = (element) => Array.from(element.querySelectorAll('[class*="subject" i], [class*="sender" i], [data-testid*="subject" i], [data-testid*="sender" i]'))
    .some((child) => isVisible(child) && Number.parseInt(getComputedStyle(child).fontWeight, 10) >= 600);
  const boldRows = rowElements.filter(boldSubject).length;
  const rows = rowElements.slice(0, 40).map((element) => {
    const ref = element.getAttribute('data-work-edge-ref') || `work-edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    element.setAttribute?.('data-work-edge-ref', ref);
    const aria = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('aria-description') || ''}`;
    const checkedUnread = Array.from(element.querySelectorAll('[aria-checked]')).some((child) =>
      child.getAttribute('aria-checked') === 'true' && /\bunread\b/i.test(`${child.getAttribute('aria-label') || ''} ${child.getAttribute('title') || ''}`));
    const unread = /\bunread\b/i.test(aria) || element.classList?.contains('zE')
      || element.getAttribute('data-is-unread') === 'true'
      || checkedUnread
      || (boldRows > 0 && boldRows < rowElements.length && boldSubject(element));
    return { ref, text: String(element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300), unread };
  });
  // These are signal names only. Values, labels tied to controls, and the
  // controls themselves never cross this boundary.
  const sensitiveSignals = [
    /\b(?:password|passcode)\b/i.test(visibleText) && 'password',
    /\b(?:mfa|two[- ]factor|verification code|one[- ]time code|authenticator)\b/i.test(visibleText) && 'mfa',
    /\b(?:sign in|log in|login|account security)\b/i.test(visibleText) && 'account'
  ].filter(Boolean);
  // WindowProxy identity and parent.frames are available across origins. This
  // gives each injection its position in Chrome's frame tree without a new
  // webNavigation permission or relying on an iframe's (possibly empty) src.
  const framePath = [];
  for (let current = window; current !== current.parent;) {
    const parent = current.parent;
    let index = -1;
    for (let i = 0; i < parent.frames.length; i += 1) {
      if (parent.frames[i] === current) { index = i; break; }
    }
    if (index < 0) break;
    framePath.unshift(index);
    current = parent;
  }
  return {
  title: document.title,
  url: location.href,
  framePath,
  text: visibleText.slice(0, 200000),
  text_total_chars: visibleText.length,
  // Only frame addresses are used by the worker to restore document order and
  // name frames that Chrome could not inject into. They are never forwarded.
  frameElements: Array.from(document.querySelectorAll('iframe, frame')).map((frame) => ({
    index: Array.from(window.frames).findIndex((child) => child === frame.contentWindow),
    url: frame.src || frame.getAttribute('src') || 'about:blank'
  })),
  // Field names and occupancy are safe to expose; contents never are.
  elementSummary: Array.from(document.querySelectorAll(`h1,h2,h3,h4,h5,h6,[role="heading"],a,button,[role="button"],[role="link"],${writableSelector}`))
    .filter(isVisible)
    .slice(0, 250)
    .map((element) => element.matches(writableSelector) ? writableField(element)
      : ({ tag: element.tagName.toLowerCase(), text: accessibleName(element).slice(0, 200) }))
    .filter(Boolean),
  rows,
  sensitiveSignals
  };
}
