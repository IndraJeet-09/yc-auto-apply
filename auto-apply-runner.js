#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { CV, geminiKey } = require('./config');

// ── CLI args ─────────────────────────────────────────────────
const site = process.argv[2] || 'yc';
const mode = process.argv.includes('--live') ? 'LIVE' : 'DRY_RUN';

if (site !== 'yc') {
  console.error(`Unknown site: ${site}. Only "yc" is supported.`);
  process.exit(1);
}

const DRY_RUN = mode === 'DRY_RUN';
const MAX_APPLICATIONS = parseInt(process.env.MAX_APPS || '50', 10);
const MAX_RUNTIME_MS = 100 * 60 * 1000; // 100 minutes

const CHROME_PATH = process.env.CHROME_PATH || '';
const PROFILE_DIR = path.join(__dirname, '.yc-chrome-profile');
const LOG_FILE = path.join(__dirname, 'auto-apply-yc.log');
const STATE_FILE = path.join(__dirname, 'apply-state-yc.json');
const APPLY_SCRIPT = fs.readFileSync(path.join(__dirname, 'yc-auto-apply.js'), 'utf-8');
const CSV_FILE = path.join(__dirname, 'applications.csv');

const SITE_CONFIG = {
  yc: {
    searchUrl: 'https://www.workatastartup.com/jobs',
    loginUrl: 'https://www.workatastartup.com/jobs',
    applyPattern: /workatastartup\.com/i,
  },
};

// ── Logging ──────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
}

function log(msg) {
  const line = `[${ts()}] [yc] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ── State management ─────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      const today = new Date().toDateString();
      if (state.date === today) return state;
    }
  } catch {}
  return { date: new Date().toDateString(), count: 0 };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── CSV logging ──────────────────────────────────────────────
function logToCSV(data) {
  const header = 'Date,Site,Role,Company,Salary,Skills,Job Link,Job Description\n';
  if (!fs.existsSync(CSV_FILE)) fs.writeFileSync(CSV_FILE, header);

  const row = [
    ts(),
    'YC',
    data.role || '',
    data.company || '',
    data.salary || '',
    (data.skills || []).join('; '),
    data.url || '',
    (data.description || '').replace(/"/g, '""').slice(0, 500),
  ].map(v => `"${v}"`).join(',');

  fs.appendFileSync(CSV_FILE, row + '\n');
}

// ── Browser launch ───────────────────────────────────────────
async function launchBrowser() {
  let chromium;
  try {
    const extra = require('playwright-extra');
    const stealth = require('puppeteer-extra-plugin-stealth')();
    extra.use(stealth);
    chromium = extra;
    log('Using playwright-extra with stealth');
  } catch {
    chromium = require('playwright-core');
    log('Using plain playwright-core (stealth unavailable)');
  }

  const launchOpts = {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
      '--window-position=-32000,-32000',
    ],
  };

  if (CHROME_PATH) launchOpts.executablePath = CHROME_PATH;

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    ...launchOpts,
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });

  return context;
}

// ── Login flow ───────────────────────────────────────────────
async function loginFlow() {
  log('Starting login flow...');
  const context = await launchBrowser();
  const page = context.pages()[0] || await context.newPage();

  await page.goto(SITE_CONFIG.yc.loginUrl, { waitUntil: 'domcontentloaded' });
  log('Chrome opened. Please log in to workatastartup.com');
  log('Close the browser window when done.');

  await page.waitForEvent('close', { timeout: 300_000 }).catch(() => {});
  await context.close().catch(() => {});
  log('Login session saved.');
}

// ── Main runner ──────────────────────────────────────────────
async function run() {
  const state = loadState();
  const remaining = MAX_APPLICATIONS - state.count;

  if (remaining <= 0) {
    log(`Daily cap already reached (${state.count}/${MAX_APPLICATIONS}). Nothing to do.`);
    return;
  }

  log(`Starting. mode=${DRY_RUN ? 'DRY_RUN' : 'LIVE'} target=${remaining} applications, max ${MAX_RUNTIME_MS / 60000} min`);

  const context = await launchBrowser();
  const page = context.pages()[0] || await context.newPage();

  // Inject config into every page
  await page.addInitScript((config) => {
    window.__APPLY_CONFIG = config;
    window.__YC_DRY_RUN = true; // will be overridden by injected script
  }, CV);

  // Navigate to jobs page
  await page.goto(SITE_CONFIG.yc.searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  log('Opened workatastartup.com/jobs');

  // Wait for page to settle
  await page.waitForTimeout(3000);

  // Inject the apply script
  const patchedScript = APPLY_SCRIPT
    .replace('window.__YC_DRY_RUN !== undefined ? window.__YC_DRY_RUN : true', `${DRY_RUN}`)
    .replace('window.__YC_MAX_APPLICATIONS || 50', `${remaining}`);

  await page.evaluate(patchedScript);
  log('Apply script injected');

  // Monitor console for progress
  let completedCount = 0;
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[auto-apply]')) {
      log(text.replace('[auto-apply] ', ''));
    }
    if (text.startsWith('[yc-done]')) {
      const match = text.match(/Applied to (\d+)/);
      if (match) completedCount = parseInt(match[1], 10);
    }
  });

  // Supervisor loop
  const startTime = Date.now();
  while (Date.now() - startTime < MAX_RUNTIME_MS) {
    await page.waitForTimeout(10_000);

    if (completedCount > 0 && !page.url().includes('workatastartup.com')) {
      log('Script appears to have finished. Stopping supervisor.');
      break;
    }

    // Check for errors / stalled
    const pageTitle = await page.title().catch(() => '');
    if (pageTitle.includes('Verification') || pageTitle.includes('captcha')) {
      log('CAPTCHA detected — pausing 60s and retrying...');
      await page.waitForTimeout(60_000);
    }
  }

  // Final state update
  state.count += completedCount;
  saveState(state);
  log(`Run complete. Applied to ${completedCount} jobs this run. Total today: ${state.count}/${MAX_APPLICATIONS}`);

  // Log to CSV if live
  if (!DRY_RUN && completedCount > 0) {
    logToCSV({
      role: 'YC Jobs Batch',
      company: 'Various',
      url: SITE_CONFIG.yc.searchUrl,
      skills: CV.skills.slice(0, 5),
      description: `Applied to ${completedCount} jobs via auto-apply`,
    });
  }

  await context.close().catch(() => {});
  log('Browser closed.');
}

// ── Entry point ──────────────────────────────────────────────
const command = process.argv[3];

if (command === 'login') {
  loginFlow().catch(err => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  });
} else {
  run().catch(err => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
