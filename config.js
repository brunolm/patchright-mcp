/**
 * Patchright MCP runtime configuration.
 *
 * Tunables and defaults consumed by cli.js. Override host paths with the
 * PATCHRIGHT_CHROME_PATH environment variable; everything else is editable
 * here without touching the launcher.
 */

module.exports = {
  // Path to the Chrome executable used by the auto-launch fallback.
  // PATCHRIGHT_CHROME_PATH env var takes precedence.
  chromeExecutablePath:
    process.env.PATCHRIGHT_CHROME_PATH ||
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',

  // CDP endpoint used when --cdp-endpoint is not provided on the command line.
  defaultCdpEndpoint: 'http://localhost:9222',

  // Timeout (ms) for individual /json/version liveness probes against the CDP endpoint.
  cdpProbeTimeoutMs: 1500,

  // Total time (ms) we wait for Chrome to expose CDP after spawning it.
  chromeStartupTimeoutMs: 30000,

  // Total time (ms) we wait for the CDP endpoint to go away after closing Chrome.
  chromeShutdownTimeoutMs: 10000,

  // Captcha solving. Checkbox widgets are clicked in-page. Image grids are
  // sent to the Claude CLI (`claude`, or PATCHRIGHT_CAPTCHA_CLAUDE). Set
  // PATCHRIGHT_CAPTCHA_AUTO=0 to stop solving after other browser tools;
  // browser_solve_captcha still works.
  captcha: {
    auto: process.env.PATCHRIGHT_CAPTCHA_AUTO !== '0',
    solveTimeoutMs: 12000,
    appearTimeoutMs: 8000,
    interstitialTimeoutMs: 30000,
    maxAttempts: 2,
    holdMs: 4000,
  },

  // Default browser launch options. `headless` is mutated at runtime by the
  // browser_set_headless tool. `args` is the list of command-line flags
  // appended to every Chrome launch.
  launchOptions: {
    headless: false,
    colorScheme: 'dark',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--hide-crash-restore-bubble',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-notifications',
      '--noerrdialogs',
    ],
  },
};
