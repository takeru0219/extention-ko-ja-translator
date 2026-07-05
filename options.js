// Save settings
document.getElementById('saveBtn').addEventListener('click', () => {
  const apiKey = document.getElementById('apiKey').value;
  const modelName = document.getElementById('modelName').value;
  const maxBatchSize = parseInt(document.getElementById('maxBatchSize').value) || 250;
  const maxBatchChars = parseInt(document.getElementById('maxBatchChars').value) || 30000;

  chrome.storage.local.set({ apiKey, modelName, maxBatchSize, maxBatchChars }, () => {
    const status = document.getElementById('status');
    status.style.display = 'block';
    setTimeout(() => {
      status.style.display = 'none';
    }, 2000);
  });
});

// Load settings
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['apiKey', 'modelName', 'maxBatchSize', 'maxBatchChars'], (items) => {
    if (items.apiKey) {
      document.getElementById('apiKey').value = items.apiKey;
    }
    if (items.modelName) {
      document.getElementById('modelName').value = items.modelName;
    } else {
        // Default
        document.getElementById('modelName').value = 'gemini-3.1-flash-lite';
    }
    
    document.getElementById('maxBatchSize').value = items.maxBatchSize !== undefined ? items.maxBatchSize : 250;
    document.getElementById('maxBatchChars').value = items.maxBatchChars !== undefined ? items.maxBatchChars : 30000;
  });
});
