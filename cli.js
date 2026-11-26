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
const { program, z } = require("patchright-core/lib/utilsBundle");
const { tools, libCli } = require("patchright-core/lib/coreBundle");
const config = require("./config");
const {
  CAPTCHA_TYPES,
  resolveCaptchaTypes,
  solveCaptcha,
} = require("./captcha");

// Captcha types each client asked to solve, keyed by its tool context. Empty
// until browser_solve_captcha sets it, so one session's choice never applies to
// another session sharing this server over HTTP.
const captchaTypesByContext = new WeakMap();

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
  await waitForCdpShutdown(new URL(cdpEndpoint));
}

// Chrome keeps answering /json/version for a moment after Browser.close; a
// connect in that window attaches to the dying browser instead of relaunching.
async function waitForCdpShutdown(url) {
  const deadline = Date.now() + config.chromeShutdownTimeoutMs;
  while (Date.now() < deadline && (await isCdpAlive(url)))
    await new Promise((r) => setTimeout(r, 250));
}

function setupCustomTools() {
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
      await shutdownBrowser(context._defaultBrowserContext);
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
      await shutdownBrowser(context._defaultBrowserContext);
      response.addTextResult(
        `Headless mode set to ${launchOptions.headless}. Next browser_* call will launch a fresh Chrome.`,
      );
      response.addCode(`launchOptions.headless = ${launchOptions.headless};`);
      response.setClose();
    },
  };

  const browserSolveCaptchaTool = {
    capability: "core",
    schema: {
      name: "browser_solve_captcha",
      title: "Solve captcha",
      description:
        "Choose which captcha types to solve, then solve any matching captcha on the current page. Captchas are never solved until this is called. Call it only when the user explicitly asks to solve captchas, and pass only the types they named: 'cloudflare' is Turnstile and the 'Just a moment' page, 'press-and-hold' is a hold-to-confirm human check, and 'all' is only for when the user says all or any captcha. The choice lasts for the rest of the session, and the solver also runs on its own after navigation and other page actions, so later requests need no new call unless the user changes the types. Omit types to reuse the current choice; pass [] to stop solving. Checkboxes are clicked; image challenges are solved by a local object detector, which can find bicycles, buses, cars, motorcycles, trucks, boats, traffic lights, fire hydrants and parking meters. The first image challenge downloads the 60 MB detector model.",
      inputSchema: z.object({
        types: z
          .array(z.enum([...CAPTCHA_TYPES, "all"]))
          .optional()
          .describe(
            "Captcha types the user asked to solve. Omit to keep the current choice.",
          ),
      }),
      type: "action",
    },
    handle: async (context, params, response) => {
      if (params.types)
        captchaTypesByContext.set(context, resolveCaptchaTypes(params.types));
      const captchaTypes = captchaTypesOf(context);
      if (!captchaTypes.length) {
        response.addTextResult(
          params.types
            ? "Captcha solving is off."
            : "Captcha solving is off. Pass the captcha types the user asked to solve.",
        );
        return;
      }
      const tab = await context.ensureTab();
      const result = await solveCaptcha(tab.page, captchaSettings(context));
      response.addTextResult(
        `Solving captchas: ${captchaTypes.join(", ")}. ${result.action || "No captcha found."}`,
      );
      response.setIncludeSnapshot();
    },
  };

  // filteredTools() is bound inside coreBundle and can't be wrapped, but it
  // reads this exported array on every call.
  tools.browserTools.push(
    browserQuitTool,
    browserSetHeadlessTool,
    browserSolveCaptchaTool,
  );
  wrapAutoSolve();
}

function captchaSettings(context) {
  return { ...config.captcha, types: captchaTypesOf(context) };
}

function captchaTypesOf(context) {
  return captchaTypesByContext.get(context) ?? [];
}

// Reads and scripts stay fast. The solver runs after a navigation or an input
// that can land on a challenge, and from browser_solve_captcha directly.
const AUTO_SOLVE_TOOLS = new Set([
  "browser_click",
  "browser_drag",
  "browser_drop",
  "browser_file_upload",
  "browser_fill_form",
  "browser_hover",
  "browser_mouse_click_xy",
  "browser_mouse_drag_xy",
  "browser_navigate",
  "browser_navigate_back",
  "browser_press_key",
  "browser_select_option",
  "browser_type",
  "browser_wait_for",
]);

function wrapAutoSolve() {
  for (const tool of tools.browserTools) {
    if (!AUTO_SOLVE_TOOLS.has(tool.schema.name)) continue;
    const original = tool.handle;
    tool.handle = async (context, params, response, signal) => {
      await original.call(tool, context, params, response, signal);
      if (!captchaTypesOf(context).length) return;
      const page = context.currentTab?.()?.page;
      if (!page || page.isClosed()) return;
      try {
        const result = await solveCaptcha(page, captchaSettings(context));
        if (result.action) response.addTextResult(result.action);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.addTextResult(`Captcha solver failed: ${message}`);
      }
    };
  }
}

const userDataDir = takeFlag(process.argv, "--auto-launch-chrome");
const cdpEndpoint =
  readFlag(process.argv, "--cdp-endpoint") || config.defaultCdpEndpoint;
if (userDataDir) setupLazyChromeLaunch(userDataDir, cdpEndpoint);
setupCustomTools();

if (process.argv.includes("install-browser")) {
  const argv = process.argv.map((arg) =>
    arg === "install-browser" ? "install" : arg,
  );
  libCli.decorateProgram(program);
  void program.parseAsync(argv);
  return;
}

const packageJSON = require("./package.json");
const p = program
  .version("Version " + packageJSON.version)
  .name("Patchright MCP");
tools.decorateMCPCommand(p, packageJSON.version);
void program.parseAsync(process.argv);
