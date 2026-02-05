document.getElementById('translateBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    // Send a message to the active tab's content script
    chrome.tabs.sendMessage(tab.id, { action: 'startTranslation' });
    window.close();
  }
});

document.getElementById('openSettings').addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('options.html'));
  }
});
