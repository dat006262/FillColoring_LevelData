const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function worker(fetch) {
  const state = { connection: { token: 'test-token' }, active: { id: 'task', lease: 'lease', tabId: 7 } };
  let identities = 0;
  const sandbox = {
    fetch, URL, AbortSignal, setInterval() {},
    crypto: { randomUUID: () => `agent-${++identities}` },
    chrome: {
      storage: { session: {
        get: async () => ({ ...state }),
        set: async data => Object.assign(state, data),
        remove: async key => { delete state[key]; }
      } },
      runtime: { id: 'extension', onMessage: { addListener() {} } },
      action: { onClicked: { addListener() {} } },
      alarms: { create() {}, onAlarm: { addListener() {} } }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../chrome-extension/background.js'), 'utf8').replace(/\ntick\(\);\s*$/, ''), sandbox);
  return { sandbox, state };
}

const sender = { id: 'extension', tab: { id: 7 }, url: 'https://aistudio.google.com/prompts/test' };
test('server restart refreshes credentials and retries rejected request once', async () => {
  const token = 'new-server-token-123456789';
  let posts = 0;
  const { sandbox, state } = worker(async (url, options) => {
    if (url.endsWith('/')) return { ok: true, text: async () => `<meta name="app-token" content="${token}">` };
    posts++;
    if (posts === 1) return { ok: false, status: 403, json: async () => ({ error: 'Expired token' }) };
    assert.equal(options.headers['X-App-Token'], token);
    return { ok: true, json: async () => ({ task: null }) };
  });
  await sandbox.post('poll', { agent: 'agent' });
  assert.equal(posts, 2);
  assert.equal(state.connection.token, token);
});

test('background polling connects without a Studio tab heartbeat', async () => {
  let polls = 0;
  const { sandbox, state } = worker(async url => {
    if (url.endsWith('/')) return { ok: true, text: async () => '<meta name="app-token" content="background-token-123456789">' };
    polls++;
    return { ok: true, json: async () => ({ task: null }) };
  });
  delete state.connection;
  delete state.active;
  await sandbox.tick();
  assert.ok(state.connection);
  assert.equal(polls, 1);
});

test('concurrent initialization uses one agent', async () => {
  const { sandbox } = worker();
  const results = await Promise.all(Array.from({ length: 10 }, () => sandbox.context()));
  assert.equal(new Set(results.map(r => r.agent)).size, 1);
});

test('transport failure preserves active task and next heartbeat recovers', async () => {
  let failing = true;
  const { sandbox, state } = worker(async () => {
    if (failing) throw new Error('Network unavailable');
    return { ok: true, json: async () => ({ accepted: true }) };
  });
  const msg = { type: 'aistudio-progress', id: 'task', message: 'working' };
  assert.equal((await sandbox.dispatch(msg, sender)).reconnecting, true);
  assert.ok(state.active);
  failing = false;
  assert.equal((await sandbox.dispatch(msg, sender)).accepted, true);
});

test('invalid lease clears active task', async () => {
  const { sandbox, state } = worker(async () => ({ ok: false, status: 400, json: async () => ({ error: 'Invalid lease' }) }));
  assert.equal((await sandbox.dispatch({ type: 'aistudio-progress', id: 'task' }, sender)).cancelled, true);
  assert.equal(state.active, undefined);
});

test('new run closes idle tracked tabs and creates a fresh tab', async () => {
  const { sandbox, state } = worker();
  delete state.active;
  const url = 'https://aistudio.google.com/prompts/one';
  state.taskTabs = { [url]: 21 };
  const removed = [];
  let created = 0;
  sandbox.chrome.tabs = {
    get: async id => ({ id, url }),
    remove: async id => removed.push(id),
    create: async () => ({ id: 30 + created++, url: 'about:blank' }),
    update: async (id, options) => {
      assert.equal(state.active.tabId, id);
      assert.equal(options.url, url);
    }
  };
  await sandbox.openTaskTab({ id: 'first', url });
  delete state.active;
  await sandbox.openTaskTab({ id: 'second', url });
  assert.deepEqual(removed, [21, 30]);
  assert.equal(created, 2);
  assert.equal(state.active.tabId, 31);
});

test('active work prevents tab cleanup and new task', async () => {
  const { sandbox } = worker();
  await assert.rejects(sandbox.openTaskTab({ url: 'https://aistudio.google.com/prompts/one' }), /still active/);
});

test('closed or repurposed tabs do not block a fresh tab', async () => {
  const { sandbox, state } = worker();
  delete state.active;
  const url = 'https://aistudio.google.com/prompts/one';
  state.taskTabs = { [url]: 21, 'https://gemini.google.com/app': 22 };
  sandbox.chrome.tabs = {
    get: async id => {
      if (id === 21) throw new Error('Closed');
      return { id, url: 'https://example.com/' };
    },
    remove: async () => { throw new Error('Should not remove repurposed tab'); },
    create: async () => ({ id: 23 }),
    update: async () => {}
  };
  await sandbox.openTaskTab({ id: 'new', url });
  assert.equal(state.active.tabId, 23);
});

test('missing editor reopens same task once', async () => {
  const { sandbox, state } = worker(async () => ({ok:true, json:async () => ({task:{id:'task'}})}));
  state.active.url = 'https://aistudio.google.com/prompts/test';
  let created = 0;
  const removed = [];
  sandbox.chrome.tabs = {
    create: async () => { created++; return {id:99}; },
    update: async (id, opts) => { assert.equal(state.active.tabId, id); assert.equal(opts.url, state.active.url); },
    remove: async id => removed.push(id)
  };
  assert.equal((await sandbox.dispatch({type:'aistudio-reopen',id:'task'}, sender)).retried, true);
  assert.deepEqual(removed,[7]);
  assert.equal(state.active.id,'task');
  assert.equal((await sandbox.dispatch({type:'aistudio-reopen',id:'task'}, {...sender,tab:{id:99}})).retried,false);
  assert.equal(created,1);
});

test('stale active task is cleared before claiming the next loop', async () => {
  const calls = [];
  const url = 'https://aistudio.google.com/prompts/new';
  const { sandbox, state } = worker(async route => {
    calls.push(route.split('/').pop());
    if (route.endsWith('/payload')) return {ok:false,status:400,json:async()=>({error:'Finished'})};
    if (route.endsWith('/poll')) {
      assert.equal(state.active, undefined);
      return {ok:true,json:async()=>({task:{id:'next',lease:'next-lease',url}})};
    }
    return {ok:true,json:async()=>({accepted:true})};
  });
  const removed = [];
  sandbox.chrome.tabs = {
    remove: async id => removed.push(id),
    create: async () => ({id:88}),
    update: async () => {}
  };
  await sandbox.tick();
  assert.deepEqual(calls,['payload','poll','report']);
  assert.deepEqual(removed,[7]);
  assert.equal(state.active.id,'next');
  assert.equal(state.active.tabId,88);
});

test('live active task does not claim a queued task', async () => {
  const calls = [];
  const { sandbox } = worker(async route => {
    calls.push(route.split('/').pop());
    return {ok:true,json:async()=>({task:{id:'task'}})};
  });
  sandbox.chrome.tabs = {get:async()=>({id:7})};
  await sandbox.tick();
  assert.deepEqual(calls,['payload']);
});
