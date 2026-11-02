// This function is injected into the active tab. It deliberately never reads a
// control's value: remote control may write, but cannot use form contents as
// an input channel.
export function executeBrowserCommand(command) {
  const textOf = (element) => [element?.innerText, element?.textContent, element?.getAttribute?.('aria-label'), element?.getAttribute?.('placeholder'), element?.getAttribute?.('name'), element?.getAttribute?.('id')].filter(Boolean).join(' ').toLowerCase();
  const dangerous = /(?:password|passcode|mfa|2fa|otp|verification|verify|one[ -]?time|security.?code)/i;
  const finalAction = /\b(?:send|submit|apply(?![\s_-]+filters?\b)|post|repost|publish|share|like|unlike|follow|unfollow|delete|remove|buy|purchase|checkout|place[\s_-]+order|pay|e-?sign|sign|confirm|upload)\b/i;
  const simpleLiveSelector = /^(?:\*|[a-z][a-z0-9-]*|\[(?:role|aria-label|data-automationid)(?:\*?=(?:"[^"]{1,120}"|'[^']{1,120}'|[a-z0-9_ -]{1,120}))?\])$/i;
  const pressKeys = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace']);
  const cssEscape = (value) => (globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const isActionControl = (element) => Boolean(element?.matches?.('button,a,input[type="button"],input[type="submit"],input[type="reset"],[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]'));
  const actionControlFor = (element) => isActionControl(element) ? element : element?.closest?.('button,a,input[type="button"],input[type="submit"],input[type="reset"],[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]');
  const isVisible = (element) => {
    if (!element) return false;
    for (let node = element; node; node = node.parentElement) {
      if (node.hidden || node.getAttribute?.('hidden') != null || node.getAttribute?.('aria-hidden') === 'true') return false;
      const style = globalThis.getComputedStyle?.(node);
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
    }
    return element.checkVisibility ? element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : (element.getClientRects?.().length ?? 1) > 0;
  };
  const isFormControl = (element) => Boolean(element?.matches?.('input,textarea,select'));
  const isOtherEditable = (element) => Boolean(element?.matches?.('option,[contenteditable="true"]'));
  const accessibleName = (element) => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = element?.matches?.('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="searchbox"],[role="combobox"]') ? '' : clean(element?.innerText);
    if (visible) return visible;
    const label = clean(element?.getAttribute?.('aria-label'));
    if (label) return label;
    const ids = clean(element?.getAttribute?.('aria-labelledby')).split(' ').filter(Boolean);
    const labelledBy = clean(ids.map((id) => element?.ownerDocument?.getElementById(id)?.textContent || document.getElementById?.(id)?.textContent).join(' '));
    if (labelledBy) return labelledBy;
    const associated = clean([...(element?.labels || [])].map((item) => item.textContent).join(' '));
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
  };
  const normalizeWords = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const refFor = (element) => {
    const existing = element.getAttribute?.('data-work-edge-ref');
    if (existing && document.querySelector?.(`[data-work-edge-ref="${cssEscape(existing)}"]`) === element) return existing;
    if (typeof element.setAttribute !== 'function') return null;
    const ref = `work-edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    element.setAttribute?.('data-work-edge-ref', ref);
    return ref;
  };
  const ownText = (element) => {
    const nodes = [...(element?.childNodes || [])].filter((node) => node.nodeType === 3).map((node) => node.textContent).join(' ');
    return normalizeWords(nodes || (element?.children?.length ? '' : element?.textContent || element?.innerText));
  };
  const depth = (element) => { let count = 0; for (let node = element; node; node = node.parentElement) count += 1; return count; };
  const commonDepth = (left, right) => {
    const ancestors = new Set();
    for (let node = left; node; node = node.parentElement) ancestors.add(node);
    for (let node = right; node; node = node.parentElement) if (ancestors.has(node)) return depth(node);
    return 0;
  };
  const contextFor = (element) => {
    const card = element.closest?.('article,[role="article"],[role="listitem"],li,tr,[data-job-id],[class*="card" i]');
    const region = element.closest?.('section,article,[role="dialog"],[role="region"],main');
    const heading = card?.querySelector?.('h1,h2,h3,h4,h5,h6,[role="heading"]')
      || region?.querySelector?.('h1,h2') || region?.querySelector?.('h3,h4,h5,h6,[role="heading"]');
    return String(heading?.innerText || heading?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  };
  const liveText = (element) => accessibleName(element).slice(0, 240);
  const findLive = (selector) => {
    if (typeof selector !== 'string' || selector.length > 256 || !simpleLiveSelector.test(selector)) return { ok: false, error: 'Live element discovery accepts only a bounded simple selector.' };
    let elements;
    try { elements = document.querySelectorAll(selector); } catch { return { ok: false, error: 'Live element discovery rejected the selector.' }; }
    const eligible = [...elements].filter((element) => {
      if (!isVisible(element) || isOtherEditable(element)) return false;
      if (isFormControl(element) && (element.matches?.('input[type="password"],input[type="hidden"],[hidden]') || dangerous.test(textOf(element)))) return false;
      return true;
    });
    const overlaySelector = '[role=menu],[role=menubar],[role=listbox],[role=dialog],[aria-modal=true],[role=tooltip],[popover]';
    const priority = (element) => {
      const overlay = element.closest?.(overlaySelector);
      if (overlay && isVisible(overlay)) return 0;
      const rect = element.getBoundingClientRect?.();
      if (rect && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight) return 1;
      return 2;
    };
    eligible.sort((left, right) => priority(left) - priority(right));
    const matches = [];
    for (const element of eligible.slice(0, 60)) {
      const unsafe = Boolean(actionControlFor(element) && finalAction.test(textOf(actionControlFor(element))));
      const match = { tag: String(element.tagName || '').toLowerCase().slice(0, 40), text: isFormControl(element) ? '' : liveText(element), ...(unsafe ? { unsafe: true } : {}) };
      {
        const existingRef = element.getAttribute?.('data-work-edge-ref');
        const reusableRef = existingRef && document.querySelector(`[data-work-edge-ref="${cssEscape(existingRef)}"]`) === element;
        const ref = reusableRef ? existingRef : `work-edge-${Date.now().toString(36)}-${matches.length}`;
        if (!reusableRef) element.setAttribute?.('data-work-edge-ref', ref);
        match.ref = ref;
      }
      matches.push(match);
    }
    return { ok: true, result: { selector, matches } };
  };
  const keyCode = (key) => ({ Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End', Backspace: 'Backspace' })[key];
  const dispatch = (target, type, init, Constructor) => {
    const EventConstructor = Constructor || globalThis.Event;
    let event;
    try { event = new EventConstructor(type, init); } catch { event = new Event(type, init); }
    return target.dispatchEvent?.(event);
  };
  const activate = (element) => {
    try { element.scrollIntoView?.({ block: 'center', inline: 'center' }); } catch { /* A detached or shimmed element can reject scrolling. */ }
    let rect = null;
    try { rect = element.getBoundingClientRect?.(); } catch { /* Coordinate fallback below is safe for detached elements. */ }
    const finite = (value) => Number.isFinite(value) ? value : 0;
    const left = finite(rect?.left);
    const top = finite(rect?.top);
    const width = Math.max(0, finite(rect?.width));
    const height = Math.max(0, finite(rect?.height));
    const clientX = Math.max(0, Math.round(left + (width / 2)));
    const clientY = Math.max(0, Math.round(top + (height / 2)));
    const pageX = clientX + Math.max(0, finite(globalThis.scrollX));
    const pageY = clientY + Math.max(0, finite(globalThis.scrollY));
    const screenX = clientX + Math.max(0, finite(globalThis.screenX));
    const screenY = clientY + Math.max(0, finite(globalThis.screenY));
    element.focus?.();
    const coordinates = { clientX, clientY, pageX, pageY, screenX, screenY };
    const pointerInit = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...coordinates };
    const mouseInit = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, detail: 1, ...coordinates };
    dispatch(element, 'pointerdown', pointerInit, globalThis.PointerEvent || globalThis.MouseEvent);
    dispatch(element, 'mousedown', mouseInit, globalThis.MouseEvent);
    dispatch(element, 'pointerup', { ...pointerInit, buttons: 0 }, globalThis.PointerEvent || globalThis.MouseEvent);
    dispatch(element, 'mouseup', { ...mouseInit, buttons: 0 }, globalThis.MouseEvent);
    dispatch(element, 'click', { ...mouseInit, buttons: 0 }, globalThis.MouseEvent);
    // Older test/page shims may not implement dispatchEvent. Native click is
    // only a compatibility fallback; browsers receive the full SPA sequence.
    if (!element.dispatchEvent && typeof element.click === 'function') element.click();
  };
  const press = (element, key) => {
    const init = { key, code: keyCode(key), bubbles: true, cancelable: true, composed: true };
    for (const type of ['keydown', 'keypress', 'keyup']) dispatch(element, type, init, globalThis.KeyboardEvent);
  };
  const enterAction = (element) => {
    if (!element?.matches?.('input:not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]),[role="searchbox"]')) return null;
    const form = element.form || element.closest?.('form');
    if (form) {
      const buttons = [...(form.querySelectorAll?.('button[type="submit"],button:not([type]),input[type="submit"]') || [])].filter(isVisible);
      const button = buttons.length === 1 ? buttons[0] : null;
      const search = element.matches?.('input[type="search"],[role="searchbox"]') || form.matches?.('[role="search"]')
        || Boolean(element.closest?.('[role="search"]')) || /search|find|filter/i.test(`${accessibleName(element)} ${accessibleName(button)}`);
      return { kind: 'form', form, button, search: Boolean(search), name: accessibleName(button) || 'submit' };
    }
    const container = element.parentElement;
    const button = [...(container?.querySelectorAll?.('button[type="submit"],[role="button"],button') || [])]
      .find((candidate) => isVisible(candidate) && /search|go|submit|find/i.test(accessibleName(candidate)));
    return button ? { kind: 'button', button, search: /search|find/i.test(accessibleName(button)), name: accessibleName(button) } : null;
  };
  const finalEnterRefusal = (element, action) => {
    if (!action || action.search || command.askBeforeFinalActions === false) return null;
    const binding = command.approvalBinding;
    if (!binding) return 'Approval required for this final action; nothing was clicked.';
    if (binding.fingerprint !== pageFingerprint() || binding.name !== action.name
      || binding.tag !== String(element.tagName || '').toLowerCase()
      || (binding.ref && (!command.target?.ref || command.target.ref !== binding.ref || locate({ ref: binding.ref }) !== element))) return 'The page changed; nothing was clicked.';
    return null;
  };
  const locate = (target) => {
    if (!target) return null;
    if (target.ref) return document.querySelector(`[data-work-edge-ref="${cssEscape(target.ref)}"]`) || document.querySelector(`#${cssEscape(target.ref)}`);
    if (target.selector) return document.querySelector(target.selector);
    const wanted = normalizeWords(target.targetText);
    const controls = [...document.querySelectorAll('button,a,label,input,textarea,select,[role="button"],[role="link"],[role="menuitem"],[role="option"],[role="textbox"],[role="searchbox"],[role="combobox"],[contenteditable="true"]')]
      .filter(isVisible).filter((element) => accessibleName(element));
    let matches = controls.filter((element) => normalizeWords(accessibleName(element)) === wanted);
    if (!matches.length) matches = controls.filter((element) => normalizeWords(accessibleName(element)).startsWith(wanted));
    if (!matches.length) matches = controls.filter((element) => normalizeWords(accessibleName(element)).includes(wanted));
    if (target.near && matches.length) {
      const nearby = [...document.querySelectorAll('*')].filter((element) => ownText(element).includes(normalizeWords(target.near)));
      if (nearby.length) {
        const scored = matches.map((element) => ({ element, score: Math.max(...nearby.map((node) => commonDepth(element, node))) }));
        const best = Math.max(...scored.map((entry) => entry.score));
        matches = scored.filter((entry) => entry.score === best).map((entry) => entry.element);
      }
    }
    if (matches.length > 1) {
      const error = new Error(`${matches.length} controls are called "${target.targetText}". Say which one with near (for example the job title next to it).`);
      error.code = 'ambiguous_target';
      error.candidates = matches.slice(0, 8).map((element) => ({ ref: refFor(element), name: accessibleName(element), context: contextFor(element) }));
      throw error;
    }
    if (matches.length) { refFor(matches[0]); return matches[0]; }
    // Gmail renders inbox subjects inside table/ARIA rows rather than a
    // clickable link or button. Include row containers so targetText can open
    // a read-only thread without relying on Gmail-specific private selectors.
    if (command.type === 'click' && !finalAction.test(wanted)) return [...document.querySelectorAll('[role="row"],[role="listitem"],tr,[data-thread-id],[data-automationid*="row" i]')].find((element) => textOf(element).includes(wanted)) || null;
    return null;
  };
  const pageFingerprint = () => {
    const page = new URL(location.href);
    const source = `${page.origin}${page.pathname}`;
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  };
  const refuse = (element, action) => {
    const descriptor = textOf(element);
    if (element?.matches?.('input[type="password"],input[type="hidden"], [hidden]') || dangerous.test(descriptor)) return 'Refused: password, hidden, MFA, or verification fields cannot be controlled remotely.';
    const control = actionControlFor(element) || element;
    if ((action === 'click' || (action === 'press' && (command.key !== 'Enter' || !enterAction(element)))) && finalAction.test(accessibleName(control))) {
      if (command.askBeforeFinalActions === false) return null;
      const binding = command.approvalBinding;
      if (!binding) return 'Approval required for this final action; nothing was clicked.';
      if (binding.fingerprint !== pageFingerprint() || binding.name !== accessibleName(control)
        || binding.tag !== String(control.tagName || '').toLowerCase()
        || (binding.ref && (!command.target?.ref || command.target.ref !== binding.ref || locate({ ref: binding.ref }) !== element))) return 'The page changed; nothing was clicked.';
    }
    return null;
  };
  try {
    if (!command || typeof command.type !== 'string') throw new Error('Invalid command.');
    if (command.type === 'inspect_action') {
      if (command.finalNavigation) return { ok: true, result: { finalAction: true, name: command.url, fingerprint: pageFingerprint(), url: location.href, title: document.title, requestedUrl: command.url } };
      const element = command.target ? locate(command.target) : document.activeElement;
      if (!element) return { ok: false, error: 'Target element was not found.' };
      if (command.key === 'Enter') {
        const action = enterAction(element);
        if (action) return { ok: true, result: { finalAction: !action.search, name: action.name,
          tag: String(element.tagName || '').toLowerCase(), ref: command.target ? refFor(element) : null,
          context: contextFor(element), fingerprint: pageFingerprint(), url: location.href, title: document.title } };
      }
      const control = actionControlFor(element) || element;
      const name = accessibleName(control);
      return { ok: true, result: { finalAction: finalAction.test(name), name, context: contextFor(control), tag: String(control.tagName || '').toLowerCase(), ref: refFor(control), fingerprint: pageFingerprint(), url: location.href, title: document.title } };
    }
    if (command.type === 'find') return findLive(command.selector);
    if (command.type === 'scroll') {
      const amount = Number(command.amount) || 400;
      const horizontal = command.direction === 'left' || command.direction === 'right';
      const axis = horizontal ? { left: command.direction === 'left' ? -amount : amount } : { top: command.direction === 'up' ? -amount : amount };
      const root = document.scrollingElement || document.documentElement;
      const documentScrolls = horizontal ? root?.scrollWidth > root?.clientWidth : root?.scrollHeight > root?.clientHeight;
      const candidates = documentScrolls ? [] : [...document.querySelectorAll('main, [role="main"], [class*="scroll"], [style*="overflow"], [data-scrollable], article')];
      const container = candidates.find((element) => horizontal ? element.scrollWidth > element.clientWidth : element.scrollHeight > element.clientHeight);
      const scroller = container || window;
      scroller.scrollBy({ ...axis, behavior: 'instant' });
      return { ok: true, result: { scrolled: true, scrollY: container ? container.scrollTop : window.scrollY, scrollHeight: container ? container.scrollHeight : root?.scrollHeight, viewportHeight: container ? container.clientHeight : window.innerHeight } };
    }
    if (command.type === 'wait') return new Promise((resolve) => setTimeout(() => resolve({ ok: true, result: { waitedMs: command.ms } }), command.ms));
    if (command.type === 'navigate') { location.assign(command.url); return { ok: true, result: { navigating: true } }; }
    const element = command.type === 'press' && !command.target ? document.activeElement || document : locate(command.target);
    if (!element) return { ok: false, error: command.approvalBinding ? 'The page changed; nothing was clicked.' : 'Target element was not found.' };
    const refusal = refuse(element, command.type);
    if (refusal) return { ok: false, error: refusal };
    if (command.type === 'click') {
      const trigger = element.getAttribute?.('aria-haspopup') != null || element.getAttribute?.('aria-expanded') != null;
      const visibleBefore = new Set([...(document.querySelectorAll?.('[role="menu"],[role="listbox"],[role="dialog"]') || [])].filter(isVisible));
      activate(element);
      let opened = null;
      if (trigger) {
        const controlled = String(element.getAttribute?.('aria-controls') || '').split(/\s+/).map((id) => document.getElementById?.(id)).find((node) => node && isVisible(node));
        const surface = controlled || [...(document.querySelectorAll?.('[role="menu"],[role="listbox"],[role="dialog"]') || [])].find((node) => isVisible(node) && !visibleBefore.has(node));
        if (surface) {
          opened = { role: surface.getAttribute?.('role') || 'menu', items: [...surface.querySelectorAll('button,[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],a')]
            .filter(isVisible).slice(0, 40).map((item) => ({ ref: refFor(item), name: accessibleName(item).slice(0, 200) })).filter((item) => item.ref && item.name) };
        }
      }
      return { ok: true, result: { clicked: true, ...(opened ? { opened } : {}) } };
    }
    if (command.type === 'press') {
      if (!pressKeys.has(command.key)) return { ok: false, error: 'Unsupported key.' };
      const action = command.key === 'Enter' ? enterAction(element) : null;
      const blocked = command.key === 'Enter' ? finalEnterRefusal(element, action) : null;
      if (blocked) return { ok: false, error: blocked };
      const overlay = command.key === 'Escape' ? element.closest?.('[role="menu"],[role="dialog"],[role="listbox"]') : null;
      const controlled = command.key === 'Escape' && element.getAttribute?.('aria-expanded') === 'true'
        ? String(element.getAttribute?.('aria-controls') || '').split(/\s+/).map((id) => document.getElementById?.(id)).find((node) => node && isVisible(node)) : null;
      const surface = overlay && isVisible(overlay) ? overlay : controlled;
      element.focus?.(); press(element, command.key);
      if (command.key === 'Enter') {
        if (action?.kind === 'form') {
          if (action.form.requestSubmit) action.form.requestSubmit(action.button || undefined);
          else if (action.button) action.button.click?.();
          return { ok: true, result: { pressed: 'Enter', submitted: 'form' } };
        }
        if (action?.kind === 'button') { action.button.click?.(); return { ok: true, result: { pressed: 'Enter', submitted: 'button' } }; }
        return { ok: true, result: { pressed: 'Enter', submitted: 'none' } };
      }
      if (command.key === 'Escape') {
        const trigger = surface && [...(document.querySelectorAll?.('[aria-controls]') || [])]
          .find((node) => String(node.getAttribute?.('aria-controls') || '').split(/\s+/).includes(surface.id));
        const closedByEvent = surface && !isVisible(surface);
        if (surface && !closedByEvent && trigger) trigger.click?.();
        return { ok: true, result: { pressed: 'Escape', closed: Boolean(closedByEvent || (surface && trigger)) } };
      }
      return { ok: true, result: { pressed: command.key } };
    }
    if (command.type === 'type') {
      if (!element.matches('input,textarea,[contenteditable="true"]')) return { ok: false, error: 'Target is not a writable text field.' };
      element.focus();
      if (element.isContentEditable) {
        const selection = document.getSelection?.();
        selection?.selectAllChildren?.(element);
        const inserted = document.execCommand?.('insertText', false, command.text);
        if (!inserted) { element.textContent = command.text; dispatch(element, 'input', { bubbles: true, inputType: 'insertText', data: command.text }, globalThis.InputEvent); }
      } else {
        const prototype = Object.getPrototypeOf(element);
        const fallback = element.matches('textarea') ? globalThis.HTMLTextAreaElement?.prototype : globalThis.HTMLInputElement?.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set || Object.getOwnPropertyDescriptor(fallback || {}, 'value')?.set;
        if (setter) setter.call(element, command.text);
        else element.value = command.text;
        dispatch(element, 'input', { bubbles: true, inputType: 'insertText', data: command.text }, globalThis.InputEvent);
        dispatch(element, 'change', { bubbles: true });
      }
      return { ok: true, result: { typed: true, characters: command.text.length, field: accessibleName(element) } };
    }
    if (command.type === 'select') {
      if (!(element instanceof HTMLSelectElement)) return { ok: false, error: 'Target is not a select element.' };
      const option = [...element.options].find((item) => command.value !== undefined ? item.value === command.value : item.textContent.trim() === command.optionText);
      if (!option) return { ok: false, error: 'Requested option was not found.' };
      element.value = option.value; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, result: { selected: true } };
    }
    return { ok: false, error: 'Unsupported command.' };
  } catch (error) { return { ok: false, ...(error.code ? { code: error.code } : {}), ...(error.candidates ? { candidates: error.candidates } : {}), error: error.message || 'Command execution failed.' }; }
}

// This function is injected as a self-contained verified-action executor. It
// may read current form values only inside the page execution world to compute
// a state hash. Pre-action values are never returned to the extension or broker.
export async function executeVerifiedActionCommand(command) {
  const descriptor = (element) => [element?.innerText, element?.textContent, element?.getAttribute?.('aria-label'), element?.getAttribute?.('placeholder'), element?.getAttribute?.('name'), element?.getAttribute?.('id')].filter(Boolean).join(' ');
  const dangerous = /(?:password|passcode|mfa|2fa|otp|verification|one[ -]?time|security.?code)/i;
  const finalAction = /\b(?:send|submit|apply(?![\s_-]+filters?\b)|post|repost|publish|share|like|unlike|follow|unfollow|delete|remove|buy|purchase|checkout|place[\s_-]+order|pay|e-?sign|sign|confirm|upload)\b/i;
  const cssEscape = (value) => (globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const locate = (target) => {
    if (!target || typeof target !== 'object') return null;
    if (target.ref) return document.querySelector(`[data-work-edge-ref="${cssEscape(target.ref)}"]`) || document.querySelector(`#${cssEscape(target.ref)}`);
    if (target.selector) { try { return document.querySelector(target.selector); } catch { return null; } }
    if (target.targetText) {
      const wanted = target.targetText.toLowerCase();
      return [...document.querySelectorAll('button,input,textarea,select,[contenteditable="true"],[role="button"]')].find((element) => descriptor(element).toLowerCase().includes(wanted)) || null;
    }
    return null;
  };
  const valueOf = (element) => element?.isContentEditable ? String(element.textContent || '') : String(element?.value ?? '');
  const assertField = (step) => {
    const element = locate(step.locator);
    if (!element) throw new Error(`Verified field was not found: ${step.field}`);
    if (element.matches?.('input[type="password"],input[type="hidden"],[hidden]') || dangerous.test(descriptor(element))) throw new Error(`Sensitive field cannot be used in a verified action: ${step.field}`);
    if (!element.matches?.('input,textarea,select,[contenteditable="true"]')) throw new Error(`Verified target is not a supported field: ${step.field}`);
    return element;
  };
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  };
  const hash = async (value) => {
    const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const observe = () => [...command.steps]
    .map((step) => ({ field: step.field, value: valueOf(assertField(step)) }))
    .sort((left, right) => left.field.localeCompare(right.field));
  const setValue = (element, step) => {
    const value = step.to === null ? '' : String(step.to);
    if (element.matches?.('select')) {
      const option = [...element.options].find((item) => item.value === value || item.textContent?.trim() === value);
      if (!option) throw new Error(`Verified option was not found: ${step.field}`);
      element.value = option.value;
    } else if (element.isContentEditable) element.textContent = value;
    else element.value = value;
    element.dispatchEvent?.(new Event('input', { bubbles: true }));
    element.dispatchEvent?.(new Event('change', { bubbles: true }));
  };
  try {
    if (!command || !['verified_preflight', 'verified_apply', 'verified_verify'].includes(command.type) || !Array.isArray(command.steps) || !command.steps.length) throw new Error('Invalid verified action command.');
    const current = observe();
    const currentBeforeHash = await hash(current);
    if (command.type === 'verified_preflight') return { ok: true, result: { currentBeforeHash, fields: current.map((item) => item.field) } };
    if (!/^[a-f0-9]{64}$/.test(command.proposalHash || '') || command.approval?.proposalHash !== command.proposalHash) throw new Error('Verified approval binding is invalid.');
    if (command.type === 'verified_verify') {
      return { ok: true, result: { persistedChanges: current.map((item) => ({ field: item.field, to: item.value })), method: 'dom-value-after-commit' } };
    }
    if (currentBeforeHash !== command.expectedBeforeHash) throw new Error('Pre-action state changed after approval.');
    for (const step of command.steps) setValue(assertField(step), step);
    const commit = locate(command.commit);
    if (!commit || !commit.matches?.('button,input[type="submit"],[role="button"]') || !finalAction.test(descriptor(commit))) throw new Error('Verified commit control was not found or is not an explicit final action.');
    commit.click?.();
    return { ok: true, result: { currentBeforeHash, committed: true } };
  } catch (error) { return { ok: false, error: error.message || 'Verified action failed.' }; }
}
