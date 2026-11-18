const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../chrome-extension/aistudio.js'), 'utf8');
const helper = source.slice(source.indexOf('  async function retryInternalError('), source.indexOf('  async function run()'));
function setup(text, live = true) {
  const storage = new Map([['marker', 'sent']]);
  let navigations = 0;
  const ctx = {
    check() {}, visible: () => true,
    querySelectorAllDeep: () => [{ innerText: text, closest: () => null }],
    showStatus() {}, message: async () => ({ task: live ? { id: 'task' } : null }),
    task: { id: 'task', url: 'https://aistudio.google.com/prompts/test' },
    sessionStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    heartbeat: null, clearInterval() {},
    location: { replace: url => { assert.equal(url, ctx.task.url); navigations++; } }
  };
  vm.createContext(ctx); vm.runInContext(helper, ctx);
  return { ctx, storage, count: () => navigations };
}
test('internal error retries once and clears submission guard', async () => {
  const { ctx, storage, count } = setup('An internal error has occurred.');
  assert.equal(await ctx.retryInternalError('marker'), true);
  assert.equal(storage.has('marker'), false);
  await assert.rejects(ctx.retryInternalError('marker'), /Đã thử lại 1 lần/);
  assert.equal(count(), 1);
});
test('ordinary timeout does not retry', async () => {
  const { ctx, count } = setup('Something else');
  assert.equal(await ctx.retryInternalError('marker'), false);
  assert.equal(count(), 0);
});
test('expired task cannot retry', async () => {
  const { ctx, storage, count } = setup('An internal error has occurred.', false);
  assert.equal(await ctx.retryInternalError('marker'), false);
  assert.equal(storage.get('marker'), 'sent');
  assert.equal(count(), 0);
});

test('welcome popup appearing during ten-second wait is dismissed', async () => {
  let now = 0, closed = false, clicks = 0;
  const button = { disabled: false, innerText: 'Continue', getAttribute: () => null, click() { clicks++; closed = true; } };
  const dialog = { innerText: 'Welcome to AI Studio' };
  const ctx = {
    Date: { now: () => now }, check() {}, showStatus() {}, visible: () => true,
    sleep: async ms => { now += ms; },
    querySelectorAllDeep: (selector, root) => root ? [button] : (now >= 5000 && !closed ? [dialog] : []),
    waitFor: async fn => { assert.equal(fn(), true); }
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  async function dismissWelcomePopup('), source.indexOf('  async function run()')), ctx);
  await ctx.dismissWelcomePopup();
  assert.equal(clicks, 1);
  assert.ok(now >= 10000);
});
