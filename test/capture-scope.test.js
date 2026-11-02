import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

class Element {
  constructor(tagName, { attrs = {}, className = '', text = '', hidden = false, children = [], shadowChildren = [] } = {}) {
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
    this.nodeType = 1;
    this.attrs = attrs;
    this.className = className;
    this.ownText = text;
    this.hidden = hidden;
    this.children = children;
    for (const child of children) { child.parentNode = this; child.parentElement = this; }
    this.childNodes = [
      ...(text ? [{ nodeType: 3, nodeValue: text, parentNode: this }] : []),
      ...children
    ];
    this.shadowRoot = shadowChildren.length ? {
      nodeType: 11,
      childNodes: shadowChildren,
      parentNode: this
    } : null;
    for (const child of shadowChildren) child.parentNode = this.shadowRoot;
  }

  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = value; }
  get classList() { return { contains: (name) => this.className.split(/\s+/u).includes(name) }; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
  get textContent() { return [this.ownText, ...this.children.map((child) => child.textContent)].join(''); }
  get isContentEditable() { return this.hasAttribute('contenteditable'); }
  get innerText() { return this.hidden ? '' : [this.ownText, ...this.children.map((child) => child.innerText)].filter(Boolean).join('\n'); }
  cloneNode(deep) { return new Element(this.tagName, { attrs: { ...this.attrs }, className: this.className, text: this.ownText, hidden: this.hidden, children: deep ? this.children.map((child) => child.cloneNode(true)) : [] }); }
  remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part));
    const trimmed = selector.trim();
    if (trimmed === 'svg title') return this.tagName === 'TITLE' && this.parentNode?.tagName === 'SVG';
    const tag = trimmed.match(/^[a-z][\w-]*/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    for (const className of [...trimmed.matchAll(/\.([\w-]+)/g)].map((match) => match[1])) if (!this.className.split(/\s+/).includes(className)) return false;
    for (const match of trimmed.matchAll(/\[([\w-]+)(?:\*?=["']?([^\]"']+)["']?)?(?:\s+i)?\]/g)) {
      const [, name, expected] = match;
      const value = this.getAttribute(name);
      if (value === null || (expected && !value.toLowerCase().includes(expected.trim().toLowerCase()))) return false;
    }
    return true;
  }
  querySelectorAll(selectors) {
    const all = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
    return all.filter((element) => selectors.split(',').some((selector) => selector.trim() === '*' || element.matches(selector)));
  }
  querySelector(selectors) { return this.querySelectorAll(selectors)[0] || null; }
}

function capture(body, readEditable = false) {
  const window = { frames: [] };
  window.parent = window;
  const document = {
    body,
    title: 'Opened message - Mail',
    querySelectorAll(selectors) {
      const all = [body, ...body.querySelectorAll('*')];
      if (selectors.includes('[role="grid"] [role="row"]')) return all.filter((element) =>
        (element.tagName === 'TR' && (element.classList.contains('zA') || element.parentElement?.tagName === 'TABLE'))
        || (element.getAttribute('role') === 'option' && element.parentElement?.getAttribute('role') === 'listbox')
        || (element.getAttribute('role') === 'listitem' && element.parentElement?.getAttribute('role') === 'list'));
      return all.filter((element) => selectors.split(',').some((selector) => selector.trim() === '*' || element.matches(selector)));
    },
    getElementById(id) { return this.querySelectorAll('*').find((element) => element.getAttribute('id') === id) || null; }
  };
  const source = readFileSync(new URL('../extension/content/capture.js', import.meta.url), 'utf8').replace('export function capturePage', 'function capturePage');
  return vm.runInNewContext(`${source}\ncapturePage(readEditable)`, {
    document,
    readEditable,
    // A page-owned variable cannot opt the extension into reading drafts.
    readEditableText: true,
    window,
    location: { href: 'https://mail.example.test/inbox' },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11 },
    getComputedStyle: (element) => ({ display: element.hidden || element.getAttribute?.('style')?.includes('display:none') ? 'none' : 'block', visibility: element.hidden ? 'hidden' : 'visible' })
  });
}

test('Gmail message scope wins over the still-mounted mailbox shell', () => {
  const result = capture(new Element('body', { children: [
    new Element('nav', { text: 'Inbox\nStarred\nSent\n1–50 of 2,001\nInbox row: unrelated notification\nInbox row: old thread' }),
    new Element('main', { attrs: { role: 'main' }, children: [
      new Element('article', { children: [new Element('h2', { text: 'Your September 25 Virtual Graduation Details' }), new Element('div', { className: 'adn', children: [new Element('div', { className: 'a3s', text: 'Fresh email body\nYour ceremony details are attached.' })] })] })
    ] })
  ] }));
  assert.match(result.text, /Fresh email body/);
  assert.match(result.text, /Your September 25 Virtual Graduation Details/);
  assert.doesNotMatch(result.text, /1–50 of 2,001|Inbox row: unrelated notification/);
});

test('mail rows expose bounded click refs and unread state', () => {
  const gmail = new Element('table', { children: Array.from({ length: 5 }, (_, index) =>
    new Element('tr', { className: index < 3 ? 'zA zE' : 'zA', text: `Sender ${index} Subject ${index}` })) });
  const outlook = new Element('div', { attrs: { role: 'listbox' }, children: [
    new Element('div', { attrs: { role: 'option', 'aria-label': 'Unread: project update' }, text: 'Project update' })] });
  const result = capture(new Element('body', { children: [gmail, outlook] }));
  assert.equal(result.rows.length, 6);
  assert.deepEqual(Array.from(result.rows, (row) => row.unread), [true, true, true, false, false, true]);
  assert.ok(result.rows.every((row) => /^work-edge-/u.test(row.ref)));
  const many = capture(new Element('body', { children: [new Element('table', { children: Array.from({ length: 45 }, (_, index) => new Element('tr', { text: `Email ${index}` })) })] }));
  assert.equal(many.rows.length, 40);
});

test('editable text is opt-in while form controls remain excluded in either mode', () => {
  const body = new Element('body', { children: [
    new Element('div', { attrs: { contenteditable: 'true' }, text: 'Visible document draft', children: [new Element('textarea', { text: 'Private textarea value' }), new Element('input', { attrs: { value: 'Private input value' } }), new Element('select', { children: [new Element('option', { text: 'Private choice' })] })] }),
    new Element('div', { attrs: { contenteditable: 'true' }, text: 'Hidden draft', hidden: true })
  ] });
  assert.doesNotMatch(capture(body).text, /Visible document draft|Private|Hidden draft/);
  const enabled = capture(body, true);
  assert.match(enabled.text, /Visible document draft/);
  assert.doesNotMatch(enabled.text, /Private textarea value|Private input value|Private choice|Hidden draft/);
});

test('capture exposes safe named fields without their contents or sensitive fields', () => {
  const search = new Element('input', { attrs: { type: 'search', placeholder: 'Search jobs' } });
  search.value = 'private query';
  const notes = new Element('textarea', { attrs: { 'aria-label': 'Notes' }, text: 'private draft' });
  notes.value = 'private draft';
  const password = new Element('input', { attrs: { type: 'password', placeholder: 'Password' } });
  const mfa = new Element('input', { attrs: { type: 'text', placeholder: 'Verification code' } });
  const hidden = new Element('div', { attrs: { style: 'display:none' }, children: [new Element('button', { text: 'Hidden menu item' })] });
  const card = new Element('input', { attrs: { type: 'text', autocomplete: 'cc-number', placeholder: 'Number on front' } });
  const cvv = new Element('input', { attrs: { type: 'text', placeholder: 'CVV' } });
  const ssn = new Element('input', { attrs: { type: 'text', 'aria-label': 'Social Security number' } });
  const account = new Element('input', { attrs: { type: 'text', name: 'routing_number', placeholder: 'Routing' } });
  const body = new Element('body', { children: [search, notes, password, mfa, hidden, card, cvv, ssn, account] });
  const result = capture(body);
  const fields = result.elementSummary.filter((item) => item.ref);
  assert.deepEqual(Array.from(fields, (item) => item.name), ['Search jobs', 'Notes']);
  assert.deepEqual(Array.from(fields, (item) => item.hasValue), [true, true]);
  assert.doesNotMatch(JSON.stringify(result.elementSummary), /private query|private draft|Password|Verification code|Hidden menu item|Number on front|CVV|Social Security|Routing/u);
});

test('Gmail capture starts at an opened thread after a long mounted inbox shell', () => {
  const inboxShell = `LabelsInbox\nAllNoneReadUnread\n1–50 of 124,625\nConversationsunread\n${'Mailbox row: unrelated message\n'.repeat(1200)}`;
  const result = capture(new Element('body', { children: [
    new Element('main', { attrs: { role: 'main' }, children: [
      new Element('article', { children: [
        new Element('div', { text: inboxShell }),
        new Element('h2', { text: 'Your September 25 Virtual Graduation Details' }),
        new Element('div', { className: 'adn', children: [new Element('div', { className: 'a3s', text: 'Virtual Graduation\nFriday, September 25, 2026\nJoin your ceremony online.' })] })
      ] })
    ] })
  ] }));
  assert.match(result.text, /^Your September 25 Virtual Graduation Details/);
  assert.match(result.text, /Virtual Graduation\nFriday, September 25, 2026/);
  assert.ok(result.text.length < 20_000);
  assert.doesNotMatch(result.text, /LabelsInbox|AllNoneReadUnread|1–50 of|Conversationsunread|Mailbox row/);
});

test('does not select a broad Gmail main when it has cleaner nested message surfaces', () => {
  const result = capture(new Element('body', { children: [
    new Element('main', { attrs: { role: 'main' }, children: [
      new Element('div', { text: 'LabelsInbox\nAllNoneReadUnread\n1–50 of 124,625\nConversationsunread' }),
      new Element('h2', { text: 'Opened Gmail subject' }),
      new Element('div', { attrs: { 'data-message-id': 'message-1' }, children: [new Element('div', { className: 'a3s', text: 'Opened Gmail body details.' })] })
    ] })
  ] }));
  assert.match(result.text, /^Opened Gmail subject/);
  assert.match(result.text, /Opened Gmail body details/);
  assert.doesNotMatch(result.text, /LabelsInbox|AllNoneReadUnread|1–50 of|Conversationsunread/);
});

test('combines the Gmail subject and visible bodies from the selected thread only', () => {
  const result = capture(new Element('body', { children: [
    new Element('main', { attrs: { role: 'main' }, children: [
      new Element('div', { text: 'LabelsInbox\n1–50 of 124,625\nMailbox row: unrelated notification' }),
      new Element('h2', { text: 'Selected thread subject' }),
      new Element('div', { attrs: { 'data-message-id': 'first' }, children: [new Element('div', { className: 'adn', children: [new Element('div', { className: 'a3s', text: 'First visible message body.' })] })] }),
      new Element('div', { attrs: { 'data-message-id': 'second' }, children: [new Element('div', { className: 'adn', children: [new Element('div', { className: 'a3s', text: 'Second visible message body.' })] })] })
    ] })
  ] }));
  assert.match(result.text, /^Selected thread subject/);
  assert.match(result.text, /First visible message body/);
  assert.match(result.text, /Second visible message body/);
  assert.doesNotMatch(result.text, /LabelsInbox|1–50 of|Mailbox row/);
});

test('Outlook reading pane wins over the mailbox list', () => {
  const result = capture(new Element('body', { children: [
    new Element('aside', { text: 'Focused\nInbox\n1–50 of 500\nMailbox row: weekly newsletter' }),
    new Element('section', { attrs: { 'aria-label': 'Reading Pane' }, children: [new Element('div', { attrs: { role: 'document' }, children: [new Element('h1', { text: 'Outlook message subject' }), new Element('div', { text: 'Outlook reading pane body with the requested details.' })] })] })
  ] }));
  assert.match(result.text, /Outlook reading pane body/);
  assert.doesNotMatch(result.text, /Mailbox row: weekly newsletter|1–50 of 500/);
});

test('Outlook Fluent reading pane body wins over the stale empty-pane mailbox shell', () => {
  const result = capture(new Element('body', { children: [
    new Element('main', { attrs: { role: 'main' }, text: 'Focused\nInbox\nSelect an item to read\nNothing is selected\nMailbox row: old message' }),
    new Element('div', { attrs: { 'data-app-section': 'ReadingPane' }, children: [
      new Element('div', { children: [
        new Element('h1', { text: 'Your September 25 Virtual Graduation Details' }),
        new Element('div', { text: 'You are expected to graduate on Friday, September 25, 2026.' })
      ] })
    ] })
  ] }));
  assert.match(result.text, /Your September 25 Virtual Graduation Details/);
  assert.match(result.text, /expected to graduate on Friday, September 25, 2026/);
  assert.doesNotMatch(result.text, /Select an item to read|Nothing is selected|Mailbox row: old message/);
});

test('Outlook Fluent capture includes a mail row rendered in an open shadow root', () => {
  const result = capture(new Element('body', { children: [
    new Element('main', { attrs: { role: 'main' }, text: 'Nothing is selected' }),
    new Element('section', { attrs: { 'aria-label': 'Reading Pane' }, children: [
      new Element('div', { attrs: { role: 'row' }, shadowChildren: [
        new Element('div', { text: 'Shadow-rendered Outlook message: September 25 ceremony details.' })
      ] })
    ] })
  ] }));
  assert.match(result.text, /Shadow-rendered Outlook message/);
  assert.doesNotMatch(result.text, /Nothing is selected/);
});

test('falls back to normal page text when no message surface exists', () => {
  const result = capture(new Element('body', { children: [new Element('main', { text: 'Normal work page content' })] }));
  assert.equal(result.text, 'Normal work page content');
});

test('three job cards keep each company with its title in separate line blocks', () => {
  const jobs = [
    ['Ford Audio-Video, LLC', 'Project Engineer'],
    ['Sourcebooks Inc', 'Audio Production Associate'],
    ['SAE Institute', 'Audio Instructor']
  ];
  const cards = jobs.map(([company, title]) => new Element('article', { children: [
    new Element('div', { text: company }), new Element('h3', { text: title })
  ] }));
  const result = capture(new Element('body', { children: [new Element('section', { children: cards })] }));
  assert.equal(result.text, jobs.map(([company, title]) => `---\n${company} · ${title}`).join('\n'));
  assert.equal(result.text_total_chars, result.text.length);
});

test('plain sibling div cards keep each company, title, and pay in one block', () => {
  const jobs = [
    ['PRG', 'Technician, Audio', '$25 per hour'],
    ['Encore', 'Audio Engineer', '$30 per hour'],
    ['AVI-SPL', 'AV Technician', '$28 per hour'],
    ['Sundown', 'Sound Designer', '$35 per hour']
  ];
  const cards = jobs.map(([company, title, pay]) => new Element('div', {
    className: 'sc-iyFuvt hQivZy sc-iCwKwi jREaVK',
    children: [new Element('div', { attrs: { role: 'region' }, className: 'rosetta-card', children: [
      new Element('div', { text: company }), new Element('h3', { text: title }), new Element('div', { text: pay })
    ] })]
  }));
  const result = capture(new Element('body', { children: [new Element('section', { children: cards })] }));
  assert.equal(result.text, '---\nPRG · Technician, Audio · $25 per hour\n---\nEncore · Audio Engineer · $30 per hour\n---\nAVI-SPL · AV Technician · $28 per hour\n---\nSundown · Sound Designer · $35 per hour');
  assert.equal(result.text.match(/---/g).length, 4);
});

test('plain div siblings with different classes do not get card boundaries', () => {
  const cards = ['First company and title', 'Second company and title', 'Third company and title'].map((text, index) =>
    new Element('div', { className: `item-${index}`, text }));
  assert.equal(capture(new Element('body', { children: [new Element('section', { children: cards })] })).text,
    'First company and title\nSecond company and title\nThird company and title');
});

test('two matching plain div siblings do not get card boundaries', () => {
  const cards = ['First company and title', 'Second company and title'].map((text) =>
    new Element('div', { className: 'job-result', text }));
  assert.equal(capture(new Element('body', { children: [new Element('section', { children: cards })] })).text,
    'First company and title\nSecond company and title');
});

test('matching hook prefixes separate cards without a shared class', () => {
  const cards = ['First company and title', 'Second company and title', 'Third company and title'].map((text, index) =>
    new Element('div', { attrs: { 'data-hook': `job-result | ${100 + index}` }, text }));
  assert.equal(capture(new Element('body', { children: [new Element('section', { children: cards })] })).text,
    '---\nFirst company and title\n---\nSecond company and title\n---\nThird company and title');
});

test('matching test ID prefixes separate cards without a shared class', () => {
  const cards = ['First company and title', 'Second company and title', 'Third company and title'].map((text, index) =>
    new Element('div', { attrs: { 'data-testid': `job-result${100 + index}` }, text }));
  assert.equal(capture(new Element('body', { children: [new Element('section', { children: cards })] })).text,
    '---\nFirst company and title\n---\nSecond company and title\n---\nThird company and title');
});

test('structural cards keep nested repeated rows inside each outer block', () => {
  const cards = ['First company', 'Second company', 'Third company'].map((company) =>
    new Element('div', { className: 'job-shell', children: [
      new Element('div', { text: company }),
      new Element('div', { children: ['Audio role detail here', 'Pay range detail here', 'Location detail here'].map((text) =>
        new Element('div', { className: 'detail-row', text })) })
    ] }));
  const result = capture(new Element('body', { children: [new Element('section', { children: cards })] }));
  assert.equal(result.text.match(/---/g).length, 3);
  assert.match(result.text, /^---\nFirst company · Audio role detail here · Pay range detail here · Location detail here\n---\nSecond company/);
});

test('short or hidden siblings do not establish structural card boundaries', () => {
  const cards = [
    new Element('div', { className: 'job-result', text: 'First company and title' }),
    new Element('div', { className: 'job-result', text: 'Short' }),
    new Element('div', { className: 'job-result', text: 'Third company and title' }),
    new Element('div', { className: 'job-result', text: 'Hidden company and title', hidden: true })
  ];
  assert.equal(capture(new Element('body', { children: [new Element('section', { children: cards })] })).text,
    'First company and title\nShort\nThird company and title');
});

test('a single navigation list item does not get a separator', () => {
  const result = capture(new Element('body', { children: [new Element('nav', { children: [
    new Element('ul', { children: [new Element('li', { text: 'Jobs' })] })
  ] })] }));
  assert.equal(result.text, 'Jobs');
});

test('nested lists only separate the outer repeated items', () => {
  const items = ['First', 'Second', 'Third'].map((label) => new Element('li', { children: [
    new Element('span', { text: label }),
    new Element('ul', { children: ['A', 'B', 'C'].map((value) => new Element('li', { text: value })) })
  ] }));
  const result = capture(new Element('body', { children: [new Element('ul', { children: items })] }));
  assert.equal(result.text, ['First', 'Second', 'Third'].map((label) => `---\n${label} · A · B · C`).join('\n'));
  assert.equal(result.text.match(/---/g).length, 3);
});

test('a 60k-character page is captured whole', () => {
  const result = capture(new Element('body', { text: 'A'.repeat(60_000) }));
  assert.equal(result.text.length, 60_000);
  assert.equal(result.text_total_chars, 60_000);
});

test('strips sensitive controls from a selected message surface', () => {
  const result = capture(new Element('body', { children: [new Element('main', { attrs: { role: 'main' }, children: [
    new Element('article', { text: 'Safe message text', children: [new Element('input', { attrs: { type: 'password' }, text: 'secret-value' }), new Element('textarea', { text: 'private reply draft' }), new Element('div', { attrs: { contenteditable: 'true' }, text: 'editable draft' })] })
  ] })] }));
  assert.match(result.text, /Safe message text/);
  assert.doesNotMatch(result.text, /secret-value|private reply draft|editable draft/);
});

test('passive summaries include safe field names and never include field contents', () => {
  const link = new Element('a', { text: 'Open details' });
  const button = new Element('button', { text: 'Open panel' });
  const input = new Element('input', { attrs: { role: 'button', 'aria-label': 'Safe search' } });
  const textarea = new Element('textarea', { text: 'Private draft' });
  const select = new Element('select', { text: 'Private choice' });
  const result = capture(new Element('body', { children: [link, button, input, textarea, select] }));
  assert.deepEqual(Array.from(result.elementSummary.slice(0, 2), (item) => ({ ...item })), [{ tag: 'a', text: 'Open details' }, { tag: 'button', text: 'Open panel' }]);
  assert.equal(result.elementSummary[2].name, 'Safe search');
  assert.ok(result.elementSummary[2].ref);
  assert.doesNotMatch(JSON.stringify(result.elementSummary), /Private draft|Private choice/u);
});

test('passive summaries use the same accessible-name fallback order and list safe fields', () => {
  const cases = [
    [new Element('button', { attrs: { 'aria-label': 'Open profile options' } }), 'Open profile options'],
    [new Element('button', { attrs: { 'aria-labelledby': 'first second' } }), 'Profile options'],
    [new Element('button', { attrs: { title: 'Open menu' } }), 'Open menu'],
    [new Element('button', { children: [new Element('img', { attrs: { alt: 'Alex Example' } })] }), 'Alex Example'],
    [new Element('button', { children: [new Element('svg', { children: [new Element('title', { text: 'Settings' })] })] }), 'Settings'],
    [new Element('button', { children: [new Element('span', { attrs: { 'aria-label': 'Account options' } })] }), 'Account options'],
    [new Element('button', { attrs: { 'aria-label': 'Other name' }, text: 'Visible  name' }), 'Visible name']
  ];
  Object.defineProperty(cases[4][0], 'innerText', { value: '' });
  const inputs = [new Element('input', { attrs: { role: 'button', title: 'Search' } }), new Element('textarea', { text: 'Private draft' })];
  const result = capture(new Element('body', { children: [
    new Element('span', { attrs: { id: 'first' }, text: 'Profile' }),
    new Element('span', { attrs: { id: 'second' }, text: 'options' }),
    ...cases.map(([item]) => item), ...inputs
  ] }));
  assert.deepEqual(Array.from(result.elementSummary.slice(0, cases.length), (item) => item.text), cases.map(([, name]) => name));
  assert.equal(result.elementSummary[cases.length].name, 'Search');
});
