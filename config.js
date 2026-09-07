const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return {};

  const lines = fs.readFileSync(envPath, 'utf-8')
    .replace(/^\uFEFF/, '')
    .split('\n');

  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const raw = loadEnv();
const get = (key, def = '') => process.env[key] || raw[key] || def;

const highlights = [];
for (let i = 1; i <= 5; i++) {
  const h = get(`HIGHLIGHT_${i}`);
  if (h) highlights.push(h);
}

const skills = get('SKILLS', '').split(',').map(s => s.trim()).filter(Boolean);

const CV = {
  name:             get('NAME'),
  email:            get('EMAIL'),
  phone:            get('PHONE'),
  location:         get('LOCATION'),
  currentRole:      get('CURRENT_ROLE'),
  company:          get('COMPANY'),
  education:        get('EDUCATION'),
  yearsExperience:  get('YEARS_EXPERIENCE'),
  skills,
  highlights,
  noticePeriod:     get('NOTICE_PERIOD', '30 days'),
  currentCtc:       get('CURRENT_CTC'),
  expectedCtc:      get('EXPECTED_CTC'),
  workAuth:         get('WORK_AUTH', 'Authorized'),
  relocate:         get('RELOCATE', 'Yes'),
  github:           get('GITHUB_URL'),
  linkedin:         get('LINKEDIN_URL'),
  portfolio:        get('PORTFOLIO_URL'),
};

const geminiKey = get('GEMINI_KEY');

module.exports = { CV, geminiKey };
