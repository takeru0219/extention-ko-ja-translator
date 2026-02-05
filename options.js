// Save settings
document.getElementById('saveBtn').addEventListener('click', () => {
  const apiKey = document.getElementById('apiKey').value;
  const modelName = document.getElementById('modelName').value;

  chrome.storage.local.set({ apiKey, modelName }, () => {
    const status = document.getElementById('status');
    status.style.display = 'block';
    setTimeout(() => {
      status.style.display = 'none';
    }, 2000);
  });
});

// Load settings
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['apiKey', 'modelName'], (items) => {
    if (items.apiKey) {
      document.getElementById('apiKey').value = items.apiKey;
    }
    if (items.modelName) {
      document.getElementById('modelName').value = items.modelName;
    } else {
        // Default
        document.getElementById('modelName').value = 'gemini-2.5-flash';
    }
  });
});
