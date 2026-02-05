// Content Script

// Regex to detect Korean characters
const KOREAN_REGEX = /[\uAC00-\uD7A3]/;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startTranslation') {
    translatePage();
  }
});

async function translatePage() {
  console.log("Starting translation...");

  const settings = await chrome.storage.local.get(['apiKey', 'modelName']);
  if (!settings.apiKey) {
    alert('Please set your Gemini API Key in the extension options.');
    return;
  }

  const apiKey = settings.apiKey;
  const modelName = settings.modelName || 'gemini-2.5-flash';

  const textNodes = getTextNodes(document.body);
  const koreanNodes = textNodes.filter(node => KOREAN_REGEX.test(node.nodeValue));

  console.log(`Found ${koreanNodes.length} text nodes with Korean.`);

  // Optimization: Batch processing
  const BATCH_SIZE = 15;
  const batches = [];
  for (let i = 0; i < koreanNodes.length; i += BATCH_SIZE) {
      batches.push(koreanNodes.slice(i, i + BATCH_SIZE));
  }

  const CONCURRENCY_LIMIT = 5;
  const queue = [...batches];
  let activeRequests = 0;

  async function processQueue() {
      if (queue.length === 0 && activeRequests === 0) {
          console.log("Translation complete.");
          return;
      }

      while (activeRequests < CONCURRENCY_LIMIT && queue.length > 0) {
          const batch = queue.shift();
          activeRequests++;
          translateBatch(batch, apiKey, modelName).finally(() => {
              activeRequests--;
              processQueue();
          });
      }
  }

  processQueue();
}

function getTextNodes(element) {
  const nodes = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
  let node;
  while (node = walker.nextNode()) {
    // Filter out script, style, and empty nodes
    const parentTag = node.parentNode.tagName.toLowerCase();
    if (parentTag !== 'script' && parentTag !== 'style' && parentTag !== 'noscript' && node.nodeValue.trim() !== '') {
      nodes.push(node);
    }
  }
  return nodes;
}

async function translateBatch(nodes, apiKey, modelName) {
    const texts = nodes.map(n => n.nodeValue.trim());
    if (texts.length === 0) return;

    try {
        const translatedTexts = await callGeminiApiBatch(texts, apiKey, modelName);
        if (translatedTexts && translatedTexts.length === nodes.length) {
            for (let i = 0; i < nodes.length; i++) {
                replaceNodeWithHover(nodes[i], texts[i], translatedTexts[i]);
            }
        } else {
            console.warn("Mismatch in batch translation result length or null result.");
        }
    } catch (error) {
        console.error("Batch translation failed:", error);
    }
}

async function callGeminiApiBatch(texts, apiKey, modelName) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const prompt = `
    You are a professional translator. Translate the following JSON array of Korean strings to Japanese.
    Output ONLY a valid JSON array of strings. Do not include Markdown formatting (like \`\`\`json).
    Maintain the order of strings exactly.

    Input: ${JSON.stringify(texts)}
    `;

    const payload = {
        contents: [{
            parts: [{
                text: prompt
            }]
        }]
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }

        const data = await response.json();
        if (data.candidates && data.candidates.length > 0 && data.candidates[0].content.parts.length > 0) {
            let rawText = data.candidates[0].content.parts[0].text.trim();
            // Clean up markdown code blocks if present
            if (rawText.startsWith('```json')) {
                rawText = rawText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
            } else if (rawText.startsWith('```')) {
                 rawText = rawText.replace(/^```\s*/, '').replace(/\s*```$/, '');
            }

            try {
                return JSON.parse(rawText);
            } catch (parseError) {
                console.error("Failed to parse JSON response:", rawText);
                return null;
            }
        }
    } catch (e) {
        console.error("API Call error:", e);
        return null;
    }
    return null;
}

function replaceNodeWithHover(textNode, originalText, translatedText) {
    // Sanity check: ensure node is still in DOM or valid
    if (!textNode.parentNode) return;

    const span = document.createElement('span');
    span.className = 'korean-translated-text';
    span.textContent = translatedText;
    span.setAttribute('data-original', originalText);

    textNode.parentNode.replaceChild(span, textNode);
}
