(async function ycAutoApply() {
  'use strict';

  // ── Configuration ──────────────────────────────────────────
  const DRY_RUN = window.__YC_DRY_RUN !== undefined ? window.__YC_DRY_RUN : true;
  const MAX_APPLICATIONS = window.__YC_MAX_APPLICATIONS || 50;
  const MIN_DELAY_MS = 60_000;
  const MAX_DELAY_MS = 150_000;

  const cfg = window.__APPLY_CONFIG || {};
  const CV = {
    name:            cfg.name            || '',
    email:           cfg.email           || '',
    phone:           cfg.phone           || '',
    location:        cfg.location        || '',
    currentRole:     cfg.currentRole     || '',
    company:         cfg.company         || '',
    education:       cfg.education       || '',
    yearsExperience: cfg.yearsExperience || '',
    skills:          cfg.skills          || [],
    highlights:      cfg.highlights      || [],
    noticePeriod:    cfg.noticePeriod    || '30 days',
    workAuth:        cfg.workAuth        || 'Authorized',
    relocate:        cfg.relocate        || 'Yes',
    github:          cfg.github          || '',
    linkedin:        cfg.linkedin        || '',
    portfolio:       cfg.portfolio       || '',
  };

  const TITLE_KEYWORDS = [
    'full stack', 'fullstack', 'full-stack',
    'backend', 'back-end', 'back end',
    'frontend', 'front-end', 'front end',
    'software engineer', 'software developer',
    'react', 'node', 'nodejs', 'node.js',
    'python', 'typescript', 'javascript',
    'ai engineer', 'ml engineer', 'machine learning',
    'devops', 'sre', 'infrastructure',
    'mobile', 'ios', 'android',
    'data engineer', 'data scientist',
    'founding engineer', 'staff engineer',
  ];

  const TITLE_BLOCKLIST = [
    'senior', 'staff', 'principal', 'director', 'vp', 'head of',
    'manager', 'lead', 'architect',
    'intern', 'internship', 'trainee',
    '.net', 'c#', 'java ', 'ruby', 'php',
    'devrel', 'developer relations',
    'sales', 'marketing', 'growth', 'content',
    'design', 'ux', 'ui',
    'hr', 'recruiter', 'talent',
    'finance', 'accounting', 'legal',
    'executive', 'ceo', 'cto', 'coo',
  ];

  const QNA = {
    /why.*(interest|excited|join|apply)/i:
      `I'm excited about ${'{company}'} because of the innovative work you're doing in the space. With my background in ${CV.skills.slice(0, 3).join(', ')}, I believe I can make a significant impact on your engineering team and help build products that scale.`,
    /what.*(bring|value|contribute)/i:
      `I bring ${CV.yearsExperience} years of experience building scalable applications. At ${CV.company}, I ${CV.highlights[0] || 'led the development of critical production systems'}. I'm passionate about shipping high-quality code and working in fast-paced startup environments.`,
    /experience|background|tell me about/i:
      `I'm a ${CV.currentRole} with ${CV.yearsExperience} years of experience. Currently at ${CV.company}, where I ${CV.highlights[0] || 'build and maintain production systems'}. My core skills include ${CV.skills.slice(0, 5).join(', ')}.`,
    /salary|compensation|expectation|pay/i:
      `My expected compensation is competitive with the market rate for this role. I'm open to discussing the details further in the interview process.`,
    /start|available|join|notice/i:
      `I can start within ${CV.noticePeriod}. I'm flexible and can discuss an earlier start date if needed.`,
    /remote|location|relocate|onsite/i:
      `${CV.relocate === 'Yes' ? 'I am open to relocating or working remotely.' : 'I prefer remote work but am open to hybrid arrangements.'} I'm currently based in ${CV.location}.`,
    /visa|sponsor|work auth/i:
      `${CV.workAuth}. ${CV.relocate === 'Yes' ? 'I am willing to relocate.' : ''}`,
    /website|portfolio|github|link/i:
      `You can find my work at ${CV.portfolio || CV.github || 'my portfolio'}. ${CV.github ? `My GitHub: ${CV.github}` : ''} ${CV.linkedin ? `LinkedIn: ${CV.linkedin}` : ''}`,
    /cover letter|why this/i:
      `I'm passionate about building products that make a difference. ${CV.highlights[0] ? `For example, ${CV.highlights[0]}.` : ''} I believe my skills in ${CV.skills.slice(0, 3).join(', ')} align well with what ${'{company}'} is building.`,
    /referral|how did you/i:
      `I found this role on Y Combinator's Work at a Startup platform and was immediately drawn to the opportunity.`,
  };

  // ── Helpers ─────────────────────────────────────────────────
  function log(msg) {
    console.log(`[auto-apply] ${msg}`);
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function randomDelay() {
    return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
  }

  function matchesTitle(title) {
    const t = title.toLowerCase();
    if (TITLE_BLOCKLIST.some(b => t.includes(b))) return false;
    return TITLE_KEYWORDS.some(k => t.includes(k));
  }

  function matchSkills(jobText) {
    const text = jobText.toLowerCase();
    return CV.skills.filter(s => text.includes(s.toLowerCase()));
  }

  function answerQuestion(question) {
    const q = question.toLowerCase();
    for (const [pattern, answer] of Object.entries(QNA)) {
      if (pattern.test(q)) {
        return answer.replace(/{company}/g, window.__YC_COMPANY_NAME || 'your company');
      }
    }
    return null;
  }

  function generateCoverLetter(company, role) {
    return `Dear Hiring Manager,

I am writing to express my strong interest in the ${role} position at ${company}. With ${CV.yearsExperience} years of experience in software development and a passion for building scalable, impactful products, I am excited about the opportunity to contribute to your team.

${CV.highlights[0] ? `For example, ${CV.highlights[0]}.` : ''}

My technical expertise spans ${CV.skills.slice(0, 5).join(', ')}, and I thrive in fast-paced startup environments where I can make a direct impact. I am particularly drawn to ${company}'s mission and believe my background aligns well with your needs.

I would welcome the opportunity to discuss how I can contribute to ${company}'s continued success.

Best regards,
${CV.name}`;
  }

  // ── Form Filling ───────────────────────────────────────────
  function setReactInput(el, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    if (nativeSetter) nativeSetter.call(el, value);
    else el.value = value;

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function setReactTextarea(el, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    if (nativeSetter) nativeSetter.call(el, value);
    else el.value = value;

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  async function fillField(container, labelText, value) {
    const labels = container.querySelectorAll('label, [role="label"], span');
    for (const label of labels) {
      const text = label.textContent.toLowerCase();
      if (text.includes(labelText.toLowerCase())) {
        const fieldId = label.getAttribute('for');
        let input = fieldId
          ? container.querySelector(`#${CSS.escape(fieldId)}`)
          : label.closest('div')?.querySelector('input, textarea, select');

        if (!input) {
          const parent = label.parentElement;
          input = parent?.querySelector('input, textarea, select');
        }

        if (input) {
          if (input.tagName === 'TEXTAREA') setReactTextarea(input, value);
          else if (input.tagName === 'SELECT') {
            const option = Array.from(input.options).find(
              o => o.text.toLowerCase().includes(value.toLowerCase())
            );
            if (option) {
              input.value = option.value;
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } else setReactInput(input, value);

          log(`  ✓ filled "${labelText}"`);
          return true;
        }
      }
    }
    return false;
  }

  // ── Main Application Flow ──────────────────────────────────
  let appliedCount = 0;
  const appliedJobs = new Set();

  async function applyToJob(jobUrl, company, role) {
    if (appliedJobs.has(jobUrl)) {
      log(`  ⏭ already applied to ${company} — skipping`);
      return false;
    }

    log(`Opening: ${company} — ${role}`);
    window.__YC_COMPANY_NAME = company;

    try {
      window.location.href = jobUrl;
      await sleep(3000 + Math.random() * 2000);

      const applyBtn = document.querySelector(
        'a[href*="contact"], button:has-text("Apply"), a:has-text("Apply"), ' +
        '[data-controller="modal"] button, a[href*="apply"]'
      );

      if (!applyBtn) {
        const allBtns = document.querySelectorAll('a, button');
        for (const btn of allBtns) {
          const t = btn.textContent.toLowerCase().trim();
          if (t.includes('apply') || t.includes('contact') || t.includes('reach out')) {
            btn.click();
            log('  clicked apply button');
            await sleep(2000);
            break;
          }
        }
      } else {
        applyBtn.click();
        log('  clicked apply button');
        await sleep(2000);
      }

      const modal = document.querySelector(
        '[role="dialog"], .modal, [data-modal], [data-controller*="modal"]'
      ) || document;

      await fillField(modal, 'name', CV.name);
      await fillField(modal, 'email', CV.email);
      await fillField(modal, 'phone', CV.phone);
      await fillField(modal, 'linkedin', CV.linkedin);
      await fillField(modal, 'github', CV.github);
      await fillField(modal, 'website', CV.portfolio);
      await fillField(modal, 'portfolio', CV.portfolio);

      const coverLetterText = generateCoverLetter(company, role);
      const clFilled = await fillField(modal, 'cover', coverLetterText)
        || await fillField(modal, 'message', coverLetterText)
        || await fillField(modal, 'message', coverLetterText);

      const questions = modal.querySelectorAll(
        'label, [role="label"], .form-group, .field'
      );

      for (const qEl of questions) {
        const qText = qEl.textContent || '';
        if (qText.length < 10) continue;

        const answer = answerQuestion(qText);
        if (answer) {
          const parent = qEl.closest('.form-group, .field, div');
          if (parent) {
            const textarea = parent.querySelector('textarea');
            const input = parent.querySelector('input:not([type="hidden"]):not([type="file"])');
            const target = textarea || input;
            if (target) {
              if (textarea) setReactTextarea(textarea, answer);
              else setReactInput(input, answer);
              log(`  ✓ answered: "${qText.slice(0, 50)}..."`);
            }
          }
        }
      }

      await sleep(1000);

      if (DRY_RUN) {
        log(`  🔍 DRY_RUN — would submit application for ${role} at ${company}`);
        appliedJobs.add(jobUrl);
        return true;
      }

      const submitBtn = modal.querySelector(
        'button[type="submit"], input[type="submit"], button:has-text("Submit"), ' +
        'button:has-text("Send"), button:has-text("Apply"), button:has-text("Contact")'
      );

      if (!submitBtn) {
        const allBtns = modal.querySelectorAll('button, input[type="submit"]');
        for (const btn of allBtns) {
          const t = btn.textContent.toLowerCase().trim();
          if (t.includes('submit') || t.includes('send') || t.includes('apply') || t.includes('contact')) {
            btn.click();
            log(`  ✓ submitted application for ${role} at ${company}`);
            appliedJobs.add(jobUrl);
            return true;
          }
        }
        log(`  ⚠ no submit button found — skipping`);
        return false;
      }

      submitBtn.click();
      log(`  ✓ submitted application for ${role} at ${company}`);
      appliedJobs.add(jobUrl);
      return true;

    } catch (err) {
      log(`  ✗ error applying to ${company}: ${err.message}`);
      return false;
    }
  }

  // ── Job Discovery via Algolia ──────────────────────────────
  async function fetchJobsFromAlgolia(page = 0) {
    const appId = '45BWZJ1SGC';
    const apiKey = window.JOBS_GLOBALS?.AlgoliaOpts?.key || '';

    const body = {
      query: '',
      hitsPerPage: 20,
      page,
      facetFilters: [
        ['remote_ok:true'],
      ],
      filters: 'status:published',
    };

    try {
      const resp = await fetch(
        `https://${appId}-dsn.algolia.net/1/indexes/jobs_production/query`,
        {
          method: 'POST',
          headers: {
            'X-Algolia-Application-Id': appId,
            'X-Algolia-API-Key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }
      );

      if (!resp.ok) {
        log(`Algolia API error: ${resp.status}`);
        return [];
      }

      const data = await resp.json();
      return (data.hits || []).map(hit => ({
        title: hit.title || '',
        company: hit.company_name || hit.startup_name || '',
        url: `https://www.workatastartup.com/jobs/${hit.objectID}`,
        remote: hit.remote_ok || false,
        location: hit.location || '',
        salary: hit.salary_min && hit.salary_max
          ? `$${(hit.salary_min / 1000).toFixed(0)}K - $${(hit.salary_max / 1000).toFixed(0)}K`
          : '',
        tags: hit.tag || [],
        roleTypes: hit.role_type || [],
        text: JSON.stringify(hit).toLowerCase(),
      }));
    } catch (err) {
      log(`Algolia fetch error: ${err.message}`);
      return [];
    }
  }

  async function discoverJobs() {
    log('Discovering jobs via Algolia...');
    const allJobs = [];

    for (let page = 0; page < 5; page++) {
      const jobs = await fetchJobsFromAlgolia(page);
      if (jobs.length === 0) break;
      allJobs.push(...jobs);
      log(`  page ${page + 1}: ${jobs.length} jobs fetched`);
      await sleep(500);
    }

    const filtered = allJobs.filter(job => {
      if (!matchesTitle(job.title)) return false;
      const matchedSkills = matchSkills(job.text);
      if (matchedSkills.length === 0) return false;
      return true;
    });

    log(`Found ${filtered.length} matching jobs out of ${allJobs.length} total`);
    return filtered;
  }

  // ── DOM-based job scraping (fallback) ──────────────────────
  async function discoverJobsFromDOM() {
    log('Discovering jobs from page DOM...');
    const cards = document.querySelectorAll(
      '[data-job-card], .job-card, .job-listing, ' +
      'a[href*="/jobs/"], .startup-card'
    );

    const jobs = [];
    for (const card of cards) {
      const titleEl = card.querySelector('h2, h3, .job-title, [class*="title"]');
      const companyEl = card.querySelector('.company-name, [class*="company"], [class*="startup"]');
      const linkEl = card.querySelector('a[href*="/jobs/"]') || card.closest('a[href*="/jobs/"]');

      if (!titleEl || !linkEl) continue;

      const title = titleEl.textContent.trim();
      const company = companyEl?.textContent?.trim() || '';
      const url = linkEl.href.startsWith('http') ? linkEl.href : `https://www.workatastartup.com${linkEl.getAttribute('href')}`;

      jobs.push({
        title,
        company,
        url,
        text: card.textContent.toLowerCase(),
      });
    }

    const filtered = jobs.filter(job => {
      if (!matchesTitle(job.title)) return false;
      return matchSkills(job.text).length > 0;
    });

    log(`DOM discovery: ${filtered.length} matching jobs out of ${jobs.length}`);
    return filtered;
  }

  // ── Supervisor Loop ────────────────────────────────────────
  async function run() {
    log(`Starting. DRY_RUN=${DRY_RUN}, max=${MAX_APPLICATIONS}`);

    let jobs = await discoverJobs();
    if (jobs.length === 0) {
      log('Algolia returned no jobs, falling back to DOM scraping...');
      jobs = await discoverJobsFromDOM();
    }

    if (jobs.length === 0) {
      log('No matching jobs found. Done.');
      return;
    }

    log(`Processing ${jobs.length} jobs...`);

    for (const job of jobs) {
      if (appliedCount >= MAX_APPLICATIONS) {
        log(`Daily cap reached (${MAX_APPLICATIONS}). Stopping.`);
        break;
      }

      const success = await applyToJob(job.url, job.company, job.title);
      if (success) appliedCount++;
      log(`==> ${appliedCount}/${MAX_APPLICATIONS} this run`);

      if (appliedCount < MAX_APPLICATIONS) {
        const wait = randomDelay();
        log(`Waiting ${Math.round(wait / 1000)}s before next application...`);
        await sleep(wait);
      }
    }

    log(`Finished. Applied to ${appliedCount} jobs.`);
    console.log(`[yc-done] Applied to ${appliedCount} jobs`);
  }

  run();
})();
