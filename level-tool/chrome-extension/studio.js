// No API key is read. The local nonce only authenticates the browser bridge.
(() => {
  if (location.origin !== 'http://127.0.0.1:8765') return;
  const token = document.querySelector('meta[name="app-token"]')?.content;
  if (!token) return;
  const beat = () => chrome.runtime.sendMessage({type:'studio-heartbeat', token}).catch(() => {});
  beat();
  setInterval(beat, 2000);
})();
