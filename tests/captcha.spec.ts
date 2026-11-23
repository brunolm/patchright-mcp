import path from 'path';
import { createRequire } from 'node:module';

import { test, expect } from './fixtures';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { TestServer } from './testserver/index';

const { parseSquares } = createRequire(path.join(__dirname, 'captcha.spec.ts'))('../captcha.js');

test('parseSquares reads a line of row,col pairs', () => {
  expect(parseSquares('2,2 2,3 3,2 3,3')).toEqual([
    { row: 2, col: 2 },
    { row: 2, col: 3 },
    { row: 3, col: 2 },
    { row: 3, col: 3 },
  ]);
  expect(parseSquares('note\n`2,2 3,1`')).toEqual([
    { row: 2, col: 2 },
    { row: 3, col: 1 },
  ]);
  expect(parseSquares('nope')).toEqual([]);
});

test('solves a turnstile checkbox while navigating', async ({ client, server }) => {
  serveTurnstileGate(server);
  await chooseCaptchaTypes(client, ['cloudflare']);

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    snapshot: expect.stringContaining('Welcome'),
    result: expect.stringContaining('Solved turnstile captcha.'),
  });
});

test('solves nothing until captcha types are chosen', async ({ client, server }) => {
  serveTurnstileGate(server);

  const navigated = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  expect(navigated.content[0].text).not.toContain('Solved');
  expect(navigated.content[0].text).not.toContain('Welcome');

  expect(await client.callTool({
    name: 'browser_solve_captcha',
    arguments: {},
  })).toHaveResponse({
    result: expect.stringContaining('Captcha solving is off.'),
  });
});

test('solves only the chosen captcha types and keeps the last choice', async ({ client, server }) => {
  serveTurnstileGate(server);
  await chooseCaptchaTypes(client, ['recaptcha']);

  const navigated = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  expect(navigated.content[0].text).not.toContain('Solved');
  expect(navigated.content[0].text).not.toContain('Welcome');

  expect(await client.callTool({
    name: 'browser_solve_captcha',
    arguments: { types: ['cloudflare'] },
  })).toHaveResponse({
    result: expect.stringContaining('Solving captchas: cloudflare. Solved turnstile captcha.'),
    snapshot: expect.stringContaining('Welcome'),
  });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    result: expect.stringContaining('Solved turnstile captcha.'),
    snapshot: expect.stringContaining('Welcome'),
  });
});

test('an empty captcha type list turns solving off', async ({ client, server }) => {
  serveTurnstileGate(server);
  await chooseCaptchaTypes(client, ['all']);

  expect(await client.callTool({
    name: 'browser_solve_captcha',
    arguments: { types: [] },
  })).toHaveResponse({
    result: expect.stringContaining('Captcha solving is off.'),
  });

  const navigated = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  expect(navigated.content[0].text).not.toContain('Solved');
});

test('does not click an ordinary checkbox', async ({ client, server }) => {
  server.setContent('/', `
    <title>Form</title>
    <label><input type="checkbox"> Subscribe</label>
  `, 'text/html');
  await chooseCaptchaTypes(client, ['all']);

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    snapshot: expect.stringContaining('checkbox "Subscribe"'),
  });

  const response = await client.callTool({
    name: 'browser_snapshot',
    arguments: {},
  });
  const text = response.content[0].text;
  expect(text).toContain('checkbox "Subscribe"');
  expect(text).not.toContain('[checked]');
  expect(text).not.toContain('Solved');
});

test('holds a human-check button until it clears', async ({ client, server }) => {
  server.setContent('/', `
    <title>Check</title>
    <button>Press and hold to confirm you are human</button>
    <script>
      const button = document.querySelector('button');
      button.addEventListener('mousedown', () => {
        setTimeout(() => {
          button.remove();
          document.body.append('Welcome');
        }, 300);
      });
    </script>
  `, 'text/html');
  await chooseCaptchaTypes(client, ['press-and-hold']);

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    snapshot: expect.stringContaining('Welcome'),
    result: expect.stringContaining('Solved press and hold captcha.'),
  });
});

test('follows a checkbox click into the image challenge', async ({ startClient, server }) => {
  server.setContent('/recaptcha/api2/anchor', `
    <button id="recaptcha-anchor">I'm not a robot</button>
    <script>
      document.querySelector('#recaptcha-anchor').addEventListener('click', () => {
        const frame = parent.document.getElementById('challenge');
        frame.style.height = '500px';
      });
    </script>
  `, 'text/html');
  server.setContent('/recaptcha/api2/bframe', `
    <style>body { margin: 0; }</style>
    <table class="rc-imageselect-table-44">
      <tr>
        <td class="rc-imageselect-tile"></td><td class="rc-imageselect-tile"></td><td class="rc-imageselect-tile"></td><td class="rc-imageselect-tile"></td>
      </tr>
      <tr>
        <td class="rc-imageselect-tile"></td><td class="rc-imageselect-tile" id="target"></td><td class="rc-imageselect-tile"></td><td class="rc-imageselect-tile"></td>
      </tr>
      <tr>
        <td class="rc-imageselect-tile"></td><td class="rc-imageselect-tile"></td><td class="rc-imageselect-tile"></td><td class="rc-imageselect-tile"></td>
      </tr>
      <tr>
        <td class="rc-imageselect-tile"></td><td class="rc-imageselect-tile"></td><td class="rc-imageselect-tile"></td><td class="rc-imageselect-tile"></td>
      </tr>
    </table>
    <script>
      document.getElementById('target').addEventListener('click', () => {
        parent.document.title = 'Home';
        parent.document.getElementById('done').hidden = false;
        parent.document.getElementById('challenge').remove();
      });
    </script>
  `, 'text/html');
  server.setContent('/', `
    <title>Sign in</title>
    <iframe title="reCAPTCHA" src="/recaptcha/api2/anchor" style="width:304px;height:78px;border:0"></iframe>
    <iframe id="challenge" title="recaptcha challenge" src="/recaptcha/api2/bframe" style="width:400px;height:0;border:0"></iframe>
    <p id="done" hidden>Welcome</p>
  `, 'text/html');

  const { client } = await startClient({ env: { PATCHRIGHT_CAPTCHA_GROK_REPLY: '2,2' } });
  await chooseCaptchaTypes(client, ['recaptcha']);
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    result: expect.stringContaining('Solved recaptcha image captcha.'),
    snapshot: expect.stringContaining('Welcome'),
  });
});

test('ignores an empty recaptcha frame', async ({ client, server }) => {
  server.setContent('/recaptcha/api2/bframe', '<p>empty</p>', 'text/html');
  server.setContent('/recaptcha/api2/anchor', `
    <button id="recaptcha-anchor" aria-checked="true">I'm not a robot</button>
  `, 'text/html');
  server.setContent('/', `
    <title>Ready</title>
    <iframe title="reCAPTCHA" src="/recaptcha/api2/anchor" style="width:304px;height:78px;border:0"></iframe>
    <iframe title="recaptcha challenge" src="/recaptcha/api2/bframe" style="width:300px;height:150px;border:0"></iframe>
    <p>Ready</p>
  `, 'text/html');
  await chooseCaptchaTypes(client, ['recaptcha']);

  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  const text = response.content[0].text;
  expect(text).toContain('Ready');
  expect(text).not.toContain('image');
  expect(text).not.toContain('Grok');
});

test('browser_evaluate does not click a captcha', async ({ startClient, server }) => {
  server.setContent('/cf-frame', `
    <style>body { margin: 0; }</style>
    <input type="checkbox">
    <script>
      document.querySelector('input').addEventListener('click', () => {
        parent.document.title = 'Home';
        parent.document.getElementById('done').hidden = false;
        parent.document.getElementById('gate').remove();
      });
    </script>
  `, 'text/html');
  server.setContent('/gate', `
    <title>Gate</title>
    <div id="gate">
      <iframe title="Widget containing a Cloudflare security challenge" src="/cf-frame" style="width:300px;height:65px;border:0"></iframe>
    </div>
    <p id="done" hidden>Welcome</p>
  `, 'text/html');

  const { client } = await startClient();
  await chooseCaptchaTypes(client, ['all']);
  await client.callTool({
    name: 'browser_run_code_unsafe',
    arguments: {
      code: `async (page) => { await page.goto('${server.PREFIX}gate'); return page.url(); }`,
    },
  });

  const inspected = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => document.getElementById("done").hidden' },
  });
  expect(inspected.content[0].text).toContain('true');
  expect(inspected.content[0].text).not.toContain('Solved');
});

test('waits for a recaptcha checkbox injected after load', async ({ client, server }) => {
  server.setContent('/recaptcha/api2/anchor', `
    <button id="recaptcha-anchor">I'm not a robot</button>
    <script>
      document.querySelector('#recaptcha-anchor').addEventListener('click', () => {
        parent.document.title = 'Home';
        parent.document.getElementById('done').hidden = false;
        parent.document.getElementById('holder').remove();
      });
    </script>
  `, 'text/html');
  server.setContent('/', `
    <title>Late</title>
    <div class="g-recaptcha"></div>
    <div id="holder"></div>
    <p id="done" hidden>Welcome</p>
    <script>
      setTimeout(() => {
        const frame = document.createElement('iframe');
        frame.title = 'reCAPTCHA';
        frame.src = '/recaptcha/api2/anchor';
        frame.style.cssText = 'width:304px;height:78px;border:0';
        document.getElementById('holder').append(frame);
      }, 600);
    </script>
  `, 'text/html');
  await chooseCaptchaTypes(client, ['recaptcha']);

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    result: expect.stringContaining('Solved recaptcha captcha.'),
    snapshot: expect.stringContaining('Welcome'),
  });
});

test('waits out a turnstile reload before calling it solved', async ({ client, server }) => {
  server.setContent('/cf-frame', `
    <style>body { margin: 0; }</style>
    <script>
      document.addEventListener('click', (event) => {
        if (event.clientX >= 80) return;
        parent.postMessage('go', '*');
        parent.document.getElementById('gate').remove();
      });
    </script>
  `, 'text/html');
  server.setContent('/', `
    <title>Just a moment...</title>
    <div id="gate">
      <iframe title="Widget containing a Cloudflare security challenge" src="/cf-frame" style="width:300px;height:65px;border:0"></iframe>
    </div>
    <p id="done" hidden>Welcome</p>
    <script>
      window.addEventListener('message', (event) => {
        if (event.data !== 'go') return;
        setTimeout(() => {
          document.title = 'Home';
          document.getElementById('done').hidden = false;
        }, 800);
      });
    </script>
  `, 'text/html');
  await chooseCaptchaTypes(client, ['cloudflare']);

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    result: expect.stringContaining('Solved turnstile captcha.'),
    snapshot: expect.stringContaining('Welcome'),
  });
});

test('leaves a solved turnstile token alone', async ({ client, server }) => {
  server.setContent('/cf-frame', '<p>widget</p>', 'text/html');
  server.setContent('/', `
    <title>Ready</title>
    <iframe title="Widget containing a Cloudflare security challenge" src="/cf-frame" style="width:300px;height:65px;border:0"></iframe>
    <input name="cf-turnstile-response" value="token">
    <p>Ready</p>
  `, 'text/html');
  await chooseCaptchaTypes(client, ['cloudflare']);

  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  const text = response.content[0].text;
  expect(text).toContain('Ready');
  expect(text).not.toContain('Solved');
});

test('browser_solve_captcha reports a page with no captcha', async ({ client, server }) => {
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    snapshot: expect.stringContaining('Hello, world!'),
  });

  expect(await client.callTool({
    name: 'browser_solve_captcha',
    arguments: { types: ['all'] },
  })).toHaveResponse({
    result: expect.stringContaining('No captcha found.'),
    snapshot: expect.stringContaining('Hello, world!'),
  });
});

function serveTurnstileGate(server: TestServer) {
  server.setContent('/cf-frame', `
    <style>body { margin: 0; }</style>
    <script>
      document.addEventListener('click', (event) => {
        if (event.clientX >= 80) {
          parent.document.title = 'Missed ' + event.clientX + ',' + event.clientY;
          return;
        }
        parent.document.title = 'Home';
        parent.document.getElementById('done').hidden = false;
        parent.document.getElementById('gate').remove();
      });
    </script>
  `, 'text/html');
  server.setContent('/', `
    <title>Just a moment...</title>
    <div id="gate">
      <iframe title="Widget containing a Cloudflare security challenge" src="/cf-frame" style="width:300px;height:65px;border:0"></iframe>
    </div>
    <p id="done" hidden>Welcome</p>
  `, 'text/html');
}

async function chooseCaptchaTypes(client: Client, types: string[]) {
  await client.callTool({ name: 'browser_solve_captcha', arguments: { types } });
}
