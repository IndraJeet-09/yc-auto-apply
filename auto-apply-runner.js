#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { CV, geminiKey } = require('./config');

// ── CLI args ─────────────────────────────────────────────────
const mode = process.argv.includes('--live') ? 'LIVE' : 'DRY_RUN';
const DRY_RUN = mode === 'DRY_RUN';
const FORCE_MODE = process.argv.includes('--force');
const TEST_JOB_URL = process.argv.includes('--test-job')
  ? process.argv[process.argv.indexOf('--test-job') + 1]
  : null;

const YC_WEEKLY_LIMIT = 5;
const MAX_RUNTIME_MS = 100 * 60 * 1000;

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

// ── State (weekly tracking) ──────────────────────────────────
function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now);
  monday.setDate(diff);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0];
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      const currentWeek = getWeekStart();
      if (s.weekStart === currentWeek) return s;
      return {
        weekStart: currentWeek,
        weeklyCount: 0,
        appliedJobs: s.appliedJobs || [],
        seen: [],
      };
    }
  } catch { }
  return {
    weekStart: getWeekStart(),
    weeklyCount: 0,
    appliedJobs: [],
    seen: [],
  };
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function hasAppliedToJob(state, jobId) {
  return state.appliedJobs.some(j => j.id === jobId);
}

function markApplied(state, job) {
  state.appliedJobs.push({
    id: job.slug,
    company: job.company,
    title: job.title,
    appliedAt: new Date().toISOString(),
  });
  state.weeklyCount++;
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

// ── Companies URL ────────────────────────────────────────────
const COMPANIES_URL = 'https://www.workatastartup.com/companies?demographic=any&hasEquity=any&hasSalary=any&industry=any&interviewProcess=any&jobType=any&layout=list-compact&minExperience=0&minExperience=1&remote=only&role=eng&role_type=fs&role_type=be&role_type=fe&role_type=embedded&role_type=data_sci&sortBy=created_desc&tab=any&usVisaNotRequired=any';

// ── Experience filtering ─────────────────────────────────────
const USER_EXPERIENCE = parseInt(CV.yearsExperience || '0', 10);
const MAX_ALLOWED_YEARS = USER_EXPERIENCE + 1;

function parseExperienceYears(pageText) {
  const match = pageText.match(/(\d+)\+?\s*(?:years?|yrs?)/i);
  if (match) return parseInt(match[1], 10);
  return null;
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

// ── Job scraping from companies page DOM ─────────────────────
async function scrapeJobsFromPage(page) {
  return page.evaluate(() => {
    const jobs = [];
    const jobLinks = document.querySelectorAll('a[href*="/jobs/"]');

    for (const link of jobLinks) {
      const title = link.textContent.trim();
      if (!title || title.length < 3) continue;
      if (title === 'View job') continue;

      const href = link.getAttribute('href') || '';
      const slugMatch = href.match(/\/jobs\/(\d+)/);
      if (!slugMatch) continue;
      const slug = slugMatch[1];
      const url = href.startsWith('http') ? href : `https://www.workatastartup.com${href}`;

      let company = '';
      let el = link;
      for (let i = 0; i < 15; i++) {
        el = el.parentElement;
        if (!el) break;
        const cls = el.className || '';
        if (cls.includes('bg-beige-lighter') && cls.includes('mb-5')) {
          const lines = el.innerText.split('\n').map(l => l.trim()).filter(Boolean);
          if (lines.length > 0) {
            company = lines[0].replace(/\(.*\)$/, '').trim();
          }
          break;
        }
      }

      jobs.push({ title, company, url, slug });
    }
    return jobs;
  });
}

async function fetchJobs(page) {
  log('Fetching companies from filtered URL...');

  await page.goto(COMPANIES_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(4000);

  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(1500);
    log(`  scroll ${i + 1}/10`);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1000);

  const allJobs = await scrapeJobsFromPage(page);
  log(`  scraped ${allJobs.length} job links from companies page`);

  const seen = new Set();
  const unique = allJobs.filter(j => {
    if (seen.has(j.slug)) return false;
    seen.add(j.slug);
    return true;
  });

  log(`Found ${unique.length} unique jobs to apply`);
  return unique;
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
  await page.goto(COMPANIES_URL, { waitUntil: 'domcontentloaded' });
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

    const modal = document.querySelector(
      '[role="dialog"], .modal, [data-modal], [data-controller*="modal"], [class*="modal"]'
    ) || document;

    const labels = modal.querySelectorAll('label, [role="label"], span, p');
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
  return page.evaluate(() => {
    const modal = document.querySelector(
      '[role="dialog"], .modal, [data-modal], [data-controller*="modal"], [class*="modal"]'
    ) || document;

    const labels = [...modal.querySelectorAll('label')];
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
  });
}

// ── Detect and fill all required fields ──────────────────────
async function fillRequiredFields(page, job) {
  const result = await page.evaluate(({ cv, jobTitle, jobCompany }) => {
    const filled = [];
    const skipped = [];

    const modal = document.querySelector(
      '[role="dialog"], .modal, [data-modal], [data-controller*="modal"], [class*="modal"]'
    ) || document;

    const allLabels = [...modal.querySelectorAll('label, p, span, div')];
    const requiredLabels = allLabels.filter(l => {
      const text = l.textContent || '';
      return text.includes('*') && text.length > 3 && text.length < 200;
    });

    for (const label of requiredLabels) {
      const labelText = label.textContent.trim().replace(/\*/g, '').trim();
      const labelTextLower = labelText.toLowerCase();

      const forId = label.getAttribute('for');
      let input = forId ? document.getElementById(forId) : null;
      if (!input) {
        const group = label.closest('div, .field, .form-group') || label.parentElement;
        input = group?.querySelector('input:not([type="hidden"]):not([type="file"]), textarea, select');
      }
      if (!input) continue;

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

      const answers = {
        'name': cv.name,
        'email': cv.email,
        'phone': cv.phone,
        'linkedin': cv.linkedin,
        'github': cv.github,
        'website': cv.portfolio,
        'portfolio': cv.portfolio,
        'resume': cv.portfolio || cv.github,
        'cover': `Dear Hiring Manager,\n\nI'm excited about the ${jobTitle} role at ${jobCompany}. With ${cv.yearsExperience} years of experience in ${cv.skills.slice(0, 3).join(', ')}, I believe I can make a significant impact.\n\n${cv.highlights[0] ? `For example, ${cv.highlights[0]}.` : ''}\n\nI'm passionate about building scalable products in fast-paced startup environments and would love to contribute to ${jobCompany}'s mission.\n\nBest regards,\n${cv.name}`,
        'message': `Dear Hiring Manager,\n\nI'm excited about the ${jobTitle} role at ${jobCompany}. With ${cv.yearsExperience} years of experience in ${cv.skills.slice(0, 3).join(', ')}, I believe I can make a significant impact.\n\nI'm passionate about building scalable products in fast-paced startup environments.\n\nBest regards,\n${cv.name}`,
        'why': `I'm excited about ${jobCompany}'s innovative work. My background in ${cv.skills.slice(0, 3).join(', ')} with ${cv.yearsExperience} years of experience aligns well with this role.`,
        'interest': `I'm drawn to ${jobCompany}'s mission and believe my skills in ${cv.skills.slice(0, 3).join(', ')} can make a real impact.`,
        'experience': `I'm a ${cv.currentRole} with ${cv.yearsExperience} years of experience at ${cv.company}. My core skills include ${cv.skills.slice(0, 5).join(', ')}.`,
        'salary': 'Competitive with market rate -- open to discussion.',
        'compensation': 'Competitive with market rate -- open to discussion.',
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
  if (hasAppliedToJob(state, job.slug)) {
    log(`  already applied this week (id: ${job.slug}) -- skipping`);
    return false;
  }

  if (state.seen.includes(job.slug)) {
    log(`  already seen this run -- skipping`);
    return false;
  }

  log(`Opening: ${job.company} -- ${job.title}`);
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000 + Math.random() * 2000);

    // ── Experience check ──
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
    const requiredYears = parseExperienceYears(pageText);
    if (requiredYears !== null && requiredYears > MAX_ALLOWED_YEARS) {
      log(`  requires ${requiredYears}+ years (you have ${USER_EXPERIENCE}) -- skipping`);
      state.seen.push(job.slug);
      return false;
    }
    if (requiredYears !== null) {
      log(`  experience OK: requires ${requiredYears}+ years`);
    }

    // ── Check if already applied ──
    const alreadyApplied = await page.evaluate(() => {
      const allElements = document.querySelectorAll('a, button, span, div');
      for (const el of allElements) {
        const t = (el.textContent || '').trim().toLowerCase();
        if (t === 'applied' || t === 'applied \u2713' || t === 'applied \u2714') {
          if (el.getClientRects().length > 0) return true;
        }
      }
      return false;
    });
    if (alreadyApplied) {
      log(`  already applied -- skipping`);
      state.seen.push(job.slug);
      return false;
    }

    // ── Find and click apply button ──
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('a, button')];

      const isMailto = (el) => {
        const href = el.getAttribute('href') || '';
        return href.startsWith('mailto:');
      };

      const isVisible = (el) => el.getClientRects().length > 0;

      // Pass 1: find "apply" button (not mailto)
      for (const btn of btns) {
        const t = (btn.textContent || '').toLowerCase().trim();
        if (t.includes('apply') && !isMailto(btn) && isVisible(btn)) {
          btn.click();
          return { text: t, type: 'apply' };
        }
      }

      // Pass 2: find "submit" button (not mailto)
      for (const btn of btns) {
        const t = (btn.textContent || '').toLowerCase().trim();
        if (t.includes('submit') && !isMailto(btn) && isVisible(btn)) {
          btn.click();
          return { text: t, type: 'submit' };
        }
      }

      // Pass 3: find "contact" button only if NOT a mailto link
      for (const btn of btns) {
        const t = (btn.textContent || '').toLowerCase().trim();
        if ((t.includes('contact') || t.includes('reach out')) && !isMailto(btn) && isVisible(btn)) {
          btn.click();
          return { text: t, type: 'contact' };
        }
      }

      // Pass 4: find external ATS links
      for (const btn of btns) {
        const href = (btn.getAttribute('href') || '').toLowerCase();
        const t = (btn.textContent || '').toLowerCase().trim();
        if (isVisible(btn) && (href.includes('typeform') || href.includes('lever') || href.includes('greenhouse') || href.includes('ashby') || href.includes('apply') || href.includes('jobs/apply'))) {
          btn.click();
          return { text: t || href.slice(0, 50), type: 'external-form' };
        }
      }

      // Pass 5: find Stimulus modal buttons
      for (const btn of btns) {
        const controller = btn.getAttribute('data-controller') || '';
        const action = btn.getAttribute('data-action') || '';
        if (isVisible(btn) && (controller.includes('modal') || action.includes('modal'))) {
          btn.click();
          return { text: (btn.textContent || '').trim().slice(0, 50), type: 'stimulus-modal' };
        }
      }

      return { text: null, type: null };
    });

    if (!clicked || !clicked.text) {
      log('  no apply button found -- skipping');
      return false;
    }
    log(`  clicked: "${clicked.text}" (type: ${clicked.type})`);

    if (clicked.type === 'external-form') {
      log('  waiting for external form page to load...');
      try {
        await page.waitForTimeout(5000);
      } catch (e) {
        log(`  navigation interrupted: ${e.message}`);
        return false;
      }
    } else {
      // Wait for modal/form to appear
      try {
        await page.waitForSelector(
          '[role="dialog"], .modal, [data-modal], [data-controller*="modal"], [class*="modal"]',
          { timeout: 3000 }
        ).catch(() => {});
        const hasModal = await page.evaluate(() => {
          return !!document.querySelector(
            '[role="dialog"], .modal, [data-modal], [data-controller*="modal"], [class*="modal"]'
          );
        });
        if (hasModal) {
          log('  modal detected after click');
        } else {
          await page.waitForTimeout(1000);
        }
      } catch (e) {
        log(`  page closed after click: ${e.message}`);
        return false;
      }
    }

    // Fill basic fields
    try {
      await fillByLabel(page, 'name', CV.name);
      await fillByLabel(page, 'email', CV.email);
      await fillByLabel(page, 'phone', CV.phone);
      await fillByLabel(page, 'linkedin', CV.linkedin);
      await fillByLabel(page, 'github', CV.github);
      await fillByLabel(page, 'website', CV.portfolio);
    } catch (e) {
      log(`  form filling error (page may have navigated): ${e.message}`);
      return false;
    }

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
    if (authResult) log(`  work auth: ${authResult}`);

    // Detect and fill all required fields
    const reqResult = await fillRequiredFields(page, job);
    if (reqResult.filled.length > 0) {
      log(`  filled ${reqResult.filled.length} required fields`);
    }
    if (reqResult.skipped.length > 0) {
      log(`  ${reqResult.skipped.length} required fields unmatched: ${reqResult.skipped.join(', ')}`);

      if (geminiKey && reqResult.skipped.length > 0) {
        for (const fieldLabel of reqResult.skipped) {
          const answer = await askGemini(fieldLabel);
          if (answer) {
            await fillByLabel(page, fieldLabel.split(' ->')[0], answer);
            log(`  Gemini answered: "${fieldLabel.slice(0, 40)}"`);
          }
        }
      }
    }

    // Check if all required fields are filled
    const unfilledRequired = await page.evaluate(() => {
      const modal = document.querySelector(
        '[role="dialog"], .modal, [data-modal], [data-controller*="modal"], [class*="modal"]'
      ) || document;

      const allLabels = [...modal.querySelectorAll('label, p, span, div')];
      const requiredLabels = allLabels.filter(l => {
        const text = l.textContent || '';
        return text.includes('*') && text.length > 3 && text.length < 200;
      });

      const unfilled = [];
      for (const label of requiredLabels) {
        const text = label.textContent.trim().replace(/\*/g, '').trim().toLowerCase();
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
      log(`  cannot fill required fields -- skipping: ${unfilledRequired.join(', ')}`);
      return false;
    }

    await page.waitForTimeout(1000);

    if (DRY_RUN) {
      log(`  DRY_RUN -- would submit for ${job.title} at ${job.company}`);
      state.seen.push(job.slug);
      return true;
    }

    // Submit
    const submitted = await page.evaluate(() => {
      const isMailto = (el) => (el.getAttribute('href') || '').startsWith('mailto:');
      const isVisible = (el) => el.getClientRects().length > 0;

      const modal = document.querySelector(
        '[role="dialog"], .modal, [data-modal], [data-controller*="modal"], [class*="modal"]'
      ) || document;

      const btns = [...modal.querySelectorAll('button[type="submit"], input[type="submit"], button, a')];
      const allBtns = [];

      for (const btn of btns) {
        const t = (btn.textContent || '').toLowerCase().trim();
        const vis = isVisible(btn);
        allBtns.push({ tag: btn.tagName, text: t.slice(0, 50), type: btn.type || '', visible: vis });

        if (!vis || isMailto(btn)) continue;

        if (t.includes('submit') || t.includes('send') || t.includes('apply now') || t.includes('submit application')) {
          btn.click();
          return { clicked: t, allBtns };
        }
      }

      for (const btn of btns) {
        if (btn.tagName === 'BUTTON' && btn.type === 'submit' && isVisible(btn) && !isMailto(btn)) {
          const t = (btn.textContent || '').toLowerCase().trim();
          btn.click();
          return { clicked: t || 'submit', allBtns };
        }
      }

      return { clicked: null, allBtns };
    });

    if (submitted.clicked) {
      log(`  submitted for ${job.title} at ${job.company}`);
      state.seen.push(job.slug);
      try {
        await page.goto(COMPANIES_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e) {
        log(`  could not navigate back: ${e.message}`);
      }
      return true;
    }

    log('  no submit button found');
    return false;
  } catch (err) {
    log(`  error: ${err.message}`);
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────
async function run() {
  const state = loadState();

  if (!FORCE_MODE && state.weeklyCount >= YC_WEEKLY_LIMIT) {
    log(`Weekly cap reached (${state.weeklyCount}/${YC_WEEKLY_LIMIT}). Done.`);
    return;
  }

  const remaining = YC_WEEKLY_LIMIT - state.weeklyCount;
  log(`Starting. mode=${DRY_RUN ? 'DRY_RUN' : 'LIVE'} ${remaining} applications remaining this week`);

  const context = await launchBrowser();
  const page = context.pages()[0] || await context.newPage();

  let jobs;
  if (TEST_JOB_URL) {
    const slugMatch = TEST_JOB_URL.match(/\/jobs\/(\d+)/);
    jobs = [{
      title: 'Test Job',
      company: 'Test Company',
      url: TEST_JOB_URL,
      slug: slugMatch ? slugMatch[1] : 'test',
    }];
    log(`Test mode: applying to ${TEST_JOB_URL}`);
  } else {
    jobs = await fetchJobs(page);
    if (jobs.length === 0) {
      log('No matching jobs found. Done.');
      await context.close().catch(() => { });
      return;
    }
  }

  log(`Processing ${jobs.length} jobs...`);

  page.on('console', (msg) => {
    const t = msg.text();
    if (t.startsWith('[auto-apply]')) log(t);
  });

  let appliedCount = 0;

  for (const job of jobs) {
    if (!FORCE_MODE && state.weeklyCount >= YC_WEEKLY_LIMIT) {
      log(`Weekly cap reached (${state.weeklyCount}/${YC_WEEKLY_LIMIT}). Stopping.`);
      break;
    }

    const success = await applyToJob(page, job, state);
    if (success) {
      appliedCount++;
      markApplied(state, job);
      log(`==> ${appliedCount} applied this run | ${state.weeklyCount}/${YC_WEEKLY_LIMIT} this week`);
      saveState(state);
    }

    if (appliedCount < remaining) {
      const wait = 60_000 + Math.random() * 90_000;
      log(`Waiting ${Math.round(wait / 1000)}s...`);
      try {
        await page.waitForTimeout(wait);
      } catch (e) {
        log(`  wait interrupted: ${e.message}`);
        break;
      }
    }
  }

  saveState(state);
  log(`Run complete. Applied to ${appliedCount} jobs. Weekly total: ${state.weeklyCount}/${YC_WEEKLY_LIMIT}`);

  if (!DRY_RUN && appliedCount > 0) {
    logToCSV({ role: 'YC Jobs', company: 'Various', url: COMPANIES_URL, skills: CV.skills.slice(0, 5), desc: `Applied to ${appliedCount} jobs` });
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
