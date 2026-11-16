const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chrome-extension/canva.js'), 'utf8');
const apply = source.slice(source.indexOf('  async function applyLineArtStyle()'), source.indexOf('  async function extractLineImage()'));
async function scenario(notice, busy, cancelled = () => false) {
  let now = 0, clicks = 0, disconnected = false;
  const option = { closest() { return this; }, scrollIntoView() {}, getBoundingClientRect() { return { left: 100, top: 200, width: 80, height: 60 }; }, click() { throw Error('Bare click must not be used'); } };
  const context = {
    Date: { now: () => now },
    clickAt(x, y) { assert.equal(x, 140); assert.equal(y, 230); clicks++; },
    showStatus() {}, findLineArtOptionRobust: () => option,
    waitFor: fn => fn(), sleep: async ms => { now += ms; },
    check() { if (cancelled(now)) throw Error('cancelled'); },
    hasStyleAppliedNotice: () => notice(now), isStyleProcessing: () => busy(now),
    document: { body: {} },
    MutationObserver: class { observe() {} disconnect() { disconnected = true; } }
  };
  vm.createContext(context);
  vm.runInContext(apply, context);
  let error;
  try { await context.applyLineArtStyle(); } catch (e) { error = e; }
  assert.equal(clicks, 1);
  assert.equal(disconnected, true);
  return { now, error };
}
(async () => {
  // No progress indicator is not evidence of completion, even after 14 seconds.
  assert.match((await scenario(() => false, () => false)).error.message, /180/);
  // Stale success from an earlier operation cannot unlock download.
  assert.match((await scenario(() => true, () => false)).error.message, /180/);
  const slow = await scenario(t => t >= 60000, t => t < 65000);
  assert.equal(slow.error, undefined);
  assert.ok(slow.now >= 70000);
  // A returning spinner resets the full quiet interval.
  const resumed = await scenario(t => t >= 10000, t => t >= 13000 && t < 20000);
  assert.equal(resumed.error, undefined);
  assert.ok(resumed.now >= 25000);
  assert.match((await scenario(() => false, () => false, t => t > 1000)).error.message, /cancelled/);
  // Exercise the real gesture helper: Canva receives down/up before one click.
  const events = [];
  const target = { dispatchEvent(e) { events.push(e.type); }, focus() {} };
  const gesture = { document: { elementFromPoint: () => target }, window: {},
    PointerEvent: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } } };
  vm.createContext(gesture);
  vm.runInContext(source.slice(source.indexOf('  function clickAt('), source.indexOf('  function openContextMenu(')), gesture);
  gesture.clickAt(140, 230);
  assert.deepEqual(events, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  const helper = source.slice(source.indexOf('  function hasStyleAppliedNotice()'), source.indexOf('  function isStyleProcessing()'));
  let text = '', own = false;
  const ctx = { visible: () => true, querySelectorAllDeep: () => [{ get innerText() { return text; }, closest: () => own }] };
  vm.createContext(ctx); vm.runInContext(helper, ctx);
  for (const value of ['Đang áp dụng kiểu', 'Áp dụng kiểu', 'Not style applied']) {
    text = value; assert.equal(ctx.hasStyleAppliedNotice(), false);
  }
  for (const value of ['Đã áp dụng kiểu', 'Style applied.']) {
    text = value; assert.equal(ctx.hasStyleAppliedNotice(), true);
  }
  own = true; assert.equal(ctx.hasStyleAppliedNotice(), false);
  console.log('PASS: timeout, stale notice, slow processing, resumed processing, cancellation, exact completion notices');
})().catch(e => { console.error(e); process.exitCode = 1; });
