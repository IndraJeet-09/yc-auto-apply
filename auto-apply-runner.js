#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { CV, geminiKey, remoteOnly } = require('./config');

// ── CLI args ─────────────────────────────────────────────────
const mode = process.argv.includes('--live') ? 'LIVE' : 'DRY_RUN';
const DRY_RUN = mode === 'DRY_RUN';
const MAX_APPLICATIONS = parseInt(process.env.MAX_APPS || '50', 10);
const MAX_RUNTIME_MS = 100 * 60 * 1000;
const REMOTE_ONLY = remoteOnly;

const CHROME_PATH = process.env.CHROME_PATH || '';
const PROFILE_DIR = path.join(__dirname, '.yc-chrome-profile');
const LOG_FILE = path.join(__dirname, 'auto-apply-yc.log');
const STATE_FILE = path.join(__dirname, 'apply-state-yc.json');
const CSV_FILE = path.join(__dirname, 'applications.csv');

// ── Logging ──────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
}
function log(msg) {
  const line = `[${ts()}] [yc] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ── State ────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      if (s.date === new Date().toDateString()) return s;
    }
  } catch { }
  return { date: new Date().toDateString(), count: 0, seen: [] };
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── CSV ──────────────────────────────────────────────────────
function logToCSV(data) {
  const header = 'Date,Site,Role,Company,Salary,Skills,Job Link,Job Description\n';
  if (!fs.existsSync(CSV_FILE)) fs.writeFileSync(CSV_FILE, header);
  const row = [
    ts(), 'YC', data.role, data.company, data.salary,
    (data.skills || []).join('; '), data.url,
    (data.desc || '').replace(/"/g, '""').slice(0, 500),
  ].map(v => `"${v || ''}"`).join(',');
  fs.appendFileSync(CSV_FILE, row + '\n');
}

// ── Title filtering ──────────────────────────────────────────
const TITLE_KEYWORDS = [
  'full stack', 'fullstack', 'full-stack',
  'backend', 'back-end', 'software engineer', 'software developer',
  'frontend', 'front-end', 'react', 'node', 'python', 'typescript',
  'javascript', 'ai engineer', 'ml engineer', 'machine learning',
  'devops', 'sre', 'infrastructure', 'mobile', 'ios', 'android',
  'data engineer', 'founding engineer', 'staff engineer',
  'founding', 'product engineer', 'member of technical staff',
  'intern', 'internship', 'trainee', 'ux', 'ui'
];
const TITLE_BLOCKLIST = [
  // Experience-level skip (user has 3 years, skip senior+ roles)
  'senior', 'sr.', 'sr ', 'staff', 'principal', 'distinguished',
  'lead', 'head of', 'director', 'vp', 'vice president',
  'engineering manager', 'tech lead', 'team lead',
  // Role-type skip
  'sales', 'marketing', 'growth', 'content',
  'design', 'hr', 'recruiter', 'talent', 'finance', 'legal', 'executive',
];

function matchesTitle(title) {
  const t = title.toLowerCase();
  if (TITLE_BLOCKLIST.some(b => t.includes(b))) return false;
  return TITLE_KEYWORDS.some(k => t.includes(k));
}

// ── Experience filtering ─────────────────────────────────────
const USER_EXPERIENCE = parseInt(CV.yearsExperience || '0', 10);
const MAX_ALLOWED_YEARS = USER_EXPERIENCE + 1; // e.g., user has 3 yrs → skip jobs requiring 5+

function parseExperienceYears(pageText) {
  // Look for patterns like "5+ years", "3+ Years", "8+ years of experience"
  const match = pageText.match(/(\d+)\+?\s*(?:years?|yrs?)/i);
  if (match) return parseInt(match[1], 10);
  return null;
}

// ── Location filtering ───────────────────────────────────────
function extractLocation(cardText) {
  // Card text looks like: "Company (S14)•desc Title FulltimeRemote (US)Full stack$124K"
  // or: "Company FulltimeSan Francisco, CA, USFull stack$192K"
  // or: "Company FulltimeCA / Remote (CA)Machine learning$124K"
  const ftMatch = cardText.match(/(fulltime|parttime)\s*(.*?)(fullstack|backend|frontend|machine learning|data|infrastructure|hardware|ios|android|mobile|devops|sre|$)/i);
  if (ftMatch) {
    const between = ftMatch[2].trim();
    if (between) return between;
  }
  // Fallback: look for common location patterns
  const locMatch = cardText.match(/(remote\s*\([^)]*\)|[a-z\s]+,\s*[a-z]{2},\s*[a-z]{2}|remote)/i);
  return locMatch ? locMatch[0] : '';
}

function isRemoteJob(location) {
  return /remote/i.test(location);
}

// ── Gemini AI ────────────────────────────────────────────────
async function askGemini(question) {
  if (!geminiKey) return null;

  const prompt = `You are a job applicant. Answer this application question concisely in 2-3 sentences.
Your background: ${CV.yearsExperience} years experience as ${CV.currentRole} at ${CV.company}.
Skills: ${CV.skills.join(', ')}.
Highlights: ${CV.highlights[0] || 'Building scalable applications'}.
Location: ${CV.location}. Open to relocation: ${CV.relocate}.

Question: ${question}`;

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 200, temperature: 0.7 },
        }),
      }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

// ── Job scraping from DOM ────────────────────────────────────
async function scrapeJobsFromPage(page) {
  return page.evaluate(() => {
    const jobs = [];
    const jobLinks = document.querySelectorAll('a[href^="/jobs/"]');

    for (const link of jobLinks) {
      const title = link.textContent.trim();
      if (!title || title.length < 5) continue;

      const href = link.getAttribute('href') || '';
      const slugMatch = href.match(/\/jobs\/(\d+)/);
      if (!slugMatch) continue;
      const slug = slugMatch[1];
      const url = `https://www.workatastartup.com${href}`;

      let card = link.closest('.flex.h-full') || link.parentElement?.parentElement?.parentElement;
      const cardText = card ? card.textContent.toLowerCase() : '';

      let company = '';
      if (card) {
        const allText = card.innerText;
        const lines = allText.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          if (line !== title && !line.match(/^(Fulltime|Parttime|Intern|Remote|Apply|\$|CA|US|IN|Remote|San|New)/i) && line.length > 1 && line.length < 80) {
            company = line.split('•')[0].trim();
            break;
          }
        }
      }

      jobs.push({ title, company, url, slug, text: cardText });
    }
    return jobs;
  });
}

async function fetchJobs(page) {
  log('Scraping jobs from page...');

  await page.goto('https://www.workatastartup.com/jobs', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(1500);
    log(`  scroll ${i + 1}/5`);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1000);

  const allJobs = await scrapeJobsFromPage(page);
  log(`  scraped ${allJobs.length} job cards from page`);

  const seen = new Set();
  const unique = allJobs.filter(j => {
    if (seen.has(j.slug)) return false;
    seen.add(j.slug);
    return true;
  });

  const filtered = unique.filter(job => {
    if (!matchesTitle(job.title)) return false;
    return true;
  });

  // Location filtering
  if (REMOTE_ONLY) {
    const beforeCount = filtered.length;
    const remoteJobs = filtered.filter(job => {
      const loc = extractLocation(job.text);
      return isRemoteJob(loc);
    });
    const skipped = beforeCount - remoteJobs.length;
    if (skipped > 0) log(`  🚫 skipped ${skipped} non-remote jobs`);
    log(`Found ${remoteJobs.length} matching remote jobs out of ${unique.length} unique`);
    return remoteJobs;
  }

  log(`Found ${filtered.length} matching jobs out of ${unique.length} unique`);
  return filtered;
}

// ── Browser launch ───────────────────────────────────────────
let chromium;
try {
  const { addExtra } = require('playwright-extra');
  chromium = addExtra(require('playwright-core').chromium);
  chromium.use(require('puppeteer-extra-plugin-stealth')());
  log('Using playwright-extra with stealth');
} catch {
  ({ chromium } = require('playwright-core'));
  log('Using plain playwright-core (stealth unavailable)');
}

process.on('unhandledRejection', (e) => {
  log(`unhandledRejection: ${String(e && e.message || e).split('\n')[0]}`);
});

async function launchBrowser() {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run', '--no-default-browser-check',
      '--disable-infobars', '--window-position=-32000,-32000',
    ],
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });
}

// ── Login flow ───────────────────────────────────────────────
async function loginFlow() {
  log('Starting login flow...');
  const context = await launchBrowser();
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.workatastartup.com/jobs', { waitUntil: 'domcontentloaded' });
  log('Chrome opened. Please log in to workatastartup.com, then close the window.');
  await page.waitForEvent('close', { timeout: 300_000 }).catch(() => { });
  await context.close().catch(() => { });
  log('Login session saved.');
}

// ── Fill a single field by label ─────────────────────────────
async function fillByLabel(page, labelText, value) {
  return page.evaluate(({ label, val }) => {
    function setNative(el, v) {
      const setter = Object.getOwnPropertyDescriptor(
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      )?.set;
      if (setter) setter.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    const labels = document.querySelectorAll('label, [role="label"], span, p');
    for (const lbl of labels) {
      const text = (lbl.textContent || '').toLowerCase();
      if (!text.includes(label.toLowerCase())) continue;

      const forId = lbl.getAttribute('for');
      let input = forId ? document.getElementById(forId) : null;
      if (!input) {
        const parent = lbl.closest('div, .field, .form-group') || lbl.parentElement;
        input = parent?.querySelector('input, textarea, select');
      }
      if (!input) continue;

      if (input.tagName === 'SELECT') {
        const opt = Array.from(input.options).find(o => o.text.toLowerCase().includes(val.toLowerCase()));
        if (opt) { input.value = opt.value; input.dispatchEvent(new Event('change', { bubbles: true })); }
      } else {
        setNative(input, val);
      }
      return true;
    }
    return false;
  }, { label: labelText, val: value });
}

// ── Fill work authorization checkbox ─────────────────────────
async function fillWorkAuth(page) {
  return page.evaluate((workAuth) => {
    const labels = [...document.querySelectorAll('label')];
    // Find the "no sponsorship needed in US" checkbox
    const usAuthLabel = labels.find(l => {
      const t = l.textContent.toLowerCase();
      return t.includes('authorized to work') && t.includes('without sponsorship') && t.includes('united states');
    });
    if (usAuthLabel) {
      const checkbox = usAuthLabel.querySelector('input[type="checkbox"]') ||
        usAuthLabel.closest('div')?.querySelector('input[type="checkbox"]');
      if (checkbox && !checkbox.checked) {
        checkbox.click();
        return 'US-no-sponsorship';
      }
      if (checkbox?.checked) return 'US-no-sponsorship-already';
    }
    return null;
  }, CV.workAuth);
}

// ── Detect and fill all required fields ──────────────────────
async function fillRequiredFields(page, job) {
  const result = await page.evaluate(({ cv, jobTitle, jobCompany }) => {
    const filled = [];
    const skipped = [];

    // Find all labels with * (required markers)
    const allLabels = [...document.querySelectorAll('label, p, span, div')];
    const requiredLabels = allLabels.filter(l => {
      const text = l.textContent || '';
      return text.includes('*') && text.length > 3 && text.length < 200;
    });

    for (const label of requiredLabels) {
      const labelText = label.textContent.trim().replace(/\*/g, '').trim();
      const labelTextLower = labelText.toLowerCase();

      // Find the associated input
      const forId = label.getAttribute('for');
      let input = forId ? document.getElementById(forId) : null;
      if (!input) {
        const group = label.closest('div, .field, .form-group') || label.parentElement;
        input = group?.querySelector('input:not([type="hidden"]):not([type="file"]), textarea, select');
      }
      if (!input) continue;

      // Skip if already filled
      if (input.tagName === 'TEXTAREA' && input.value.length > 10) {
        filled.push(labelText.slice(0, 40) + ' (already filled)');
        continue;
      }
      if (input.tagName === 'INPUT' && input.type === 'checkbox') {
        filled.push(labelText.slice(0, 40) + ' (checkbox - handled separately)');
        continue;
      }
      if (input.tagName === 'INPUT' && input.value.length > 0) {
        filled.push(labelText.slice(0, 40) + ' (already filled)');
        continue;
      }

      // Map common required fields
      const answers = {
        'name': cv.name,
        'email': cv.email,
        'phone': cv.phone,
        'linkedin': cv.linkedin,
        'github': cv.github,
        'website': cv.portfolio,
        'portfolio': cv.portfolio,
        'resume': cv.portfolio || cv.github, // can't upload file, provide link
        'cover': `Dear Hiring Manager,\n\nI'm excited about the ${jobTitle} role at ${jobCompany}. With ${cv.yearsExperience} years of experience in ${cv.skills.slice(0, 3).join(', ')}, I believe I can make a significant impact.\n\n${cv.highlights[0] ? `For example, ${cv.highlights[0]}.` : ''}\n\nI'm passionate about building scalable products in fast-paced startup environments and would love to contribute to ${jobCompany}'s mission.\n\nBest regards,\n${cv.name}`,
        'message': `Dear Hiring Manager,\n\nI'm excited about the ${jobTitle} role at ${jobCompany}. With ${cv.yearsExperience} years of experience in ${cv.skills.slice(0, 3).join(', ')}, I believe I can make a significant impact.\n\nI'm passionate about building scalable products in fast-paced startup environments.\n\nBest regards,\n${cv.name}`,
        'why': `I'm excited about ${jobCompany}'s innovative work. My background in ${cv.skills.slice(0, 3).join(', ')} with ${cv.yearsExperience} years of experience aligns well with this role.`,
        'interest': `I'm drawn to ${jobCompany}'s mission and believe my skills in ${cv.skills.slice(0, 3).join(', ')} can make a real impact.`,
        'experience': `I'm a ${cv.currentRole} with ${cv.yearsExperience} years of experience at ${cv.company}. My core skills include ${cv.skills.slice(0, 5).join(', ')}.`,
        'salary': 'Competitive with market rate — open to discussion.',
        'compensation': 'Competitive with market rate — open to discussion.',
        'start': `Available to start within ${cv.noticePeriod}.`,
        'available': `Available to start within ${cv.noticePeriod}.`,
        'notice': `Available to start within ${cv.noticePeriod}.`,
        'remote': cv.relocate === 'Yes' ? 'Open to remote work or relocation.' : 'Prefer remote work.',
        'location': `Currently based in ${cv.location}. ${cv.relocate === 'Yes' ? 'Open to relocation.' : ''}`,
        'relocate': `Yes, I am open to relocating for this role. I am currently based in ${cv.location}.`,
        'authorization': cv.workAuth || 'Authorized to work in the United States',
        'visa': cv.workAuth || 'Authorized to work in the United States',
        'sponsorship': 'No sponsorship required.',
        'work authorization': cv.workAuth || 'Authorized to work in the United States',
      };

      let filled_answer = false;
      for (const [key, answer] of Object.entries(answers)) {
        if (labelTextLower.includes(key)) {
          const setter = Object.getOwnPropertyDescriptor(
            input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            'value'
          )?.set;
          if (setter) setter.call(input, answer);
          else input.value = answer;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          filled.push(labelText.slice(0, 40) + ' -> mapped');
          filled_answer = true;
          break;
        }
      }

      if (!filled_answer) {
        skipped.push(labelText.slice(0, 60));
      }
    }

    return { filled, skipped };
  }, { cv: CV, jobTitle: job.title, jobCompany: job.company });

  return result;
}

// ── Apply to a single job ───────────────────────────────────
async function applyToJob(page, job, state) {
  if (state.seen.includes(job.slug)) {
    log(`  ⏭ already seen: ${job.company} — skipping`);
    return false;
  }

  log(`Opening: ${job.company} — ${job.title}`);
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000 + Math.random() * 2000);

    // ── Experience check: read metadata section for "X+ years" ──
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
    const requiredYears = parseExperienceYears(pageText);
    if (requiredYears !== null && requiredYears > MAX_ALLOWED_YEARS) {
      log(`  🚫 requires ${requiredYears}+ years (you have ${USER_EXPERIENCE}) — skipping`);
      state.seen.push(job.slug);
      return false;
    }
    if (requiredYears !== null) {
      log(`  ✓ experience OK: requires ${requiredYears}+ years`);
    }

    // Find and click the apply/contact button
    const clicked = await page.evaluate(() => {
      const btns = document.querySelectorAll('a, button');
      for (const btn of btns) {
        const t = (btn.textContent || '').toLowerCase().trim();
        if (t.includes('apply') || t.includes('contact') || t.includes('reach out')) {
          if (btn.getClientRects().length > 0) {
            btn.click();
            return t;
          }
        }
      }
      return null;
    });

    if (!clicked) {
      log('  ⚠ no apply button found — skipping');
      return false;
    }
    log(`  clicked: "${clicked}"`);
    await page.waitForTimeout(2000);

    // Fill basic fields
    await fillByLabel(page, 'name', CV.name);
    await fillByLabel(page, 'email', CV.email);
    await fillByLabel(page, 'phone', CV.phone);
    await fillByLabel(page, 'linkedin', CV.linkedin);
    await fillByLabel(page, 'github', CV.github);
    await fillByLabel(page, 'website', CV.portfolio);

    // Fill cover letter / message
    const coverLetter = `Dear Hiring Manager,

I'm excited about the ${job.title} role at ${job.company}. With ${CV.yearsExperience} years of experience in ${CV.skills.slice(0, 3).join(', ')}, I believe I can make a significant impact.

${CV.highlights[0] ? `For example, ${CV.highlights[0]}.` : ''}

I'm passionate about building scalable products in fast-paced startup environments and would love to contribute to ${job.company}'s mission.

Best regards,
${CV.name}`;

    await fillByLabel(page, 'cover', coverLetter)
      || await fillByLabel(page, 'message', coverLetter);

    // Fill work authorization checkbox
    const authResult = await fillWorkAuth(page);
    if (authResult) log(`  ✓ work auth: ${authResult}`);

    // Detect and fill all required fields
    const reqResult = await fillRequiredFields(page, job);
    if (reqResult.filled.length > 0) {
      log(`  ✓ filled ${reqResult.filled.length} required fields`);
    }
    if (reqResult.skipped.length > 0) {
      log(`  ⚠ ${reqResult.skipped.length} required fields unmatched: ${reqResult.skipped.join(', ')}`);

      // Try Gemini for unmatched required fields
      if (geminiKey && reqResult.skipped.length > 0) {
        for (const fieldLabel of reqResult.skipped) {
          const answer = await askGemini(fieldLabel);
          if (answer) {
            await fillByLabel(page, fieldLabel.split(' ->')[0], answer);
            log(`  🤖 Gemini answered: "${fieldLabel.slice(0, 40)}"`);
          }
        }
      }
    }

    // Check if all required fields are filled
    const unfilledRequired = await page.evaluate(() => {
      const allLabels = [...document.querySelectorAll('label, p, span, div')];
      const requiredLabels = allLabels.filter(l => {
        const text = l.textContent || '';
        return text.includes('*') && text.length > 3 && text.length < 200;
      });

      const unfilled = [];
      for (const label of requiredLabels) {
        const text = label.textContent.trim().replace(/\*/g, '').trim().toLowerCase();
        // Skip non-input required labels (like authorization section headers)
        if (text.includes('authorized') || text.includes('sponsorship') || text.includes('relocating')) continue;

        const forId = label.getAttribute('for');
        let input = forId ? document.getElementById(forId) : null;
        if (!input) {
          const group = label.closest('div, .field, .form-group') || label.parentElement;
          input = group?.querySelector('input:not([type="hidden"]):not([type="file"]), textarea, select');
        }
        if (!input) continue;

        if (input.tagName === 'TEXTAREA' && input.value.length < 10) {
          unfilled.push(label.textContent.trim().replace(/\*/g, '').trim().slice(0, 40));
        }
        if (input.tagName === 'INPUT' && input.type !== 'checkbox' && input.value.length === 0) {
          unfilled.push(label.textContent.trim().replace(/\*/g, '').trim().slice(0, 40));
        }
      }
      return unfilled;
    });

    if (unfilledRequired.length > 0) {
      log(`  ⚠ cannot fill required fields — skipping: ${unfilledRequired.join(', ')}`);
      return false;
    }

    await page.waitForTimeout(1000);

    if (DRY_RUN) {
      log(`  🔍 DRY_RUN — would submit for ${job.title} at ${job.company}`);
      state.seen.push(job.slug);
      return true;
    }

    // Submit
    const submitted = await page.evaluate(() => {
      const btns = document.querySelectorAll('button[type="submit"], input[type="submit"], button');
      for (const btn of btns) {
        const t = (btn.textContent || '').toLowerCase().trim();
        if (t.includes('submit') || t.includes('send') || t.includes('apply') || t.includes('contact')) {
          btn.click();
          return t;
        }
      }
      return null;
    });

    if (submitted) {
      log(`  ✓ submitted for ${job.title} at ${job.company}`);
      state.seen.push(job.slug);
      return true;
    }

    log('  ⚠ no submit button found');
    return false;
  } catch (err) {
    log(`  ✗ error: ${err.message}`);
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────
async function run() {
  const state = loadState();
  const remaining = MAX_APPLICATIONS - state.count;
  if (remaining <= 0) {
    log(`Daily cap reached (${state.count}/${MAX_APPLICATIONS}). Done.`);
    return;
  }

  log(`Starting. mode=${DRY_RUN ? 'DRY_RUN' : 'LIVE'} target=${remaining} applications, remote_only=${REMOTE_ONLY}`);

  const context = await launchBrowser();
  const page = context.pages()[0] || await context.newPage();

  const jobs = await fetchJobs(page);
  if (jobs.length === 0) {
    log('No matching jobs found. Done.');
    await context.close().catch(() => { });
    return;
  }

  log(`Processing ${jobs.length} jobs...`);

  page.on('console', (msg) => {
    const t = msg.text();
    if (t.startsWith('[auto-apply]')) log(t);
  });

  let appliedCount = 0;

  for (const job of jobs) {
    if (appliedCount >= remaining) {
      log(`Daily cap reached. Stopping.`);
      break;
    }

    const success = await applyToJob(page, job, state);
    if (success) {
      appliedCount++;
      log(`==> ${appliedCount}/${remaining} this run`);
      saveState(state);
    }

    if (appliedCount < remaining) {
      const wait = 60_000 + Math.random() * 90_000;
      log(`Waiting ${Math.round(wait / 1000)}s...`);
      await page.waitForTimeout(wait);
    }
  }

  state.count += appliedCount;
  saveState(state);
  log(`Run complete. Applied to ${appliedCount} jobs. Total today: ${state.count}/${MAX_APPLICATIONS}`);

  if (!DRY_RUN && appliedCount > 0) {
    logToCSV({ role: 'YC Jobs', company: 'Various', url: 'https://www.workatastartup.com/jobs', skills: CV.skills.slice(0, 5), desc: `Applied to ${appliedCount} jobs` });
  }

  await context.close().catch(() => { });
  log('Browser closed.');
}

// ── Entry ────────────────────────────────────────────────────
if (process.argv[3] === 'login') {
  loginFlow().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
} else {
  run().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
}
