import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Use real frame timing. --dump-dom virtual time can finish while CSS transitions
// and content-visibility are still pending, creating false layout failures.
export async function headlessCheck(browser, folder, html, { exercise } = {}) {
  // A supplied local automation runtime uses a pipe rather than a loopback CDP
  // port. This also works on hosts whose policies/proxy block debugger ports.
  if (process.env.DSH_PLAYWRIGHT_MODULE) {
    const { chromium } = createRequire(import.meta.url)(process.env.DSH_PLAYWRIGHT_MODULE);
    const instance = await chromium.launch({ executablePath: browser, headless: true });
    try {
      const page = await instance.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(pathToFileURL(html).href);
      const protocol = await page.context().newCDPSession(page);
      if (exercise) await exercise((method, params = {}) => protocol.send(method, params));
      await page.waitForFunction(() => { const node = document.getElementById('result'); return node && node.textContent !== 'pending'; }, null, { timeout: 25000 });
      return await page.content();
    } finally { await instance.close(); }
  }
  const profile = join(folder, 'browser-profile');
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--disable-software-rasterizer', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-extensions', '--host-resolver-rules=MAP * ~NOTFOUND', '--user-data-dir=' + profile, '--window-size=1280,900', '--remote-debugging-port=0', pathToFileURL(html).href], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let error = '', closed = false, socket;
  child.stderr.on('data', data => { error = (error + data).slice(-2000); });
  child.on('close', () => { closed = true; });
  child.on('error', failure => { error = failure.message; closed = true; });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    let port;
    for (let i = 0; i < 100 && !closed; i++) {
      try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {}
      await pause(100);
    }
    if (!port) throw Error('Headless browser startup failed: ' + error);
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = pages.find(page => page.type === 'page' && page.url === pathToFileURL(html).href);
    if (!page) throw Error('Isolated check page missing');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let serial = 0; const pending = new Map();
    socket.addEventListener('message', event => {
      const value = JSON.parse(event.data), waiter = pending.get(value.id);
      if (!waiter) return; pending.delete(value.id); value.error ? waiter.reject(Error(value.error.message)) : waiter.resolve(value.result);
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    });
    await command('Page.bringToFront');
    if (exercise) await exercise(command);
    const result = await command('Runtime.evaluate', { expression: `(async()=>{for(let i=0;i<400;i++){const output=document.getElementById('result');if(output&&output.textContent!=='pending')return document.documentElement.outerHTML;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Check page timed out');})()`, awaitPromise: true, returnByValue: true, timeout: 25000 });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || 'Headless evaluation failed');
    return result.result.value;
  } finally {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: 99999, method: 'Browser.close' }));
    socket?.close();
    for (let i = 0; i < 20 && !closed; i++) await pause(50);
    if (!closed) child.kill();
  }
}
