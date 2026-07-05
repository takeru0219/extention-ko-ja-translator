// Content Script

// Regex to detect Korean characters
const KOREAN_REGEX = /[가-힣]/;

// AI Studio free tier: 15 requests/min. Slots are shared by all
// parallel workers via a sliding-window limiter.
const RPM_LIMIT = 15;
const MAX_CONCURRENT = 4;
const MAX_RETRIES = 3;

let translating = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startTranslation' && !translating) {
    translatePage();
  }
});

async function translatePage() {
  translating = true;
  const toast = showToast('翻訳準備中…');
  try {
    await runTranslation(toast);
  } catch (e) {
    console.error('Translation failed:', e);
    toast.textContent = `翻訳エラー: ${e.message}`;
  } finally {
    translating = false;
    setTimeout(() => toast.remove(), 4000);
  }
}

async function runTranslation(toast) {
  const settings = await chrome.storage.local.get(['apiKey', 'modelName', 'maxBatchSize', 'maxBatchChars']);
  if (!settings.apiKey) {
    alert('Please set your Gemini API Key in the extension options.');
    toast.remove();
    return;
  }

  const ctx = {
    apiKey: settings.apiKey,
    modelName: settings.modelName || 'gemini-3.1-flash-lite',
    toast,
    done: 0,
    failed: 0,
    total: 0,
  };
  const maxBatchSize = parseInt(settings.maxBatchSize) || 250;
  const maxBatchChars = parseInt(settings.maxBatchChars) || 30000;

  const textNodes = getTextNodes(document.body);
  const koreanNodes = textNodes.filter(node => KOREAN_REGEX.test(node.nodeValue));
  console.log(`Found ${koreanNodes.length} visible text nodes with Korean.`);

  // Dedupe: identical strings (nav items, buttons, dates...) are translated
  // once and applied to every node that carries them.
  const itemsByText = new Map();
  for (const node of koreanNodes) {
    const text = node.nodeValue.trim();
    let item = itemsByText.get(text);
    if (!item) {
      item = { id: itemsByText.size, text, nodes: [] };
      itemsByText.set(text, item);
    }
    item.nodes.push(node);
  }
  const items = [...itemsByText.values()];
  ctx.total = items.length;

  if (items.length === 0) {
    toast.textContent = '韓国語のテキストが見つかりませんでした';
    return;
  }
  console.log(`${items.length} unique strings after dedup.`);

  // Batch in document order so the top of the page is translated first
  const batches = [];
  let currentBatch = [];
  let currentBatchChars = 0;
  for (const item of items) {
    if (currentBatch.length > 0 &&
        (currentBatch.length >= maxBatchSize || currentBatchChars + item.text.length > maxBatchChars)) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchChars = 0;
    }
    currentBatch.push(item);
    currentBatchChars += item.text.length;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);
  console.log(`Grouped into ${batches.length} batches.`);

  updateToast(ctx);

  // Worker pool: batches run in parallel, gated by the RPM limiter
  let nextBatch = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, batches.length) }, async () => {
    while (nextBatch < batches.length) {
      const batch = batches[nextBatch++];
      await translateBatch(batch, ctx);
    }
  });
  await Promise.all(workers);

  console.log(`Translation complete. ${ctx.done}/${ctx.total} translated, ${ctx.failed} failed.`);
  ctx.toast.textContent = ctx.failed > 0
    ? `翻訳完了(${ctx.failed}件失敗)`
    : '翻訳完了';
}

function getTextNodes(element) {
  const nodes = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
  let node;
  while (node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent) continue;
    const tag = parent.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') continue;
    if (node.nodeValue.trim() === '') continue;
    // Skip text we already translated
    if (parent.closest('.korean-translated-text')) continue;
    // Skip invisible text (display:none menus, templates...) — it burns
    // tokens and RPM slots for nothing. Re-run translation if it appears.
    if (typeof parent.checkVisibility === 'function' &&
        !parent.checkVisibility({ checkVisibilityCSS: true })) continue;
    nodes.push(node);
  }
  return nodes;
}

// Translate one batch: retry on transient errors, split in half when the
// model returns a broken or partial result, so one bad item can no longer
// take down a whole batch.
async function translateBatch(batch, ctx) {
  if (batch.length === 0) return;

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await acquireRequestSlot();
      const result = await callGeminiApiBatch(batch, ctx);

      const missing = [];
      for (const item of batch) {
        const translated = result.get(item.id);
        if (typeof translated === 'string' && translated.length > 0) {
          applyTranslation(item, translated, ctx);
        } else {
          missing.push(item);
        }
      }
      if (missing.length === 0) return;
      if (batch.length > 1) return splitAndRetry(missing, ctx);
      throw makeBadResponseError(`missing translation for id ${batch[0].id}`);
    } catch (e) {
      if (e.name === 'BadResponse' && batch.length > 1) {
        return splitAndRetry(batch, ctx);
      }
      lastError = e;
      const delay = e.retryAfterMs || Math.min(2 ** attempt * 2000, 30000);
      console.warn(`Batch attempt ${attempt + 1} failed (${e.message}), retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  console.error('Batch failed after retries:', lastError);
  ctx.failed += batch.length;
  updateToast(ctx);
}

async function splitAndRetry(items, ctx) {
  const mid = Math.ceil(items.length / 2);
  await translateBatch(items.slice(0, mid), ctx);
  await translateBatch(items.slice(mid), ctx);
}

async function callGeminiApiBatch(batch, ctx) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${ctx.modelName}:generateContent?key=${ctx.apiKey}`;

  const input = batch.map(item => ({ i: item.id, t: item.text }));
  const prompt = `You are a professional Korean-to-Japanese translator.
For each object in the JSON array below, translate the Korean string "t" into natural Japanese.
Return a JSON array of objects {"i": <same id as input>, "t": "<Japanese translation>"}, one per input, covering every id exactly once.
Keep numbers, URLs, and embedded non-Korean text unchanged.

${JSON.stringify(input)}`;

  const generationConfig = {
    temperature: 0,
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          i: { type: 'INTEGER' },
          t: { type: 'STRING' },
        },
        required: ['i', 't'],
      },
    },
  };
  // Translation needs no reasoning: minimizing thinking is the single
  // biggest latency win on thinking-enabled models.
  const thinkingConfig = getThinkingConfig(ctx.modelName);
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
  });

  if (!response.ok) {
    const error = new Error(`API Error: ${response.status}`);
    try {
      const body = await response.json();
      const retryInfo = (body.error?.details || []).find(d => (d['@type'] || '').includes('RetryInfo'));
      if (retryInfo?.retryDelay) {
        error.retryAfterMs = Math.ceil(parseFloat(retryInfo.retryDelay) * 1000);
      }
      if (body.error?.message) error.message += ` ${body.error.message}`;
      // Unknown model rejecting our thinkingConfig: drop it for this
      // session and let the retry loop resend immediately.
      if (response.status === 400 && thinkingConfig && /think/i.test(body.error?.message || '')) {
        thinkingConfigUnsupported = true;
        error.retryAfterMs = 100;
      }
    } catch (_) { /* body not JSON */ }
    throw error;
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  const rawText = (candidate?.content?.parts || [])
    .filter(p => !p.thought && typeof p.text === 'string')
    .map(p => p.text)
    .join('')
    .trim();

  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw makeBadResponseError('response truncated (MAX_TOKENS)');
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (parseError) {
    console.error('Failed to parse JSON response:', rawText.slice(0, 500));
    throw makeBadResponseError('unparsable JSON response');
  }
  if (!Array.isArray(parsed)) {
    throw makeBadResponseError('response is not an array');
  }

  const result = new Map();
  for (const entry of parsed) {
    if (entry && Number.isInteger(entry.i) && typeof entry.t === 'string') {
      result.set(entry.i, entry.t);
    }
  }
  return result;
}

function applyTranslation(item, translatedText, ctx) {
  for (const node of item.nodes) {
    replaceNodeWithHover(node, item.text, translatedText);
  }
  ctx.done++;
  updateToast(ctx);
}

function replaceNodeWithHover(textNode, originalText, translatedText) {
  // Sanity check: ensure node is still in DOM or valid
  if (!textNode.parentNode) return;

  const span = document.createElement('span');
  span.className = 'korean-translated-text';
  span.textContent = translatedText;
  span.setAttribute('data-original', originalText);

  textNode.parentNode.replaceChild(span, textNode);
  ensureTooltipHandlers();
}

// --- Original-text tooltip ----------------------------------------------
// One fixed-position element for the whole page, shown via delegated
// hover events. Unlike the ::after approach it wraps long text, stays
// inside the viewport, and cannot be clipped by overflow:hidden parents.

let tooltipInitialized = false;

function ensureTooltipHandlers() {
  if (tooltipInitialized) return;
  tooltipInitialized = true;

  document.addEventListener('mouseover', (event) => {
    const span = event.target.closest?.('.korean-translated-text');
    if (span) showTooltip(span);
  });
  document.addEventListener('mouseout', (event) => {
    const span = event.target.closest?.('.korean-translated-text');
    if (span && !span.contains(event.relatedTarget)) hideTooltip();
  });
  // The anchor moves under the pointer while scrolling; just hide.
  document.addEventListener('scroll', hideTooltip, true);
}

function showTooltip(span) {
  const original = span.getAttribute('data-original');
  if (!original) return;

  let tip = document.getElementById('kj-translator-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'kj-translator-tooltip';
    document.body.appendChild(tip);
  }
  tip.textContent = original;

  // Render invisibly first to measure, then position within the viewport
  tip.style.visibility = 'hidden';
  tip.style.display = 'block';
  const anchor = span.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const margin = 8;

  let left = anchor.left + anchor.width / 2 - tipRect.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));

  let top = anchor.top - tipRect.height - 6;      // prefer above
  if (top < margin) top = anchor.bottom + 6;      // flip below
  if (top + tipRect.height > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - tipRect.height - margin);
  }

  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.style.visibility = 'visible';
}

function hideTooltip() {
  const tip = document.getElementById('kj-translator-tooltip');
  if (tip) tip.style.display = 'none';
}

// --- Rate limiting -----------------------------------------------------

const requestTimestamps = [];

async function acquireRequestSlot() {
  while (true) {
    const now = Date.now();
    while (requestTimestamps.length > 0 && now - requestTimestamps[0] > 60000) {
      requestTimestamps.shift();
    }
    if (requestTimestamps.length < RPM_LIMIT) {
      requestTimestamps.push(now);
      return;
    }
    await sleep(60000 - (now - requestTimestamps[0]) + 100);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Gemini 2.5 turns thinking off via thinkingBudget; Gemini 3+ replaced it
// with thinkingLevel and rejects a budget of 0. If a model rejects the
// config with a 400, thinkingConfigUnsupported disables it for the session.
let thinkingConfigUnsupported = false;

function getThinkingConfig(modelName) {
  if (thinkingConfigUnsupported) return null;
  if (/gemini-2\.5/.test(modelName)) return { thinkingBudget: 0 };
  if (/gemini-[3-9]/.test(modelName)) return { thinkingLevel: 'low' };
  return null;
}

function makeBadResponseError(message) {
  const error = new Error(message);
  error.name = 'BadResponse';
  return error;
}

// --- Progress toast -----------------------------------------------------

function showToast(text) {
  let el = document.getElementById('kj-translator-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'kj-translator-status';
    document.body.appendChild(el);
  }
  el.textContent = text;
  return el;
}

function updateToast(ctx) {
  const failed = ctx.failed > 0 ? `・失敗 ${ctx.failed}` : '';
  ctx.toast.textContent = `翻訳中… ${ctx.done}/${ctx.total}${failed}`;
}
