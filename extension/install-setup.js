export function registerInstallSetup(chrome) {
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html?view=bridge&setup=1') });
  });
}
