import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

// Real compiled PipeClient -> real Node dispatcher. No Window/Application/browser.
export function nativeRequest(executable, sessionId, action, args, dispatch) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, ['--request-test'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', error = '', result;
    const timer = setTimeout(() => { child.kill(); reject(Error('Native request check timed out')); }, 15000);
    child.stdin.on('error', () => {});
    child.stderr.on('data', data => { error += data; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      buffer += data; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (message.kind === 'request') {
          Promise.resolve().then(() => dispatch(message)).then(
            value => child.stdin.write(JSON.stringify({ kind: 'response', id: message.id, ok: true, value }) + '\n'),
            failure => child.stdin.write(JSON.stringify({ kind: 'response', id: message.id, ok: false, error: failure.message }) + '\n'));
        } else if (message.kind === 'request-test-complete') result = message;
      }
    });
    child.on('error', failure => { clearTimeout(timer); reject(failure); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0, error); assert.ok(result, 'Compiled host must complete');
        assert.equal(result.createdWindow, false);
        accept({ ok: result.ok, value: result.value, error: result.error });
      } catch (failure) { reject(failure); }
    });
    child.stdin.write(JSON.stringify({ kind: 'bootstrap', sessionId, request: { action, args } }) + '\n');
  });
}
