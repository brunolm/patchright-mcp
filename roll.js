const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function doRoll(version) {
  updatePatchrightVersion(version);
  await copyConfig(version);
  // update readme
  execSync('npm run lint', { cwd: __dirname, stdio: 'inherit' });
}

function updatePatchrightVersion(version) {
  const file = path.join(__dirname, 'package.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
  let updated = false;
  for (const section of ['dependencies', 'devDependencies']) {
    for (const pkg of ['patchright', 'patchright-core']) {
      if (json[section]?.[pkg]) {
        json[section][pkg] = version;
        updated = true;
      }
    }
  }
  if (updated) {
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    console.log(`Updated ${file}`);
  }

  execSync('npm install', { cwd: __dirname, stdio: 'inherit' });
}

// patchright-core no longer ships config.d.ts, and patchright's patch numbers
// diverge from Playwright's, so the source is the matching release branch.
async function copyConfig(version) {
  const [major, minor] = version.split('.');
  const src = `https://raw.githubusercontent.com/microsoft/playwright/release-${major}.${minor}/packages/playwright-core/src/tools/mcp/config.d.ts`;
  const dst = path.join(__dirname, 'config.d.ts');
  const res = await fetch(src);
  if (!res.ok)
    throw new Error(`Failed to download ${src}: ${res.status} ${res.statusText}`);
  let content = await res.text();
  content = content.replace(
    /^import type \* as playwright from '[^']+';$/m,
    "import type * as playwright from 'patchright';"
  );
  fs.writeFileSync(dst, content);
  console.log(`Copied config.d.ts from ${src} to ${dst}`);
}

async function main() {
  let version = process.argv[2];
  if (!version) {
    version = execSync('npm info patchright version', { encoding: 'utf-8' }).trim();
    console.log(`Using latest patchright version: ${version}`);
  }
  await doRoll(version);
}

void main();
