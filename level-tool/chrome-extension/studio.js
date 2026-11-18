// No API key is read. The local nonce only authenticates the browser bridge.
(() => {
  if (location.origin !== 'http://127.0.0.1:8765') return;
  const token = document.querySelector('meta[name="app-token"]')?.content;
  if (!token) return;
  const getForceFocus = () => localStorage.getItem('force-focus') !== 'false';
  const beat = () => chrome.runtime.sendMessage({
    type: 'studio-heartbeat',
    token,
    forceFocus: getForceFocus()
  }).catch(() => {});
  beat();
  setInterval(beat, 2000);

  window.addEventListener('message', (event) => {
    if (event.data?.type === 'studio-toggle-force-focus') {
      chrome.runtime.sendMessage({
        type: 'set-force-focus',
        forceFocus: event.data.forceFocus !== false
      }).catch(() => {});
    }
  });
})();
