/*
  Claude API Chat
  Runs entirely in your browser. Your API key, chats and memory pack stay on this device,
  and messages go straight from here to api.anthropic.com.

  Safe to edit: the MODELS / OTHER_PRICES tables and DEFAULT_SETTINGS below.
*/
'use strict';
(function () {

// ================= Config (edit freely) =================

const APP_VERSION = '1.1';
const API_VERSION = '2023-06-01';
const MAX_TOOL_STEPS = 8;
const WEB_SEARCH_PRICE = 0.01; // dollars per search

// Prices are US dollars per million tokens, from platform.claude.com/docs/en/about-claude/pricing (Nov 2026).
// in = input, out = output, cw = 5-minute cache write, cr = cache read.
const MODELS = [
  { id: 'claude-fable-5-2',  label: 'Fable 5.2',  note: 'deepest, priciest', price: { in: 8,    out: 40,   cw: 10,    cr: 0.20 } },
  { id: 'claude-opus-5-5',   label: 'Opus 5.5',   note: 'best for most work', price: { in: 4,    out: 20,   cw: 5,     cr: 0.20 } },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: 'fast and capable',  price: { in: 2,    out: 10,   cw: 2.5,   cr: 0.10 } },
  { id: 'claude-haiku-5-5',  label: 'Haiku 5.5',  note: 'fastest, cheapest', price: { in: 0.10, out: 0.50, cw: 0.125, cr: 0.01 },
    longPrice: { in: 0.50, out: 2.50, cw: 0.625, cr: 0.05 }, longAbove: 100000 },
];

// Rough prices for older models you might load from your account (matched by ID).
const OTHER_PRICES = [
  { match: /^claude-mythos-5-2/,      price: { in: 8,  out: 40, cw: 10,    cr: 0.20 } },
  { match: /^claude-(fable|mythos)-5/, price: { in: 10, out: 50, cw: 12.5,  cr: 0.25 } },
  { match: /^claude-opus-5/,           price: { in: 5,  out: 25, cw: 6.25,  cr: 0.50 } },
  { match: /^claude-opus-4-[5-9]/,     price: { in: 5,  out: 25, cw: 6.25,  cr: 0.50 } },
  { match: /^claude-opus-4/,           price: { in: 15, out: 75, cw: 18.75, cr: 1.50 } },
  { match: /^claude-sonnet-5/,         price: { in: 2,  out: 10, cw: 2.5,   cr: 0.20 } },
  { match: /^claude-sonnet-4/,         price: { in: 3,  out: 15, cw: 3.75,  cr: 0.30 } },
  { match: /^claude-haiku-4-5/,        price: { in: 1,  out: 5,  cw: 1.25,  cr: 0.10 } },
];

// [value, short label for the top bar, label for Settings]
const EFFORTS = [
  ['', 'Effort', "Model's default"],
  ['low', 'Low', 'Low (quickest, cheapest)'],
  ['medium', 'Medium', 'Medium'],
  ['high', 'High', 'High'],
  ['xhigh', 'Extra high', 'Extra high'],
  ['max', 'Max', 'Max (slowest, priciest)'],
];

const DEFAULT_SETTINGS = {
  model: 'claude-fable-5-2',
  effort: '',            // '' = the model's own default
  showThinking: true,
  webSearch: true,
  maxTokens: 32000,
  warnAt: 75,
};

// ================= Internals =================

const K = { key: 'acc.key', settings: 'acc.settings', compat: 'acc.compat', spend: 'acc.spend', models: 'acc.models', base: 'acc.apiBase', last: 'acc.lastChat', time: 'acc.timeScale' };
const DROP_BETA = 'thinking-binding-controls-2026-08-01';
const MEMORY_TOOL = {
  name: 'read_memory',
  description: "Read files from the user's memory pack by path, as listed in the memory index in the system prompt. Returns each file's full text. Use it before answering anything that depends on their projects, people or past decisions.",
  input_schema: {
    type: 'object',
    properties: { paths: { type: 'array', items: { type: 'string' }, description: 'One or more paths from the memory index, e.g. /areas/mountain-wives.md' } },
    required: ['paths'],
  },
};
const WEB_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };

const state = {
  settings: Object.assign({}, DEFAULT_SETTINGS),
  apiKey: '',
  pack: null,
  chats: [],
  chat: null,
  live: null,          // { chatId, content }
  controller: null,
  files: [],
  compat: {},
  extraModels: [],
  idbOk: true,
  runningChatId: null,
};

// Keeping replies alive on a phone. iPhone freezes a web page when the screen locks or you switch
// apps, which usually kills a reply that's still coming in. So the app keeps the screen awake while
// a reply streams, notices when the page was frozen, and reconnects on its own.
// acc.timeScale is only for testing (it speeds up every wait below).
const SCALE = Math.min(1, Math.max(0.01, Number(lsGet(K.time, 1)) || 1));
const TICK = Math.max(100, Math.round(1000 * SCALE));
const watch = { attempt: null, lastTick: Date.now(), wake: null, waking: false, longKilled: false };

// ---------- small helpers ----------
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
function rawGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function sessGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
function uid() { try { return crypto.randomUUID(); } catch (e) { return Date.now().toString(36) + Math.random().toString(36).slice(2); } }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function monthKey() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function money(x) {
  if (x == null || isNaN(x)) return '';
  if (x === 0) return '$0';
  if (x < 0.01) return '<$0.01';
  if (x < 100) return '$' + x.toFixed(2);
  return '$' + Math.round(x);
}
function tok(n) {
  n = n || 0;
  if (n < 1000) return String(n);
  if (n < 100000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n / 1000) + 'k';
}
function clampInt(v, lo, hi, d) { v = parseInt(v, 10); if (isNaN(v)) return d; return Math.max(lo, Math.min(hi, v)); }
function shortDate(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function apiBase() { const b = lsGet(K.base, null); return (typeof b === 'string' && b) ? b.replace(/\/$/, '') : 'https://api.anthropic.com'; }
function modelInfo(id) { return MODELS.find((m) => m.id === id) || null; }
function modelLabel(id) {
  const m = modelInfo(id);
  if (m) return m.label;
  const x = state.extraModels.find((e) => e.id === id);
  return x ? (x.label || id) : id;
}
function isTouch() { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } }

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}

// Two-tap confirm for destructive buttons (no browser dialogs).
function confirmTap(btn, label, ask, fn) {
  if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.classList.remove('confirm'); btn.textContent = label; fn(); return; }
  btn.dataset.armed = '1'; btn.classList.add('confirm'); btn.textContent = ask;
  setTimeout(() => { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.classList.remove('confirm'); btn.textContent = label; } }, 3500);
}

// ---------- IndexedDB (chats + memory pack) ----------
const db = {
  _p: null,
  open() {
    if (this._p) return this._p;
    this._p = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open('claude-api-chat', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._p;
  },
  async run(store, mode, fn) {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const r = fn(tx.objectStore(store));
      let out;
      if (r) r.onsuccess = () => { out = r.result; };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  all(s) { return this.run(s, 'readonly', (o) => o.getAll()); },
  get(s, k) { return this.run(s, 'readonly', (o) => o.get(k)); },
  put(s, v) { return this.run(s, 'readwrite', (o) => o.put(v)); },
  del(s, k) { return this.run(s, 'readwrite', (o) => o.delete(k)); },
  clear(s) { return this.run(s, 'readwrite', (o) => o.clear()); },
};
async function saveChat(chat) {
  if (!state.idbOk) return;
  try { await db.put('chats', chat); } catch (e) { state.idbOk = false; toast("This browser isn't saving chats right now."); }
}

// ---------- memory pack ----------
function parsePack(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const pack = { name: '', made: '', profile: '', preferences: '', notes: '', index: [], files: {} };
  let sec = 'header', path = '', buf = [];
  const flush = () => {
    const t = buf.join('\n').trim();
    if (sec === 'header') {
      const n = t.match(/^name:\s*(.+)$/mi); if (n) pack.name = n[1].trim();
      const m = t.match(/^made:\s*(.+)$/mi); if (m) pack.made = m[1].trim();
    } else if (sec === 'index') {
      for (const l of t.split('\n')) { const mm = l.match(/^\s*(\/\S+)\s*::\s*(.*)$/); if (mm) pack.index.push({ path: mm[1], desc: mm[2].trim() }); }
    } else if (sec === 'file') {
      if (path) pack.files[path] = t;
    } else {
      pack[sec] = t;
    }
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^@@\s+(PROFILE|PREFERENCES|NOTES|INDEX|FILE)\b\s*(.*)$/);
    if (m) { flush(); sec = m[1] === 'FILE' ? 'file' : m[1].toLowerCase(); path = m[1] === 'FILE' ? m[2].trim() : ''; continue; }
    buf.push(line);
  }
  flush();
  for (const p of Object.keys(pack.files)) if (!pack.index.some((e) => e.path === p)) pack.index.push({ path: p, desc: '' });
  if (!pack.profile && !pack.preferences && !pack.index.length) throw new Error("That doesn't look like a memory pack.");
  return pack;
}

async function setPack(text, persist) {
  const pack = parsePack(text);
  state.pack = pack;
  if (persist) {
    try { await db.put('kv', { k: 'pack', text, saved: Date.now() }); }
    catch (e) { toast("Memory loaded for now, but this browser won't keep it."); }
  }
  renderAll();
  renderSettings();
}

function runReadMemory(input) {
  let paths = [];
  if (input && Array.isArray(input.paths)) paths = input.paths;
  else if (input && typeof input.path === 'string') paths = [input.path];
  paths = paths.slice(0, 12).map((p) => String(p).trim()).filter(Boolean);
  if (!paths.length) return 'No paths given. Use paths from the memory index.';
  const pack = state.pack;
  if (!pack) return 'No memory pack is loaded on this device right now.';
  return paths.map((p) => {
    let key = p.startsWith('/') ? p : '/' + p;
    if (!pack.files[key] && !/\.md$/.test(key)) key += '.md';
    const f = pack.files[key];
    let body = f;
    if (!f) body = pack.index.some((e) => e.path === key) ? '(Not in the memory pack on this device. It lives only in their Claude app.)' : '(No such file in the memory index.)';
    return '=== ' + key + ' ===\n' + body;
  }).join('\n\n');
}

function buildSystem(pack, web) {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* ignore */ }
  const who = (pack && pack.name) || 'the user';
  const L = [];
  L.push(`You're Claude, talking with ${who} in a personal chat app that calls the Claude API with their own key. This conversation started on ${day}${tz ? ' (' + tz + ')' : ''}.`);
  L.push('');
  let have = `What's available here: this conversation and any files ${who} attaches (images, PDFs, text)`;
  if (web) have += ', plus web search. Search only when the answer depends on current or specific facts you may not know, since each search costs money';
  if (pack) have += `${web ? '. There is also' : ', plus'} a copy of ${who}'s Claude memory, below`;
  have += `. You can't reach their computer, email, calendar or other apps from here; if they ask for something that needs those, say it's a job for their Claude app.`;
  L.push(have);
  L.push('');
  L.push('Formatting: write natural prose by default and use markdown (headings, bullets, tables) only when it helps. Put drafts they will copy and send in plain paragraphs, not block quotes or code blocks.');
  if (pack) {
    L.push('');
    L.push(`# ${who}'s memory${pack.made ? ' (copy made ' + pack.made + ')' : ''}`);
    L.push('Below are their profile, their standing preferences, and an index of every memory file. Read files with the read_memory tool before answering anything that depends on their projects, people or past decisions, instead of guessing. Files marked [not in pack] exist only in their Claude app; if one matters, say so in a sentence and do your best without it.');
    L.push('Use memory the way a thoughtful assistant would: only where it changes the answer. Don\'t narrate it ("based on your memory", "I remember"), and don\'t decorate replies with personal details. Sensitive files (health, money, family) stay out of replies unless they raise the topic, ask you to use what you know, or a safe answer depends on it. Before suggesting any medication or supplement, read the health file if there is one.');
    L.push('This copy doesn\'t update itself. If they tell you something worth keeping, you can mention once that they can ask Claude in their Claude app to save it. Some preferences mention tools you don\'t have here (folders on their Mac, their calendar, screenshots); treat those as background, not tasks.');
    if (pack.profile) { L.push(''); L.push('## Profile'); L.push(pack.profile); }
    if (pack.preferences) { L.push(''); L.push('## Preferences (follow these)'); L.push(pack.preferences); }
    if (pack.notes) { L.push(''); L.push('## Notes they added'); L.push(pack.notes); }
    if (pack.index.length) {
      L.push(''); L.push('## Memory index');
      for (const e of pack.index) L.push('- ' + e.path + (e.desc ? ': ' + e.desc : '') + (pack.files[e.path] ? '' : ' [not in pack]'));
    }
  }
  return L.join('\n');
}

function newChatObj() {
  const s = state.settings;
  const tools = [];
  if (state.pack) tools.push(clone(MEMORY_TOOL));
  if (s.webSearch) tools.push(clone(WEB_TOOL));
  const t = Date.now();
  return {
    id: uid(), title: 'New chat', created: t, updated: t,
    model: s.model, system: buildSystem(state.pack, !!s.webSearch), tools,
    memory: !!state.pack, web: !!s.webSearch, dropBlocks: false, cost: 0, messages: [],
  };
}

// ---------- pricing ----------
function priceFor(id, promptTokens) {
  const m = modelInfo(id);
  if (m) return (m.longPrice && promptTokens > m.longAbove) ? m.longPrice : m.price;
  for (const o of OTHER_PRICES) if (o.match.test(id)) return o.price;
  return null;
}
function usageParts(u) {
  u = u || {};
  let cw5 = u.cache_creation_input_tokens || 0, cw1h = 0;
  if (u.cache_creation && typeof u.cache_creation === 'object') {
    const a = u.cache_creation.ephemeral_5m_input_tokens || 0, b = u.cache_creation.ephemeral_1h_input_tokens || 0;
    if (a || b) { cw5 = a; cw1h = b; }
  }
  return {
    fresh: u.input_tokens || 0, out: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cw5, cw1h,
    searches: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0,
  };
}
function costOf(id, u) {
  if (!u) return null;
  const p = usageParts(u);
  const pr = priceFor(id, p.fresh + p.cr + p.cw5 + p.cw1h);
  if (!pr) return null;
  return (p.fresh * pr.in + p.out * pr.out + p.cw5 * pr.cw + p.cw1h * (pr.in * 2) + p.cr * pr.cr) / 1e6 + p.searches * WEB_SEARCH_PRICE;
}
function addSpend(chat, cost) {
  if (cost == null) return;
  chat.cost = (chat.cost || 0) + cost;
  const s = lsGet(K.spend, {});
  const k = monthKey();
  s[k] = (s[k] || 0) + cost;
  lsSet(K.spend, s);
}
function monthSpend() { return lsGet(K.spend, {})[monthKey()] || 0; }

// ---------- API ----------
class ApiError extends Error {
  constructor(status, type, message, retryAfter) { super(message); this.status = status; this.type = type; this.retryAfter = retryAfter; }
}
function apiHeaders(beta) {
  const h = {
    'content-type': 'application/json',
    'x-api-key': state.apiKey,
    'anthropic-version': API_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (beta && beta.length) h['anthropic-beta'] = beta.join(',');
  return h;
}
async function readError(resp) {
  let type = '', message = '';
  try {
    const j = await resp.json();
    type = (j.error && j.error.type) || '';
    message = (j.error && j.error.message) || JSON.stringify(j);
  } catch (e) {
    try { message = await resp.text(); } catch (e2) { /* ignore */ }
  }
  return new ApiError(resp.status, type, message || resp.statusText || ('HTTP ' + resp.status), resp.headers.get('retry-after'));
}
function friendly(err) {
  if (!err) return 'Something went wrong.';
  if (err.name === 'AbortError') return 'Stopped.';
  const m = String(err.message || '').toLowerCase();
  if (err.status === 401) return "That API key didn't work. Check it in Settings.";
  if (m.includes('credit balance') || err.status === 402) return "You're out of API credits for now. Your plan's monthly credits come back with each billing cycle, or you can add credits in the Console.";
  if (err.status === 403) return "Your key isn't allowed to do that: " + err.message;
  if (err.status === 404) return 'Not found. That model may not be available to your account. (' + err.message + ')';
  if (err.status === 429) return 'Rate limit hit, even after waiting' + (err.retryAfter ? '. Try again in about ' + err.retryAfter + ' seconds.' : '. Wait a minute and try again.');
  if (err.status === 413) return 'That request is too big. Try smaller or fewer attachments.';
  if (err.status === 529 || err.type === 'overloaded_error') return "Anthropic's servers are overloaded right now (tried a few times). Try again in a minute.";
  if (err.status >= 500) return "Anthropic's API had a problem (tried a few times). Try again in a minute.";
  if (err.status === 0 || err.type === 'network' || err instanceof TypeError || /load failed|failed to fetch|network/.test(m)) return 'Lost the connection to Anthropic and couldn\'t get it back. Check your internet, then try again.';
  return err.message || 'Something went wrong.';
}
function apiMessages(chat) {
  return chat.messages.filter((m) => !(m.meta && m.meta.skip)).map((m) => ({ role: m.role, content: m.content }));
}
function buildBody(chat) {
  const s = state.settings;
  const c = state.compat[chat.model] || {};
  let max = clampInt(s.maxTokens, 1024, 128000, DEFAULT_SETTINGS.maxTokens);
  if (c.maxOut) max = Math.min(max, c.maxOut);
  const body = { model: chat.model, max_tokens: max, stream: true, messages: apiMessages(chat) };
  if (chat.system) body.system = chat.system;
  if (chat.tools && chat.tools.length) body.tools = chat.tools;
  const wantDisplay = s.showThinking && !c.noDisplay;
  if (!c.noThinking && (wantDisplay || chat.dropBlocks)) {
    const th = { type: 'adaptive' };
    if (wantDisplay) th.display = 'summarized';
    if (chat.dropBlocks) th.block_binding = { prefix_mismatch_behavior: 'drop_block' };
    body.thinking = th;
  }
  if (s.effort && !c.noEffort) body.output_config = { effort: s.effort };
  if (!c.noCache) body.cache_control = { type: 'ephemeral' };
  return body;
}

// When the API rejects a setting this model doesn't take, turn it off and try again.
function adapt(err, chat) {
  if (!(err instanceof ApiError) || err.status !== 400) return false;
  const msg = String(err.message || '').toLowerCase();
  const c = state.compat[chat.model] = state.compat[chat.model] || {};
  let changed = false;
  if (msg.includes('bound to a different conversation')) {
    if (!chat.dropBlocks) { chat.dropBlocks = true; changed = true; }
  } else if (/web.?search/.test(msg) && chat.tools.some((t) => t.name === 'web_search')) {
    chat.tools = chat.tools.filter((t) => t.name !== 'web_search');
    chat.web = false;
    if (chat.messages.some((m) => m.role === 'assistant')) chat.dropBlocks = true;
    toast("Web search isn't available on this API account, so this chat continues without it.");
    changed = true;
  } else if (msg.includes('max_tokens') && !msg.includes('thinking')) {
    const nums = (msg.match(/\d{3,6}/g) || []).map(Number).filter((n) => n >= 1024 && n < (c.maxOut || 1e9));
    if (nums.length) { c.maxOut = Math.min.apply(null, nums); changed = true; }
  } else if (msg.includes('display') && !c.noDisplay && state.settings.showThinking) {
    c.noDisplay = true; changed = true;
  } else if ((msg.includes('output_config') || msg.includes('effort')) && !c.noEffort && state.settings.effort) {
    c.noEffort = true; changed = true;
  } else if (msg.includes('cache_control') && !c.noCache) {
    c.noCache = true; changed = true;
  } else if ((msg.includes('thinking') || msg.includes('adaptive')) && !msg.includes('signature') && !c.noThinking) {
    c.noThinking = true; changed = true;
  }
  if (changed) { c.at = Date.now(); lsSet(K.compat, state.compat); }
  return changed;
}

async function readSSE(resp, onUpdate, att) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  const msg = { role: 'assistant', content: [], usage: {}, stop_reason: null, model: '' };
  if (att) att.partial = msg;
  const json = {};
  let buf = '';
  let ended = false;
  const handle = (raw) => {
    let data = '';
    for (const line of raw.split('\n')) if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
    if (!data) return;
    let ev;
    try { ev = JSON.parse(data); } catch (e) { return; }
    switch (ev.type) {
      case 'message_start': {
        const m = ev.message || {};
        msg.id = m.id; msg.model = m.model || '';
        msg.usage = Object.assign({}, m.usage || {});
        break;
      }
      case 'content_block_start': {
        const b = clone(ev.content_block || {});
        msg.content[ev.index] = b;
        if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') json[ev.index] = '';
        break;
      }
      case 'content_block_delta': {
        const b = msg.content[ev.index];
        const d = ev.delta || {};
        if (!b) break;
        if (d.type === 'text_delta') b.text = (b.text || '') + d.text;
        else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
        else if (d.type === 'signature_delta') b.signature = d.signature;
        else if (d.type === 'input_json_delta') json[ev.index] = (json[ev.index] || '') + (d.partial_json || '');
        else if (d.type === 'citations_delta') { if (!Array.isArray(b.citations)) b.citations = []; b.citations.push(d.citation); }
        break;
      }
      case 'content_block_stop': {
        const b = msg.content[ev.index];
        if (b && Object.prototype.hasOwnProperty.call(json, ev.index)) {
          const s = json[ev.index];
          if (s) { try { b.input = JSON.parse(s); } catch (e) { b.input = {}; } }
          else if (b.input == null) b.input = {};
          delete json[ev.index];
        }
        break;
      }
      case 'message_delta': {
        const d = ev.delta || {};
        if ('stop_reason' in d) msg.stop_reason = d.stop_reason;
        if ('stop_sequence' in d) msg.stop_sequence = d.stop_sequence;
        if (d.stop_details) msg.stop_details = d.stop_details;
        if (ev.usage) Object.assign(msg.usage, ev.usage);
        break;
      }
      case 'message_stop': ended = true; break;
      case 'error': {
        const e = ev.error || {};
        throw new ApiError(e.type === 'overloaded_error' ? 529 : 500, e.type || 'api_error', e.message || 'The stream stopped with an error.');
      }
      default: break;
    }
    onUpdate(msg);
  };
  for (;;) {
    const r = await reader.read();
    if (att) att.lastByteAt = Date.now();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    buf = buf.replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 2); handle(raw); }
  }
  if (buf.trim()) handle(buf);
  msg.content = msg.content.filter(Boolean);
  // A real reply always ends with a stop reason. Without one, the line was cut partway.
  if (!ended && !msg.stop_reason) throw new ApiError(0, 'network', 'The reply was cut off.');
  return msg;
}

function abortError(partial) {
  let e;
  try { e = new DOMException('Stopped', 'AbortError'); } catch (x) { e = new Error('Stopped'); e.name = 'AbortError'; }
  if (partial) e.partial = partial;
  return e;
}

// Waits ms, or rejects if Stop is tapped. With untilVisible, the clock starts once the app is on screen.
function pause(ms, signal, untilVisible) {
  return new Promise((resolve, reject) => {
    let t = null;
    const cleanup = () => { clearTimeout(t); document.removeEventListener('visibilitychange', onVis); signal.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); reject(abortError()); };
    const start = () => { t = setTimeout(() => { cleanup(); resolve(); }, ms); };
    const onVis = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', onVis); start(); } };
    if (signal.aborted) { reject(abortError()); return; }
    signal.addEventListener('abort', onAbort);
    if (untilVisible && document.visibilityState !== 'visible') document.addEventListener('visibilitychange', onVis);
    else start();
  });
}

// One request. Each gets its own off-switch so the watchdog can cut a dead line without ending the
// whole reply; the Stop button still ends everything through `signal`.
async function streamOnce(chat, signal, onUpdate) {
  if (signal.aborted) throw abortError();
  const ac = new AbortController();
  const a = { ac, lastByteAt: Date.now(), suspectSince: 0, stalled: false, away: document.visibilityState !== 'visible', partial: null };
  const relay = () => ac.abort();
  signal.addEventListener('abort', relay);
  watch.attempt = a;
  // Anything that isn't a clean API error means the line was cut: the phone froze the page, the
  // network blinked, or the watchdog gave up on a reply that went quiet.
  const cut = (e) => {
    if (signal.aborted) return abortError(a.partial);
    if (e instanceof ApiError) { e.away = e.away || a.away; if (a.partial) e.partial = a.partial; return e; }
    const x = new ApiError(0, 'network', a.stalled ? 'The reply went quiet.' : String((e && e.message) || 'Network error'));
    x.away = a.away; x.partial = a.partial;
    return x;
  };
  try {
    let resp;
    try {
      resp = await fetch(apiBase() + '/v1/messages', {
        method: 'POST',
        headers: apiHeaders(chat.dropBlocks ? [DROP_BETA] : []),
        body: JSON.stringify(buildBody(chat)),
        signal: ac.signal,
      });
    } catch (e) { throw cut(e); }
    a.lastByteAt = Date.now();
    if (!resp.ok) throw await readError(resp);
    try { return await readSSE(resp, onUpdate, a); } catch (e) { throw cut(e); }
  } finally {
    signal.removeEventListener('abort', relay);
    if (watch.attempt === a) watch.attempt = null;
  }
}

// 'drop' = the line was cut. 'busy' = Anthropic asked us to back off. Anything else gets shown.
function failKind(e) {
  if (!(e instanceof ApiError)) return 'other';
  if (e.status === 0 || e.type === 'network') return 'drop';
  if (e.status === 429 || e.status >= 500 || e.type === 'overloaded_error' || e.type === 'api_error') return 'busy';
  return 'other';
}
function busyWait(e, n) {
  const ra = parseFloat(e.retryAfter);
  if (ra > 0) return Math.min(ra, 30) * 1000;
  return [1500, 4000, 9000][Math.min(n, 3) - 1];
}

// A cut or failed request still used tokens (Anthropic bills what it generated before the line went).
// Count it so the spend meter doesn't run low. Output is estimated from what arrived.
function chargeFailed(chat, e) {
  const m = e && e.partial;
  const u0 = m && m.usage;
  if (!u0 || !(u0.input_tokens || u0.cache_read_input_tokens || u0.cache_creation_input_tokens)) return;
  const u = Object.assign({}, u0);
  let chars = 0;
  for (const b of m.content || []) if (b) chars += (b.text || '').length + (b.thinking || '').length;
  u.output_tokens = Math.max(u.output_tokens || 0, Math.round(chars / 4));
  addSpend(chat, costOf(chat.model, u));
  e.partial = null;
}

async function requestTurn(chat, signal, onUpdate, onStatus) {
  let adapts = 0, busy = 0, drops = 0, awayDrops = 0;
  for (;;) {
    try {
      return await streamOnce(chat, signal, onUpdate);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (signal.aborted) throw abortError(e.partial);
      if (adapts < 5 && adapt(e, chat)) { adapts++; onUpdate(null); continue; }
      const kind = failKind(e);
      // Drops from the phone going to sleep don't count against the limit the same way.
      if (kind === 'drop' && (e.away ? ++awayDrops <= 10 : ++drops <= 3)) {
        chargeFailed(chat, e);
        onUpdate(null);
        onStatus(e.away ? 'Reconnecting...' : 'Connection dropped. Reconnecting...');
        await pause((e.away ? 500 : [700, 2000, 5000][drops - 1]) * SCALE, signal, true);
        continue;
      }
      if (kind === 'busy' && ++busy <= 3) {
        chargeFailed(chat, e);
        onUpdate(null);
        const ms = busyWait(e, busy);
        const why = e.status === 429 ? 'Rate limited.' : (e.status === 529 || e.type === 'overloaded_error') ? "Anthropic's servers are busy." : 'The API hiccuped.';
        onStatus(why + ' Trying again in ' + Math.max(1, Math.round(ms / 1000)) + 's...');
        await pause(ms * SCALE, signal, false);
        continue;
      }
      throw e;
    }
  }
}

async function fetchModels() {
  const resp = await fetch(apiBase() + '/v1/models?limit=100', { headers: apiHeaders([]) });
  if (!resp.ok) throw await readError(resp);
  const j = await resp.json();
  return (j.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
}

// ---------- the conversation loop ----------
async function runAssistant(chat, startIdx) {
  const controller = new AbortController();
  state.controller = controller;
  state.runningChatId = chat.id;
  if (startIdx == null) startIdx = chat.messages.length;
  // Saved with the chat: if the page dies mid-reply, the next launch knows to pick it back up.
  chat.pending = { since: Date.now() };
  watch.longKilled = false;
  setBusy(true);
  keepAwake(true);
  const onStatus = (t) => { if (state.live) { state.live.status = t; scheduleLive(); } };
  try {
    await saveChat(chat);
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      state.live = { chatId: chat.id, content: [], status: '' };
      renderMessages(true);
      const msg = await requestTurn(chat, controller.signal, (m) => {
        if (!state.live) return;
        state.live.content = m ? m.content : [];
        if (m) state.live.status = '';
        scheduleLive();
      }, onStatus);
      state.live = null;
      const cost = costOf(chat.model, msg.usage);
      const meta = { model: chat.model, usage: msg.usage, cost, stop: msg.stop_reason, ts: Date.now() };
      if (msg.stop_reason === 'refusal') meta.refusal = true;
      chat.messages.push({ role: 'assistant', content: msg.content, meta });
      addSpend(chat, cost);
      if (msg.stop_reason === 'tool_use') {
        const results = msg.content.filter((b) => b.type === 'tool_use').map((b) => {
          if (b.name === 'read_memory') return { type: 'tool_result', tool_use_id: b.id, content: runReadMemory(b.input) };
          return { type: 'tool_result', tool_use_id: b.id, content: 'That tool is not available here.', is_error: true };
        });
        if (!results.length) break;
        chat.messages.push({ role: 'user', content: results, meta: { tool: true, ts: Date.now() } });
        await saveChat(chat);
        continue;
      }
      if (msg.stop_reason === 'pause_turn') { await saveChat(chat); continue; }
      break;
    }
  } catch (e) {
    chargeFailed(chat, e);
    const partial = state.live && state.live.content ? state.live.content.filter(Boolean) : [];
    state.live = null;
    // Keep what streamed so it can be read, but leave this attempt out of what gets sent next.
    for (let i = startIdx; i < chat.messages.length; i++) chat.messages[i].meta = Object.assign({}, chat.messages[i].meta, { skip: true });
    chat.messages.push({ role: 'assistant', content: clone(partial), meta: { skip: true, error: friendly(e), stopped: e.name === 'AbortError', ts: Date.now(), model: chat.model } });
  } finally {
    chat.pending = null;
    state.live = null;
    state.controller = null;
    state.runningChatId = null;
    keepAwake(false);
    chat.updated = Date.now();
    await saveChat(chat);
    setBusy(false);
    renderAll();
  }
}

// Screen wake lock while a reply streams, so setting the phone down doesn't lock it mid-reply.
async function keepAwake(on) {
  if (!on) {
    const w = watch.wake; watch.wake = null;
    if (w) { try { await w.release(); } catch (e) { /* already released */ } }
    return;
  }
  if (watch.wake || watch.waking || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  watch.waking = true;
  try {
    const w = await navigator.wakeLock.request('screen');
    if (!state.controller) { w.release(); return; } // the reply finished while we were asking
    watch.wake = w;
    w.addEventListener('release', () => { if (watch.wake === w) watch.wake = null; });
  } catch (e) { /* not supported or not allowed here; harmless */ }
  finally { watch.waking = false; }
}

// The watchdog. When the timer hasn't run for a while, the page was frozen; if no data came in
// meanwhile, the line is almost certainly dead, so cut it and reconnect. Also catches a reply that
// has gone completely silent for minutes.
setInterval(() => {
  const now = Date.now();
  const gap = now - watch.lastTick;
  watch.lastTick = now;
  const a = watch.attempt;
  if (!a || a.stalled) return;
  if (gap > 6000 * SCALE) {
    a.away = true;
    if (a.lastByteAt < now - gap + TICK && !a.suspectSince) a.suspectSince = now;
  }
  if (a.suspectSince && a.lastByteAt > a.suspectSince) a.suspectSince = 0;
  if (document.visibilityState !== 'visible') return;
  const deadAfterFreeze = a.suspectSince && now - a.suspectSince > 10000 * SCALE;
  const silentTooLong = !watch.longKilled && now - a.lastByteAt > 180000 * SCALE;
  if (deadAfterFreeze || silentTooLong) {
    if (!deadAfterFreeze) watch.longKilled = true;
    a.stalled = true;
    a.ac.abort();
  }
}, TICK);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { if (watch.attempt) watch.attempt.away = true; return; }
  if (state.controller) keepAwake(true);
});

// A reply that was still coming in when the page died (iPhone sometimes closes a home-screen app
// in the background). Returns the index of that turn's question, or -1.
function cutTurnIdx(chat) {
  if (!chat || !chat.pending || state.runningChatId === chat.id) return -1;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.role === 'user' && !(m.meta && m.meta.tool)) return i;
  }
  return -1;
}
// Pick a cut-off reply back up if it's recent; if it's older, the chat shows Try again instead.
async function resumeIfCut(chat) {
  const u = cutTurnIdx(chat);
  if (u < 0 || state.controller || !state.apiKey) return;
  const last = chat.messages[chat.messages.length - 1];
  if (last.role === 'assistant' && !(last.meta && last.meta.stop === 'pause_turn')) {
    chat.pending = null; await saveChat(chat); renderAll(); return; // it had actually finished
  }
  if (Date.now() - (chat.pending.since || 0) > 15 * 60 * 1000) return;
  toast('Picking up the reply that got cut off...');
  await runAssistant(chat, u + 1);
}

async function onSend(textOverride) {
  if (state.controller) return;
  const input = $('input');
  const text = (textOverride != null ? textOverride : input.value).trim();
  const files = state.files.slice();
  if (!text && !files.length) return;
  if (!state.apiKey) { openSettings(); toast('Add your API key first.'); return; }
  let chat = state.chat;
  if (!chat) {
    chat = newChatObj();
    state.chat = chat;
    state.chats.unshift(chat);
  }
  lsSet(K.last, chat.id);
  const content = files.map((f) => f.block);
  if (text) content.push({ type: 'text', text });
  chat.messages.push({ role: 'user', content, meta: { ts: Date.now() } });
  if (chat.title === 'New chat') chat.title = makeTitle(text || (files[0] && files[0].name) || 'Chat');
  chat.updated = Date.now();
  if (textOverride == null) { input.value = ''; autoGrow(); }
  state.files = [];
  renderAttachments();
  await saveChat(chat);
  renderAll();
  await runAssistant(chat);
}

function makeTitle(t) {
  const line = String(t).split('\n')[0].trim();
  return line.length > 52 ? line.slice(0, 50).trim() + '...' : line;
}

function stopStreaming() { if (state.controller) state.controller.abort(); }

async function retryTurn(userIdx) {
  const chat = state.chat;
  if (!chat || state.controller) return;
  chat.messages = chat.messages.slice(0, userIdx + 1);
  await saveChat(chat);
  renderAll();
  await runAssistant(chat);
}

// ---------- attachments ----------
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|html?|xml|js|mjs|ts|tsx|jsx|py|rb|css|scss|ya?ml|toml|ini|log|fountain|srt|vtt|tex|sh|sql)$/i;
async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
async function prepImage(file) {
  const MAX = 1568;
  const okType = /^image\/(jpeg|png|gif|webp)$/.test(file.type);
  let src = null;
  try { src = await createImageBitmap(file); } catch (e) { src = null; }
  if (!src) {
    src = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read " + file.name + ' as an image.')); };
      img.src = url;
    });
  }
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  const scale = Math.min(1, MAX / Math.max(w, h));
  if (okType && scale === 1 && file.size <= 3.5 * 1024 * 1024) return { media: file.type, data: await toBase64(file) };
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  const png = file.type === 'image/png';
  if (!png) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch); }
  ctx.drawImage(src, 0, 0, cw, ch);
  const media = png ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((r) => canvas.toBlob(r, media, 0.88));
  if (!blob) throw new Error("Couldn't process " + file.name + '.');
  return { media, data: await toBase64(blob) };
}
async function fileToAttachment(file) {
  const name = file.name || 'file';
  const type = file.type || '';
  if (type.indexOf('image/') === 0 || /\.(heic|heif|jpe?g|png|gif|webp)$/i.test(name)) {
    const img = await prepImage(file);
    return { id: uid(), name, kind: 'image', block: { type: 'image', source: { type: 'base64', media_type: img.media, data: img.data } }, preview: 'data:' + img.media + ';base64,' + img.data };
  }
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) {
    if (file.size > 30 * 1024 * 1024) throw new Error(name + ' is over 30 MB, too big to send.');
    return { id: uid(), name, kind: 'pdf', block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await toBase64(file) }, title: name } };
  }
  if (type.indexOf('text/') === 0 || type === 'application/json' || TEXT_EXT.test(name)) {
    if (file.size > 2 * 1024 * 1024) throw new Error(name + ' is over 2 MB of text. Try a smaller file.');
    const text = await file.text();
    return { id: uid(), name, kind: 'text', block: { type: 'text', text: '<file name="' + name.replace(/"/g, "'") + '">\n' + text + '\n</file>' } };
  }
  throw new Error(name + ": only images, PDFs and text files can be attached. Export Word or Pages files as PDF first.");
}
async function addFiles(list) {
  for (const f of Array.from(list || [])) {
    try { state.files.push(await fileToAttachment(f)); }
    catch (e) { toast(e.message); }
  }
  renderAttachments();
}
function renderAttachments() {
  const box = $('attachments');
  box.textContent = '';
  for (const a of state.files) {
    const d = el('div', 'att');
    if (a.preview) { const img = el('img'); img.src = a.preview; img.alt = ''; d.appendChild(img); }
    d.appendChild(el('span', null, (a.kind === 'pdf' ? 'PDF: ' : a.kind === 'text' ? 'File: ' : '') + a.name));
    const x = el('button', null, '×'); x.type = 'button'; x.setAttribute('aria-label', 'Remove ' + a.name);
    x.onclick = () => { state.files = state.files.filter((f) => f.id !== a.id); renderAttachments(); };
    d.appendChild(x);
    box.appendChild(d);
  }
}

// ---------- markdown (escapes everything first; no raw HTML ever passes through) ----------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ESC[c]); }
function safeUrl(u) { return /^(https?:\/\/|mailto:)/i.test(u) ? u : null; }
function inline(src, noLinks) {
  const slots = [];
  const put = (html) => '\u0001' + (slots.push(html) - 1) + '\u0002';
  let s = String(src);
  s = s.replace(/`([^`\n]+)`/g, (m, c) => put('<code>' + esc(c) + '</code>'));
  if (!noLinks) {
    s = s.replace(/\[([^\]\n]+)\]\(\s*<?([^\s)>]+)>?\s*\)/g, (m, t, u) => {
      const url = safeUrl(u);
      return url ? put('<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + inline(t, true) + '</a>') : m;
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g, (m, pre, u) => pre + put('<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + '</a>'));
  }
  s = esc(s);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^*\w])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![*\w])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_([^\s_](?:[^_\n]*?[^\s_])?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  s = s.replace(/\u0001(\d+)\u0002/g, (m, i) => slots[+i]);
  return s;
}
function splitRow(l) {
  let s = l.trim();
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}
function parseTable(lines, start) {
  const head = splitRow(lines[start]);
  const al = splitRow(lines[start + 1]).map((a) => (/^:-+:$/.test(a) ? 'c' : /-+:$/.test(a) ? 'r' : ''));
  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) { rows.push(splitRow(lines[i])); i++; }
  const cls = (j) => (al[j] ? ' class="al-' + al[j] + '"' : '');
  let html = '<div class="table-wrap"><table><thead><tr>' + head.map((c, j) => '<th' + cls(j) + '>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>';
  for (const r of rows) html += '<tr>' + head.map((_, j) => '<td' + cls(j) + '>' + inline(r[j] || '') + '</td>').join('') + '</tr>';
  return { html: html + '</tbody></table></div>', next: i };
}
function parseList(lines, start) {
  const itemRe = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    const m = l.match(itemRe);
    if (m) { items.push({ ind: m[1].replace(/\t/g, '    ').length, ord: /\d/.test(m[2]), num: parseInt(m[2], 10) || 1, text: [m[3]] }); i++; continue; }
    if (!l.trim()) {
      const n = lines[i + 1];
      if (n != null && (itemRe.test(n) || /^\s{2,}\S/.test(n))) { i++; continue; }
      break;
    }
    if (items.length && (/^\s{2,}\S/.test(l) || !/^\s{0,3}(#{1,6}\s|>|`{3}|~{3})/.test(l))) { items[items.length - 1].text.push(l.trim()); i++; continue; }
    break;
  }
  let html = '';
  const stack = [];
  const open = (it) => { const tag = it.ord ? 'ol' : 'ul'; stack.push({ ind: it.ind, tag }); return '<' + tag + (it.ord && it.num !== 1 ? ' start="' + it.num + '"' : '') + '>'; };
  for (const it of items) {
    const body = it.text.map((t) => inline(t)).join('<br>');
    if (!stack.length) { html += open(it) + '<li>' + body; continue; }
    let top = stack[stack.length - 1];
    if (it.ind > top.ind + 1) { html += open(it) + '<li>' + body; continue; }
    while (stack.length > 1 && it.ind < top.ind - 1) { html += '</li></' + stack.pop().tag + '>'; top = stack[stack.length - 1]; }
    html += '</li><li>' + body;
  }
  while (stack.length) html += '</li></' + stack.pop().tag + '>';
  return { html, next: i };
}
function md(src, forCopy) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push('<p>' + para.map((l) => inline(l)).join('<br>') + '</p>'); para = []; } };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)/);
    if (m) {
      flush();
      const fence = m[1], lang = m[2], buf = [];
      i++;
      while (i < lines.length && lines[i].trim().indexOf(fence) !== 0) { buf.push(lines[i]); i++; }
      i++;
      const head = forCopy ? '' : '<div class="code-head"><span>' + esc(lang || 'code') + '</span><button type="button" class="copy-code">Copy</button></div>';
      out.push('<pre class="code">' + head + '<code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) { flush(); const lv = Math.min(6, m[1].length + 2); out.push('<h' + lv + '>' + inline(m[2]) + '</h' + lv + '>'); i++; continue; }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) { buf.push(lines[i].replace(/^\s{0,3}>\s?/, '')); i++; }
      out.push('<blockquote>' + md(buf.join('\n'), forCopy) + '</blockquote>');
      continue;
    }
    if (line.indexOf('|') >= 0 && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) { flush(); const r = parseTable(lines, i); out.push(r.html); i = r.next; continue; }
    if (/^\s*([-*+]|\d{1,3}[.)])\s+/.test(line)) { flush(); const r = parseList(lines, i); out.push(r.html); i = r.next; continue; }
    para.push(line);
    i++;
  }
  flush();
  return out.join('');
}
function mdToPlain(s) {
  return String(s || '')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
    .replace(/(^|[^\w])__([\s\S]+?)__(?!\w)/g, '$1$2')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1$2')
    .replace(/~~([\s\S]+?)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\((\S+?)\)/g, '$1 ($2)')
    .replace(/^\s{0,3}>\s?/gm, '');
}
function copyRich(markdown) {
  const plain = mdToPlain(markdown);
  const html = md(markdown, true);
  try {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      return navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      })]).then(() => true, () => copyPlain(plain));
    }
  } catch (e) { /* fall through */ }
  return copyPlain(plain);
}
function copyPlain(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
  } catch (e) { /* fall through */ }
  return Promise.resolve(legacyCopy(text));
}
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

// ---------- rendering ----------
function chip(label, text) {
  const c = el('span', 'chip');
  c.appendChild(el('b', null, label));
  if (text) c.appendChild(el('span', null, text));
  return c;
}
function typingDots() { const t = el('span', 'typing'); t.append(el('i'), el('i'), el('i')); return t; }

// Renders one assistant message's blocks into a container and collects sources.
function renderBlocks(container, blocks, live, sources) {
  const list = (blocks || []).filter(Boolean);
  list.forEach((b, idx) => {
    const lastLive = live && idx === list.length - 1;
    switch (b.type) {
      case 'thinking': {
        if (!b.thinking) break;
        const d = el('details', 'thinking');
        d.appendChild(el('summary', null, lastLive ? 'Thinking...' : 'Thinking'));
        const body = el('div', 'md');
        body.innerHTML = md(b.thinking);
        d.appendChild(body);
        container.appendChild(d);
        break;
      }
      case 'text': {
        const d = el('div', 'md');
        d.innerHTML = md(b.text || '');
        container.appendChild(d);
        if (Array.isArray(b.citations)) for (const c of b.citations) if (c && c.url) sources.push({ url: c.url, title: c.title || c.url });
        break;
      }
      case 'tool_use': {
        if (b.name === 'read_memory') {
          const ps = (b.input && Array.isArray(b.input.paths)) ? b.input.paths : [];
          container.appendChild(chip('Read memory', ps.map((p) => String(p).split('/').pop().replace(/\.md$/, '')).join(', ') || '...'));
        } else container.appendChild(chip('Tool', b.name || ''));
        break;
      }
      case 'server_tool_use': {
        if (b.name === 'web_search') container.appendChild(chip('Searched', b.input && b.input.query ? '"' + b.input.query + '"' : '...'));
        else container.appendChild(chip(b.name || 'Tool', ''));
        break;
      }
      case 'web_search_tool_result': {
        const c = b.content;
        if (c && !Array.isArray(c) && c.type === 'web_search_tool_result_error') container.appendChild(chip('Search failed', c.error_code || ''));
        break;
      }
      default: break;
    }
  });
}

function renderSources(container, sources) {
  const seen = new Set();
  const uniq = sources.filter((s) => { if (seen.has(s.url)) return false; seen.add(s.url); return true; });
  if (!uniq.length) return;
  const d = el('details', 'sources');
  d.appendChild(el('summary', null, 'Sources (' + uniq.length + ')'));
  const ol = el('ol');
  for (const s of uniq) {
    const li = el('li');
    const url = safeUrl(s.url);
    if (url) { const a = el('a', null, s.title || url); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; li.appendChild(a); }
    else li.textContent = s.title || s.url;
    ol.appendChild(li);
  }
  d.appendChild(ol);
  container.appendChild(d);
}

function nearBottom(box) { return box.scrollHeight - box.scrollTop - box.clientHeight < 140; }

function renderUser(m) {
  const wrap = el('div', 'msg user');
  const bubble = el('div', 'bubble');
  for (const b of m.content || []) {
    if (b.type === 'image' && b.source && b.source.type === 'base64') {
      const img = el('img', 'thumb'); img.alt = 'Attached image'; img.src = 'data:' + b.source.media_type + ';base64,' + b.source.data;
      bubble.appendChild(img);
    } else if (b.type === 'document') {
      bubble.appendChild(chip('PDF', b.title || 'document'));
    } else if (b.type === 'text') {
      const fm = b.text.match(/^<file name="([^"]*)">/);
      if (fm) bubble.appendChild(chip('File', fm[1]));
      else bubble.appendChild(el('div', 'utext', b.text));
    }
  }
  wrap.appendChild(bubble);
  return wrap;
}

function turnText(turn) {
  const parts = [];
  for (const a of turn.assistant) for (const b of a.content || []) if (b && b.type === 'text' && b.text) parts.push(b.text);
  return parts.join('\n\n');
}

function renderFooter(turn, isLast) {
  const foot = el('div', 'turn-foot');
  const text = turnText(turn);
  const last = turn.assistant[turn.assistant.length - 1];
  if (text) {
    const copy = el('button', 'btn small-btn', 'Copy'); copy.type = 'button';
    copy.onclick = () => { Promise.resolve(copyRich(text)).then((ok) => toast(ok ? 'Copied.' : "Couldn't copy.")); };
    foot.appendChild(copy);
  }
  if (isLast && !state.controller) {
    const retry = el('button', 'btn small-btn', 'Retry'); retry.type = 'button';
    retry.onclick = () => retryTurn(turn.userIdx);
    foot.appendChild(retry);
  }
  let cost = 0, anyCost = false, fresh = 0, cr = 0, cw = 0, out = 0, searches = 0;
  for (const a of turn.assistant) {
    const meta = a.meta || {};
    if (meta.cost != null) { cost += meta.cost; anyCost = true; }
    if (meta.usage) { const p = usageParts(meta.usage); fresh += p.fresh; cr += p.cr; cw += p.cw5 + p.cw1h; out += p.out; searches += p.searches; }
  }
  const model = (last && last.meta && last.meta.model) || '';
  const bits = [];
  if (model) bits.push(modelLabel(model));
  if (anyCost) bits.push(money(cost));
  if (fresh + cr + cw + out) bits.push(tok(fresh + cr + cw) + ' in, ' + tok(out) + ' out');
  const stat = el('span', 'stat', bits.join(' · '));
  stat.title = 'New input ' + tok(fresh) + ', cached ' + tok(cr) + ', cache write ' + tok(cw) + ', output ' + tok(out) + (searches ? ', ' + searches + ' search' + (searches > 1 ? 'es' : '') : '');
  foot.appendChild(stat);
  return foot;
}

function renderMessages(scrollToEnd) {
  const box = $('messages');
  const stick = scrollToEnd || nearBottom(box);
  box.textContent = '';
  const chat = state.chat;
  if (!chat || !chat.messages.length) { box.appendChild(emptyState()); return; }
  const turns = [];
  let turn = null;
  chat.messages.forEach((m, i) => {
    if (m.role === 'user' && !(m.meta && m.meta.tool)) { turn = { user: m, userIdx: i, assistant: [] }; turns.push(turn); }
    else if (turn && m.role === 'assistant') turn.assistant.push(m);
  });
  const liveHere = state.live && state.live.chatId === chat.id;
  const cutIdx = cutTurnIdx(chat);
  turns.forEach((t, ti) => {
    box.appendChild(renderUser(t.user));
    const isLast = ti === turns.length - 1;
    const cutHere = isLast && !liveHere && cutIdx === t.userIdx;
    if (!t.assistant.length && !(isLast && liveHere) && !cutHere) return;
    const wrap = el('div', 'msg assistant');
    const sources = [];
    for (const a of t.assistant) {
      renderBlocks(wrap, a.content, false, sources);
      const meta = a.meta || {};
      if (meta.error) {
        const n = el('div', 'note', meta.stopped ? 'Stopped.' : meta.error);
        if (isLast && !state.controller && !liveHere) { const b = el('button', 'btn small-btn', 'Try again'); b.type = 'button'; b.onclick = () => retryTurn(t.userIdx); n.appendChild(b); }
        wrap.appendChild(n);
      } else if (meta.refusal) {
        wrap.appendChild(el('div', 'note', 'Claude declined this one.'));
      } else if (meta.stop === 'max_tokens' && a === t.assistant[t.assistant.length - 1]) {
        const n = el('div', 'note', 'This reply hit the length limit.');
        if (isLast && !state.controller) { const b = el('button', 'btn small-btn', 'Continue'); b.type = 'button'; b.onclick = () => onSend('Please continue from where you stopped.'); n.appendChild(b); }
        wrap.appendChild(n);
      }
    }
    if (isLast && liveHere) {
      const live = el('div', 'live');
      live.id = 'liveEl';
      fillLive(live);
      wrap.appendChild(live);
    } else {
      if (cutHere) {
        const n = el('div', 'note', 'This reply got cut off when the app closed.');
        if (!state.controller) { const b = el('button', 'btn small-btn', 'Try again'); b.type = 'button'; b.onclick = () => retryTurn(t.userIdx); n.appendChild(b); }
        wrap.appendChild(n);
      }
      renderSources(wrap, sources);
      if (t.assistant.length) wrap.appendChild(renderFooter(t, isLast));
    }
    box.appendChild(wrap);
  });
  if (stick) box.scrollTop = box.scrollHeight;
}

function fillLive(node) {
  node.textContent = '';
  const content = (state.live && state.live.content) || [];
  const sources = [];
  renderBlocks(node, content, true, sources);
  if (state.live && state.live.status) node.appendChild(el('div', 'live-status', state.live.status));
  const visible = content.some((b) => b && ((b.type === 'text' && b.text) || (b.type === 'thinking' && b.thinking)));
  const last = content.filter(Boolean).slice(-1)[0];
  if (!visible || (last && last.type !== 'text')) node.appendChild(typingDots());
}

let liveQueued = false;
function scheduleLive() {
  if (liveQueued) return;
  liveQueued = true;
  requestAnimationFrame(() => {
    liveQueued = false;
    const node = $('liveEl');
    if (!node || !state.live) { renderMessages(); return; }
    const box = $('messages');
    const stick = nearBottom(box);
    fillLive(node);
    if (stick) box.scrollTop = box.scrollHeight;
  });
}

function emptyState() {
  const d = el('div', 'empty');
  d.appendChild(el('h1', null, 'Claude on your API credits'));
  const cur = state.chat ? state.chat.model : state.settings.model;
  d.appendChild(el('p', 'muted', 'Model: ' + modelLabel(cur) + '. Each reply shows what it cost. Switch models at the top anytime.'));
  const ul = el('ul', 'checklist');
  const item = (ok, text) => { const li = el('li', ok ? 'ok' : ''); li.append(el('span', 'dot'), el('span', null, text)); return li; };
  ul.appendChild(item(!!state.apiKey, state.apiKey ? 'API key saved on this device' : 'Add your API key in Settings'));
  if (state.pack) {
    const n = Object.keys(state.pack.files).length;
    ul.appendChild(item(true, 'Memory loaded: ' + state.pack.index.length + ' files indexed, ' + n + ' copied in full' + (state.pack.made ? ' (made ' + state.pack.made + ')' : '')));
  } else ul.appendChild(item(false, 'No memory loaded (Settings, then Memory)'));
  ul.appendChild(item(!!state.settings.webSearch, state.settings.webSearch ? 'Web search on for new chats' : 'Web search off for new chats'));
  d.appendChild(ul);
  if (!state.apiKey || !state.pack) { const b = el('button', 'btn primary', 'Open settings'); b.type = 'button'; b.onclick = () => openSettings(); d.appendChild(b); }
  if (!state.idbOk) d.appendChild(el('p', 'note', "This browser isn't saving chats, so they'll disappear when you close the page."));
  return d;
}

function fillModelSelect(sel, cur, withPrice) {
  sel.textContent = '';
  const all = MODELS.map((m) => ({ id: m.id, label: withPrice ? m.label + ' ($' + m.price.in + ' / $' + m.price.out + ' per M, ' + m.note + ')' : m.label }));
  for (const x of state.extraModels) if (!modelInfo(x.id)) all.push({ id: x.id, label: x.label || x.id });
  if (cur && !all.some((m) => m.id === cur)) all.push({ id: cur, label: cur });
  for (const m of all) { const o = el('option', null, m.label); o.value = m.id; if (m.id === cur) o.selected = true; sel.appendChild(o); }
}
function fillEffortSelect(sel, cur, long) {
  sel.textContent = '';
  for (const e of EFFORTS) { const o = el('option', null, long ? e[2] : e[1]); o.value = e[0]; if (e[0] === (cur || '')) o.selected = true; sel.appendChild(o); }
}

function renderTop() {
  const cur = state.chat ? state.chat.model : state.settings.model;
  fillModelSelect($('modelSelect'), cur, false);
  fillEffortSelect($('effortSelect'), state.settings.effort);
  $('chatTitle').textContent = state.chat ? state.chat.title : 'New chat';
  const sub = [];
  if (state.chat) {
    if (state.chat.cost) sub.push(money(state.chat.cost) + ' so far');
    sub.push(state.chat.memory ? 'memory on' : 'no memory');
    if (state.chat.web) sub.push('web search on');
  } else {
    sub.push(state.pack ? 'memory on' : 'no memory loaded');
    if (state.settings.webSearch) sub.push('web search on');
  }
  $('chatSub').textContent = sub.join(' · ');
}

function renderSidebar() {
  const list = $('chatList');
  list.textContent = '';
  state.chats.sort((a, b) => b.updated - a.updated);
  if (!state.chats.length) { list.appendChild(el('div', 'muted small pad', 'No chats yet.')); }
  for (const c of state.chats) {
    const item = el('div', 'chat-item' + (state.chat && state.chat.id === c.id ? ' active' : ''));
    const open = el('button', 'chat-open'); open.type = 'button';
    open.appendChild(el('span', 'chat-name', c.title || 'Untitled'));
    open.appendChild(el('span', 'chat-meta', shortDate(c.updated) + ' · ' + modelLabel(c.model) + (c.cost ? ' · ' + money(c.cost) : '')));
    open.onclick = () => openChat(c.id);
    const del = el('button', 'chat-del', '×'); del.type = 'button'; del.setAttribute('aria-label', 'Delete chat');
    del.onclick = (ev) => { ev.stopPropagation(); confirmTap(del, '×', 'Delete', () => deleteChat(c.id)); };
    item.append(open, del);
    list.appendChild(item);
  }
  const spent = monthSpend();
  $('spendLine').textContent = 'This month on this device: about ' + (money(spent) || '$0');
}

function renderBanner() {
  const b = $('banner');
  const spent = monthSpend();
  const warn = Number(state.settings.warnAt) || 0;
  if (warn > 0 && spent >= warn) { b.textContent = "You've spent about " + money(spent) + ' this month on this device. (Warning set at $' + warn + ' in Settings.)'; b.hidden = false; }
  else b.hidden = true;
}

function renderAll() { renderSidebar(); renderTop(); renderMessages(); renderBanner(); updateSendState(); }

function setBusy(busy) {
  $('sendBtn').hidden = busy;
  $('stopBtn').hidden = !busy;
  updateSendState();
}
function updateSendState() {
  const has = $('input').value.trim() || state.files.length;
  $('sendBtn').disabled = !has || !!state.controller;
}

function autoGrow() {
  const t = $('input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px';
  updateSendState();
}

function openChat(id) {
  const c = state.chats.find((x) => x.id === id);
  if (!c) return;
  state.chat = c;
  lsSet(K.last, id);
  document.body.classList.remove('side-open');
  $('scrim').hidden = true;
  renderAll();
  const box = $('messages'); box.scrollTop = box.scrollHeight;
  resumeIfCut(c);
}
async function deleteChat(id) {
  if (state.controller && state.chat && state.chat.id === id) stopStreaming();
  state.chats = state.chats.filter((c) => c.id !== id);
  if (state.chat && state.chat.id === id) state.chat = null;
  try { await db.del('chats', id); } catch (e) { /* ignore */ }
  renderAll();
}
function newChat() {
  if (state.controller) return;
  state.chat = null;
  lsSet(K.last, null);
  document.body.classList.remove('side-open');
  $('scrim').hidden = true;
  renderAll();
  $('input').focus();
}

// ---------- settings ----------
function saveSettings() { lsSet(K.settings, state.settings); }
function setKey(v, remember) {
  state.apiKey = v;
  try {
    if (remember) { localStorage.setItem(K.key, v); sessionStorage.removeItem(K.key); }
    else { sessionStorage.setItem(K.key, v); localStorage.removeItem(K.key); }
  } catch (e) { /* storage unavailable: key lasts for this page only */ }
}
function renderSettings() {
  const s = state.settings;
  $('keyInput').value = state.apiKey || '';
  $('keyRemember').checked = rawGet(K.key) != null || !sessGet(K.key);
  fillModelSelect($('defModel'), s.model, true);
  fillEffortSelect($('defEffort'), s.effort, true);
  $('optThinking').checked = !!s.showThinking;
  $('optWeb').checked = !!s.webSearch;
  $('optMax').value = s.maxTokens;
  $('optWarn').value = s.warnAt;
  const p = state.pack;
  $('packStatus').textContent = p
    ? 'Loaded: ' + p.index.length + ' files indexed, ' + Object.keys(p.files).length + ' copied in full' + (p.made ? ', made ' + p.made : '') + '.'
    : 'No memory pack on this device yet. Import the claude-memory-pack.md file Claude made for you.';
  $('packClear').disabled = !p;
  const spent = monthSpend();
  $('spendStatus').textContent = 'This month on this device: about ' + (money(spent) || '$0') + ' across ' + state.chats.length + ' chat' + (state.chats.length === 1 ? '' : 's') + '.';
  $('aboutLine').textContent = 'Claude API Chat v' + APP_VERSION + '. Runs in your browser; nothing is stored on a server.';
}
function openSettings() {
  renderSettings();
  const d = $('settings');
  if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); }
  else d.setAttribute('open', '');
}
function closeSettings() {
  const d = $('settings');
  if (typeof d.close === 'function') d.close(); else d.removeAttribute('open');
  renderAll();
}

function exportChats() {
  const data = JSON.stringify({ app: 'claude-api-chat', exported: new Date().toISOString(), chats: state.chats }, null, 1);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'claude-api-chats-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function bindSettings() {
  $('closeSettings').onclick = closeSettings;
  $('settings').addEventListener('close', () => renderAll());
  $('keyShow').onclick = () => { const i = $('keyInput'); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; $('keyShow').textContent = show ? 'Hide' : 'Show'; };
  $('keySave').onclick = () => {
    const v = $('keyInput').value.trim();
    if (!v) { $('keyStatus').textContent = 'Paste a key first.'; return; }
    setKey(v, $('keyRemember').checked);
    $('keyStatus').textContent = 'Saved.';
    renderAll();
  };
  $('keyTest').onclick = async () => {
    const v = $('keyInput').value.trim();
    if (v && v !== state.apiKey) setKey(v, $('keyRemember').checked);
    if (!state.apiKey) { $('keyStatus').textContent = 'Paste a key first.'; return; }
    $('keyStatus').textContent = 'Checking...';
    try {
      const list = await fetchModels();
      const hasFable = list.some((m) => m.id === 'claude-fable-5-2');
      $('keyStatus').textContent = 'Key works. ' + list.length + ' models available' + (hasFable ? ', including Fable 5.2.' : '.');
    } catch (e) { $('keyStatus').textContent = friendly(e); }
  };
  $('packImport').onclick = () => $('packFile').click();
  $('packFile').onchange = async () => {
    const f = $('packFile').files && $('packFile').files[0];
    $('packFile').value = '';
    if (!f) return;
    try { await setPack(await f.text(), true); toast('Memory loaded.'); }
    catch (e) { toast(e.message); }
  };
  $('packPasteToggle').onclick = () => { $('packPasteWrap').hidden = !$('packPasteWrap').hidden; };
  $('packPasteLoad').onclick = async () => {
    try { await setPack($('packPaste').value, true); $('packPaste').value = ''; $('packPasteWrap').hidden = true; toast('Memory loaded.'); }
    catch (e) { toast(e.message); }
  };
  $('packClear').onclick = () => confirmTap($('packClear'), 'Remove', 'Tap again to remove', async () => {
    state.pack = null;
    try { await db.del('kv', 'pack'); } catch (e) { /* ignore */ }
    renderSettings(); renderAll();
  });
  $('defModel').onchange = () => { state.settings.model = $('defModel').value; saveSettings(); renderAll(); };
  $('defEffort').onchange = () => { state.settings.effort = $('defEffort').value; saveSettings(); renderAll(); };
  $('optThinking').onchange = () => { state.settings.showThinking = $('optThinking').checked; saveSettings(); };
  $('optWeb').onchange = () => { state.settings.webSearch = $('optWeb').checked; saveSettings(); renderAll(); };
  $('optMax').onchange = () => { state.settings.maxTokens = clampInt($('optMax').value, 1024, 128000, DEFAULT_SETTINGS.maxTokens); $('optMax').value = state.settings.maxTokens; saveSettings(); };
  $('optWarn').onchange = () => { const v = parseFloat($('optWarn').value); state.settings.warnAt = isNaN(v) ? 0 : Math.max(0, v); saveSettings(); renderBanner(); };
  $('loadModels').onclick = async () => {
    if (!state.apiKey) { $('modelsStatus').textContent = 'Save your key first.'; return; }
    $('modelsStatus').textContent = 'Loading...';
    try {
      const list = await fetchModels();
      state.extraModels = list.filter((m) => !modelInfo(m.id));
      lsSet(K.models, state.extraModels);
      $('modelsStatus').textContent = 'Added ' + state.extraModels.length + ' more.';
      renderSettings(); renderTop();
    } catch (e) { $('modelsStatus').textContent = friendly(e); }
  };
  $('addModel').onclick = () => {
    const id = $('customModel').value.trim();
    if (!id) return;
    if (!modelInfo(id) && !state.extraModels.some((m) => m.id === id)) { state.extraModels.push({ id, label: id }); lsSet(K.models, state.extraModels); }
    $('customModel').value = '';
    state.settings.model = id; saveSettings();
    renderSettings(); renderTop();
  };
  $('exportChats').onclick = exportChats;
  $('deleteAll').onclick = () => confirmTap($('deleteAll'), 'Delete all chats', 'Tap again to delete everything', async () => {
    if (state.controller) stopStreaming();
    state.chats = []; state.chat = null;
    try { await db.clear('chats'); } catch (e) { /* ignore */ }
    renderSettings(); renderAll();
  });
}

// ---------- wiring ----------
function bindUI() {
  $('newChat').onclick = newChat;
  $('openSettings').onclick = () => { document.body.classList.remove('side-open'); $('scrim').hidden = true; openSettings(); };
  $('toggleSide').onclick = () => { const open = !document.body.classList.contains('side-open'); document.body.classList.toggle('side-open', open); $('scrim').hidden = !open; };
  $('scrim').onclick = () => { document.body.classList.remove('side-open'); $('scrim').hidden = true; };
  $('modelSelect').onchange = () => {
    const v = $('modelSelect').value;
    state.settings.model = v; saveSettings();
    if (state.chat) { state.chat.model = v; saveChat(state.chat); }
    renderAll();
  };
  $('effortSelect').onchange = () => { state.settings.effort = $('effortSelect').value; saveSettings(); };
  const input = $('input');
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (!isTouch() || e.metaKey || e.ctrlKey)) { e.preventDefault(); onSend(); }
  });
  input.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); addFiles(files); }
  });
  $('sendBtn').onclick = () => onSend();
  $('stopBtn').onclick = stopStreaming;
  $('attachBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = async () => { const f = $('fileInput').files; await addFiles(f); $('fileInput').value = ''; updateSendState(); };
  const main = $('main');
  main.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0) { e.preventDefault(); document.body.classList.add('dragging'); } });
  main.addEventListener('dragleave', (e) => { if (e.target === main || !main.contains(e.relatedTarget)) document.body.classList.remove('dragging'); });
  main.addEventListener('drop', (e) => { document.body.classList.remove('dragging'); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files).then(updateSendState); } });
  $('messages').addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.copy-code');
    if (!btn) return;
    const code = btn.closest('pre').querySelector('code');
    Promise.resolve(copyPlain(code ? code.textContent : '')).then((ok) => toast(ok ? 'Copied.' : "Couldn't copy."));
  });
  bindSettings();
}

async function init() {
  state.settings = Object.assign({}, DEFAULT_SETTINGS, lsGet(K.settings, {}));
  state.apiKey = rawGet(K.key) || sessGet(K.key) || '';
  state.compat = lsGet(K.compat, {});
  const week = 7 * 24 * 3600 * 1000;
  for (const id of Object.keys(state.compat)) if (!state.compat[id].at || Date.now() - state.compat[id].at > week) delete state.compat[id];
  lsSet(K.compat, state.compat);
  state.extraModels = lsGet(K.models, []);
  bindUI();
  try {
    state.chats = (await db.all('chats')) || [];
    const p = await db.get('kv', 'pack');
    if (p && p.text) { try { state.pack = parsePack(p.text); } catch (e) { state.pack = null; } }
  } catch (e) {
    state.idbOk = false;
  }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
  // Reopen the chat you were in if it's recent, or if its reply got cut off when the app closed.
  const lastId = lsGet(K.last, null);
  const last = lastId ? state.chats.find((c) => c.id === lastId) : null;
  if (last && (last.pending || Date.now() - (last.updated || 0) < 30 * 60 * 1000)) state.chat = last;
  renderAll();
  if (!state.apiKey) openSettings();
  else if (state.chat) { const box = $('messages'); box.scrollTop = box.scrollHeight; resumeIfCut(state.chat); }
}

init();
})();
