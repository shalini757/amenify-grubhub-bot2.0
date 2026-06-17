// Launches a real Chrome with the remote-debugging-port flag so Playwright
// can attach to it later via chromium.connectOverCDP(). Uses a dedicated
// user-data-dir under ./chrome-profile so it does not collide with your
// everyday Chrome session.
//
// Usage:
//   npm run chrome
//
// Then in that Chrome:
//   1. Go to grubhub.com
//   2. Log in (handle any captcha manually — it's just you using the site)
//   3. Set your delivery address
//   4. Leave the window open
//
// Then in another terminal, run:
//   node tests/dryRunFlow.js
//
// The bot attaches to the running Chrome via CDP and drives it.

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT: string = process.env.CDP_PORT || '9222';
const PROFILE_DIR: string = path.resolve(process.cwd(), 'chrome-profile');

const CANDIDATE_CHROME_PATHS: string[] = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
].filter((p): p is string => Boolean(p));

function findChrome(): string | null {
  for (const p of CANDIDATE_CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function main(): void {
  const chrome: string | null = findChrome();
  if (!chrome) {
    console.error('Could not find chrome.exe in any of these locations:');
    CANDIDATE_CHROME_PATHS.forEach((p) => console.error(`  - ${p}`));
    console.error('Set CHROME_PATH env var to the full path of chrome.exe and retry.');
    process.exit(1);
  }

  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
  }

  // Set HEADLESS_CHROME=true to run real Chrome with no visible window.
  // This keeps the trusted real-Chrome fingerprint the address swap relies
  // on (unlike Playwright's headless Chromium, which trips bot detection and
  // suppresses the Google Places autocomplete). Log in / pass captcha ONCE
  // headful so the ./chrome-profile cookies persist, then run headless.
  const headless: boolean = String(process.env.HEADLESS_CHROME || '').toLowerCase() === 'true';

  const args: string[] = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    headless ? '--headless=new' : '--start-maximized',
    ...(headless ? ['--window-size=1366,850', '--disable-gpu'] : []),
  ];

  console.log(`Mode: ${headless ? 'HEADLESS (--headless=new)' : 'headful'}`);

  console.log(`Launching: ${chrome}`);
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log(`CDP endpoint: http://localhost:${PORT}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. In this Chrome window, go to https://www.grubhub.com');
  console.log('  2. Sign in and set your delivery address.');
  console.log('  3. Leave the window OPEN.');
  console.log('  4. In another terminal:  node tests/dryRunFlow.js');
  console.log('');

  const child: ChildProcess = spawn(chrome, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`Chrome PID: ${child.pid}`);
}

main();
