/**
 * Headless Chromium で日本語 wav のチャンク遅延と RTF を測る。
 *   node tools/whisper-live-bench.mjs
 * iPhone Safari はこの VM では測れない。
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 8765;
const MODELS = (process.argv[2] || 'tiny,base').split(',').filter(Boolean);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitJson(url, tries = 50) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      last = String(res.status);
    } catch (error) {
      last = error.message;
    }
    await sleep(200);
  }
  throw new Error('cdp not ready: ' + last);
}

function startServer() {
  const child = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return child;
}

function startChrome(userData) {
  const child = spawn('google-chrome', [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-angle=swiftshader',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer',
    '--remote-debugging-port=9222',
    `--user-data-dir=${userData}`,
    '--autoplay-policy=no-user-gesture-required',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  return child;
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.next = 0;
    this.pending = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', () => reject(new Error('cdp websocket failed')));
    });
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result || {});
      }
    });
  }

  async send(method, params, sessionId) {
    await this.opened;
    const id = ++this.next;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.ws.close();
  }
}

async function withPage(cdp, fn) {
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', {
    targetId: created.targetId,
    flatten: true
  });
  const sessionId = attached.sessionId;
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  try {
    return await fn(sessionId);
  } finally {
    await cdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result && result.result.value;
}

async function openSettingsShot(cdp) {
  return withPage(cdp, async (sessionId) => {
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }, sessionId);
    await sleep(800);
    const info = await evaluate(cdp, sessionId, `(() => {
      const btn = document.querySelector('#header-settings-btn');
      if (btn) btn.click();
      const toggle = document.querySelector('#offline-whisper-toggle');
      const label = toggle ? (toggle.parentElement.innerText || '') : '';
      return {
        toggle: !!toggle,
        checked: toggle ? toggle.checked : null,
        label,
        record: !!document.querySelector('#record-btn'),
        build: (document.querySelector('#app-build-info') || {}).textContent || '',
        modal: document.querySelector('#settings-modal-overlay')
          ? document.querySelector('#settings-modal-overlay').className
          : ''
      };
    })()`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const dir = '/opt/cursor/artifacts';
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'offline-whisper-settings.png'), Buffer.from(shot.data, 'base64'));
    return info;
  });
}

async function runModel(cdp, model, offline) {
  const url = `http://127.0.0.1:${PORT}/tools/whisper-live-bench.html?model=${encodeURIComponent(model)}`;
  return withPage(cdp, async (sessionId) => {
    if (offline) {
      await cdp.send('Network.emulateNetworkConditions', {
        offline: true,
        latency: 0,
        downloadThroughput: 0,
        uploadThroughput: 0
      }, sessionId);
    }
    await cdp.send('Page.navigate', { url }, sessionId);
    const deadline = Date.now() + (offline ? 180000 : 300000);
    let last = '';
    while (Date.now() < deadline) {
      await sleep(2000);
      const state = await evaluate(cdp, sessionId, `(() => {
        const el = document.querySelector('#out');
        if (!el) return { done: false, text: '' };
        return { done: el.dataset.done === '1', text: el.textContent || '' };
      })()`);
      last = state && state.text ? state.text : last;
      if (state && state.done) {
        return JSON.parse(state.text);
      }
    }
    throw new Error('timeout ' + model + (offline ? ' offline' : '') + ' last=' + last.slice(0, 500));
  });
}

const server = startServer();
const userData = `/tmp/chrome-whisper-bench-${Date.now()}`;
const chrome = startChrome(userData);
let exitCode = 0;
try {
  await sleep(400);
  const version = await waitJson('http://127.0.0.1:9222/json/version');
  const cdp = new Cdp(version.webSocketDebuggerUrl);
  const summary = { ui: null, runs: [], errors: [] };
  try {
    summary.ui = await openSettingsShot(cdp);
    console.log('UI', JSON.stringify(summary.ui));
    if (process.env.UI_ONLY === '1') {
      console.log('UI_ONLY');
    } else for (const model of MODELS) {
      try {
        const warm = await runModel(cdp, model, false);
        console.log('WARM', model, JSON.stringify(warm));
        summary.runs.push({ phase: 'warm', ...warm });
        const cold = await runModel(cdp, model, true);
        console.log('OFFLINE', model, JSON.stringify(cold));
        summary.runs.push({ phase: 'offline', ...cold });
      } catch (error) {
        console.error('FAIL', model, error.message);
        summary.errors.push({ model, message: error.message });
        exitCode = 1;
      }
    }
  } finally {
    await writeFile('/tmp/whisper-live-bench.json', JSON.stringify(summary, null, 2));
    cdp.close();
  }
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  chrome.kill('SIGKILL');
  server.kill('SIGKILL');
}
process.exit(exitCode);
