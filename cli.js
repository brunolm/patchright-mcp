#!/usr/bin/env node
/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const http = require("http");
const { spawn } = require("child_process");
const { program } = require("patchright-core/lib/utilsBundle");
const config = require("./config");

function takeFlag(argv, name) {
  const idx = argv.findIndex((a) => a === name || a.startsWith(name + "="));
  if (idx === -1) return null;
  const arg = argv[idx];
  if (arg.includes("=")) {
    argv.splice(idx, 1);
    return arg.slice(arg.indexOf("=") + 1);
  }
  const value = argv[idx + 1];
  argv.splice(idx, 2);
  return value ?? null;
}

function readFlag(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
    if (argv[i] === name) return argv[i + 1] ?? null;
  }
  return null;
}

function isCdpAlive(url) {
  return new Promise((resolve) => {
    const req = http.get(`${url.origin}/json/version`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(config.cdpProbeTimeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

const launchOptions = {
  ...config.launchOptions,
  executablePath: config.chromeExecutablePath,
  args: [...config.launchOptions.args],
};

function setupLazyChromeLaunch(userDataDir, cdpEndpoint) {
  const url = new URL(cdpEndpoint);
  const port = Number(url.port) || 9222;
  let inflight = null;

  async function ensure() {
    if (await isCdpAlive(url)) return;
    if (inflight) return inflight;
    inflight = (async () => {
      const chromeArgs = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        ...launchOptions.args,
      ];
      if (launchOptions.headless) chromeArgs.push("--headless=new");
      console.error(
        `[patchright-mcp] Launching Chrome: ${chromeArgs.join(" ")}`,
      );
      const child = spawn(launchOptions.executablePath, chromeArgs, {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (err) =>
        console.error("[patchright-mcp] Failed to spawn Chrome:", err.message),
      );
      child.unref();
      const deadline = Date.now() + config.chromeStartupTimeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        if (await isCdpAlive(url)) return;
      }
      throw new Error(
        `[patchright-mcp] Timed out waiting for Chrome CDP at ${cdpEndpoint}`,
      );
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  const playwright = require("patchright-core");
  const original = playwright.chromium.connectOverCDP.bind(playwright.chromium);
  playwright.chromium.connectOverCDP = async function (...args) {
    await ensure();
    const browser = await original(...args);
    applyColorScheme(browser, launchOptions.colorScheme);
    return browser;
  };
}

function applyColorScheme(browser, colorScheme) {
  if (!colorScheme) return;
  const apply = (page) => page.emulateMedia({ colorScheme }).catch(() => {});
  const wireContext = (ctx) => {
    for (const p of ctx.pages()) apply(p);
    ctx.on("page", apply);
  };
  for (const ctx of browser.contexts()) wireContext(ctx);
  browser.on("context", wireContext);
}

async function shutdownBrowser(browserContext) {
  const browser = browserContext?.browser?.();
  try {
    if (browser?.newBrowserCDPSession) {
      const session = await browser.newBrowserCDPSession();
      await session.send("Browser.close").catch(() => {});
    }
  } catch {}
  try {
    if (browser) await browser.close();
    else if (browserContext) await browserContext.close();
  } catch {}
}

function setupBrowserQuitTool() {
  require("patchright-core/lib/tools/exports");
  const { z } = require("patchright-core/lib/zodBundle");

  const browserQuitTool = {
    capability: "core",
    schema: {
      name: "browser_quit",
      title: "Quit browser",
      description:
        "Fully close the browser process via patchright (browser.close), not just the current page.",
      inputSchema: z.object({}),
      type: "action",
    },
    handle: async (context, params, response) => {
      await shutdownBrowser(context._rawBrowserContext);
      response.addTextResult("Browser closed.");
      response.addCode(
        "await session.send('Browser.close'); await browser.close();",
      );
      response.setClose();
    },
  };

  const browserSetHeadlessTool = {
    capability: "core",
    schema: {
      name: "browser_set_headless",
      title: "Set headless mode",
      description:
        "Configure whether the next browser launch is headless. If a browser is already running, it is shut down so the next browser_* call relaunches in the new mode. Call this BEFORE browser_navigate when the prompt asks for headless behaviour.",
      inputSchema: z.object({
        enabled: z.boolean().describe("true for headless, false for headed"),
      }),
      type: "action",
    },
    handle: async (context, params, response) => {
      launchOptions.headless = !!params.enabled;
      await shutdownBrowser(context._rawBrowserContext);
      response.addTextResult(
        `Headless mode set to ${launchOptions.headless}. Next browser_* call will launch a fresh Chrome.`,
      );
      response.addCode(`launchOptions.headless = ${launchOptions.headless};`);
      response.setClose();
    },
  };

  const cacheKey = Object.keys(require.cache).find((k) =>
    /[\\/]tools[\\/]backend[\\/]tools\.js$/.test(k),
  );
  if (!cacheKey) {
    console.error(
      "[patchright-mcp] Could not locate tools.js in require cache; skipping custom tools",
    );
    return;
  }
  const mod = require.cache[cacheKey];
  const originalExports = mod.exports;
  const originalFilteredTools = originalExports.filteredTools;
  mod.exports = new Proxy(originalExports, {
    get(target, prop, receiver) {
      if (prop === "filteredTools")
        return (config) => [
          ...originalFilteredTools(config),
          browserQuitTool,
          browserSetHeadlessTool,
        ];
      return Reflect.get(target, prop, receiver);
    },
  });
}

function setupSelfHealingBackend() {
  const { BrowserBackend } = require("patchright-core/lib/tools/exports");
  const playwright = require("patchright-core");

  const isClosureError = (text) =>
    /(?:browser|context|page|target).*has been closed/i.test(text || "");

  const originalInit = BrowserBackend.prototype.initialize;
  BrowserBackend.prototype.initialize = async function (clientInfo) {
    this._clientInfo = clientInfo;
    return originalInit.call(this, clientInfo);
  };

  const originalCallTool = BrowserBackend.prototype.callTool;
  BrowserBackend.prototype.callTool = async function (
    name,
    rawArguments,
    progress,
  ) {
    const result = await originalCallTool.call(
      this,
      name,
      rawArguments,
      progress,
    );
    if (!result?.isError || !isClosureError(result.content?.[0]?.text))
      return result;

    const cdpEndpoint = this._config?.browser?.cdpEndpoint;
    if (!cdpEndpoint) return result;

    console.error(
      "[patchright-mcp] Detected closed browser; reconnecting and retrying tool call",
    );
    try {
      const ContextClass = this._context?.constructor;
      await this._context?.dispose().catch(() => {});
      const browser = await playwright.chromium.connectOverCDP(cdpEndpoint);
      const browserContext = this._config.browser.isolated
        ? await browser.newContext(this._config.browser.contextOptions)
        : browser.contexts()[0];
      this.browserContext = browserContext;
      if (ContextClass) {
        this._context = new ContextClass(browserContext, {
          config: this._config,
          sessionLog: this._sessionLog,
          cwd: this._clientInfo?.cwd,
        });
      } else {
        await originalInit.call(this, this._clientInfo || {});
      }
    } catch (e) {
      console.error("[patchright-mcp] Reconnect failed:", e.message);
      return result;
    }
    return originalCallTool.call(this, name, rawArguments, progress);
  };
}

const userDataDir = takeFlag(process.argv, "--auto-launch-chrome");
const cdpEndpoint =
  readFlag(process.argv, "--cdp-endpoint") || config.defaultCdpEndpoint;
if (userDataDir) setupLazyChromeLaunch(userDataDir, cdpEndpoint);
setupSelfHealingBackend();
setupBrowserQuitTool();

if (process.argv.includes("install-browser")) {
  const argv = process.argv.map((arg) =>
    arg === "install-browser" ? "install" : arg,
  );
  require("patchright-core/lib/cli/program");
  void program.parseAsync(argv);
  return;
}

const { decorateMCPCommand } = require("patchright-core/lib/tools/mcp/program");
const packageJSON = require("./package.json");
const p = program
  .version("Version " + packageJSON.version)
  .name("Patchright MCP");
decorateMCPCommand(p, packageJSON.version);
void program.parseAsync(process.argv);
