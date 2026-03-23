/**
 * JobScout India — Crawler v7
 * ============================
 * Reads company list from config/companies.json — no hardcoded arrays.
 * Writes data/jobs.json, data/meta.json, data/state.json.
 *
 * Run modes:
 *   node crawler.js              → Full run (respects 24h cooldown per company)
 *   node crawler.js --force      → Force full re-scrape of all companies
 *   node crawler.js --new-only   → Only scrape companies not yet in state.json
 *
 * Sources supported:
 *   greenhouse | lever | ashby | workable | smartrecruiters | eightfold | workday | adzuna_mnc | adzuna_city
 *
 * India Classification (5 layers):
 *   L1 — Explicit India city/state in location → KEEP
 *   L2 — Explicit non-India city/country       → DROP
 *   L3 — Blank/remote + T1/T2 company          → KEEP
 *   L4 — Blank/remote + T3/T4 company          → DROP
 *   L5 — Source is 100% India (SR/EF/WD/AZ)   → KEEP
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

// ── ARGS ──────────────────────────────────────────────────────────────────────
const FORCE    = process.argv.includes('--force');
const NEW_ONLY = process.argv.includes('--new-only');

// ── SECRETS ───────────────────────────────────────────────────────────────────
const ADZUNA_ID   = process.env.ADZUNA_APP_ID  || '';
const ADZUNA_KEY  = process.env.ADZUNA_APP_KEY || '';
const JSEARCH_KEY = process.env.JSEARCH_KEY    || '';

// ── CONFIG PATHS ──────────────────────────────────────────────────────────────
const ROOT         = process.cwd();
const COMPANIES_F  = path.join(ROOT, 'config', 'companies.json');
const STATE_F      = path.join(ROOT, 'data',   'state.json');
const JOBS_F       = path.join(ROOT, 'data',   'jobs.json');
const META_F       = path.join(ROOT, 'data',   'meta.json');

// How long before we re-scrape a company (23h — gives buffer for daily 6am IST run)
const SCRAPE_TTL_MS = 23 * 60 * 60 * 1000;

// ── LOAD CONFIG ───────────────────────────────────────────────────────────────
const CONFIG = JSON.parse(fs.readFileSync(COMPANIES_F, 'utf8'));

// ── LOAD + SAVE STATE ─────────────────────────────────────────────────────────
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_F, 'utf8'));
  } catch {
    return { last_full_run: null, last_run_count: 0, companies: {} };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_F);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_F, JSON.stringify(state, null, 2));
}

function stateKey(method, slug) {
  return `${method}:${slug}`;
}

function shouldScrape(state, method, slug) {
  if (FORCE) return true;
  const key = stateKey(method, slug);
  const entry = state.companies[key];
  if (!entry) return true;                                   // Never scraped
  if (NEW_ONLY) return false;                               // --new-only: skip already-known companies
  const age = Date.now() - new Date(entry.last_scraped).getTime();
  return age > SCRAPE_TTL_MS;                               // Re-scrape if stale
}

function recordState(state, method, slug, count, error = null) {
  const key = stateKey(method, slug);
  const prev = state.companies[key] || {};
  state.companies[key] = {
    last_scraped: new Date().toISOString(),
    last_count: count,
    status: error ? 'error' : count === 0 ? 'empty' : 'ok',
    error: error || null,
    consecutive_errors: error ? (prev.consecutive_errors || 0) + 1 : 0,
  };
}

// ── INDIA CLASSIFICATION ──────────────────────────────────────────────────────
const INDIA_CITIES = [
  'bengaluru','bangalore','mumbai','bombay','delhi','new delhi','gurugram',
  'gurgaon','noida','hyderabad','secunderabad','pune','pimpri','chennai',
  'madras','kolkata','calcutta','ahmedabad','jaipur','surat','lucknow',
  'kochi','cochin','chandigarh','nagpur','bhubaneswar','indore','coimbatore',
  'vadodara','thiruvananthapuram','mysuru','mysore','visakhapatnam','vizag',
];

const INDIA_STATES = [
  'karnataka','maharashtra','telangana','andhra pradesh','tamil nadu',
  'gujarat','rajasthan','uttar pradesh','west bengal','kerala','haryana',
  'punjab','madhya pradesh','odisha','jharkhand','bihar','assam',
];

const NON_INDIA = [
  'united states','usa','u.s.a','new york','san francisco','los angeles',
  'seattle','austin','boston','chicago','denver','atlanta','miami',
  'washington dc','new jersey','california','texas','florida','illinois',
  'london','uk','united kingdom','england','germany','berlin','munich',
  'france','paris','netherlands','amsterdam','sweden','stockholm',
  'canada','toronto','vancouver','montreal','australia','sydney','melbourne',
  'singapore','dubai','uae','japan','tokyo','china','beijing','shanghai',
  'ireland','dublin','spain','madrid','poland','warsaw','czech republic',
  'hungary','romania','ukraine','israel','tel aviv','brazil','mexico',
];

// L5 sources — always India, no classification needed
const TRUSTED_INDIA_SOURCES = new Set(['smartrecruiters','eightfold','workday','adzuna_mnc','adzuna_city']);

function classifyIndia(location, tier, src) {
  if (TRUSTED_INDIA_SOURCES.has(src)) return 'india';
  const loc = (location || '').toLowerCase().trim();
  if (loc.includes('india') || loc === 'in') return 'india';
  if (INDIA_CITIES.some(c => loc.includes(c))) return 'india';
  if (INDIA_STATES.some(s => loc.includes(s))) return 'india';
  if (NON_INDIA.some(c => loc.includes(c))) return 'skip';
  if (!loc || ['remote','global','worldwide','anywhere'].includes(loc)) {
    return (tier === 1 || tier === 2) ? 'india' : 'skip';
  }
  if (tier === 3 || tier === 4) return 'skip';
  return 'india';
}

function detectCity(loc) {
  const l = (loc || '').toLowerCase();
  if (l.includes('bengaluru') || l.includes('bangalore'))               return 'Bengaluru';
  if (l.includes('mumbai')    || l.includes('bombay'))                  return 'Mumbai';
  if (l.includes('delhi')     || l.includes('gurugram') || l.includes('gurgaon') || l.includes('noida')) return 'Delhi NCR';
  if (l.includes('hyderabad') || l.includes('secunderabad'))            return 'Hyderabad';
  if (l.includes('pune')      || l.includes('pimpri'))                  return 'Pune';
  if (l.includes('chennai')   || l.includes('madras'))                  return 'Chennai';
  if (l.includes('kolkata')   || l.includes('calcutta'))                return 'Kolkata';
  if (l.includes('ahmedabad'))                                          return 'Ahmedabad';
  if (l.includes('remote'))                                             return 'Remote';
  return 'India';
}

function detectMode(loc) {
  const l = (loc || '').toLowerCase();
  if (l.includes('remote')) return 'remote';
  if (l.includes('hybrid')) return 'hybrid';
  return 'onsite';
}

function detectSeniority(title) {
  const t = (title || '').toLowerCase();
  if (/\b(vp|vice president|director|head of|chief)\b/.test(t))              return 'director';
  if (/\b(staff|principal|distinguished)\b/.test(t))                         return 'staff';
  if (/\b(senior|sr\.|lead)\b/.test(t))                                      return 'senior';
  if (/\b(junior|jr\.|intern|graduate|fresher|trainee|entry|associate)\b/.test(t)) return 'junior';
  return 'mid';
}

function detectFn(title) {
  const t = (title || '').toLowerCase();
  if (/\b(software engineer|developer|sre|devops|backend|frontend|ios|android|machine learning|data engineer|infrastructure|platform|site reliability|full[- ]?stack|firmware|embedded)\b/.test(t)) return 'engineering';
  if (/\b(product manager|product lead|product owner|associate product)\b/.test(t)) return 'product';
  if (/\b(designer|ux|ui |visual design|product design|interaction design)\b/.test(t)) return 'design';
  if (/\b(data scientist|data analyst|analytics|business intelligence|quantitative|ml engineer|research scientist)\b/.test(t)) return 'data';
  if (/\b(business analyst|business manager|strategy|chief of staff|program manager|consultant|operations)\b/.test(t)) return 'bizops';
  if (/\b(marketing|growth|seo|content|performance marketing|demand gen|brand)\b/.test(t)) return 'marketing';
  if (/\b(sales|account executive|sdr|bdr|business development|revenue|account manager)\b/.test(t)) return 'sales';
  if (/\b(recruiter|hr |people ops|talent acquisition|human resource|hrbp)\b/.test(t)) return 'people';
  if (/\b(security|infosec|appsec|devsecops|cybersecurity)\b/.test(t)) return 'security';
  if (/\b(finance|accounting|financial analyst|controller|fp&a|treasury)\b/.test(t)) return 'finance';
  if (/\b(customer success|support|csm |cx |implementation)\b/.test(t)) return 'cx';
  return 'other';
}

// ── HTTP HELPERS ──────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'JobScout/7.0 (github.com/Gketan97/jobscout-date)',
          ...options.headers,
        },
        signal: AbortSignal.timeout(15000),
        ...options,
      });
      if (r.status === 429) {
        const wait = 2 ** i * 2000;
        console.log(`  ⏳ Rate limited on ${url.split('?')[0]}, waiting ${wait/1000}s...`);
        await sleep(wait);
        continue;
      }
      if (!r.ok) {
        console.log(`  ⚠️  HTTP ${r.status} on ${url.split('?')[0]}`);
        return null;
      }
      return await r.json();
    } catch (e) {
      console.log(`  ✗ Fetch error (attempt ${i + 1}): ${e.message}`);
      if (i < retries - 1) await sleep(2 ** i * 1000);
    }
  }
  return null;
}

// POST variant for Workday
async function postJSON(url, body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'JobScout/7.0',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (r.status === 429) {
        await sleep(2 ** i * 2000);
        continue;
      }
      if (!r.ok) {
        console.log(`  ⚠️  HTTP ${r.status} POST ${url.split('?')[0]}`);
        return null;
      }
      return await r.json();
    } catch (e) {
      console.log(`  ✗ POST error (attempt ${i + 1}): ${e.message}`);
      if (i < retries - 1) await sleep(2 ** i * 1000);
    }
  }
  return null;
}

// ── JOB FACTORY ───────────────────────────────────────────────────────────────
function makeJob(fields) {
  return {
    id:        fields.id,
    title:     (fields.title || '').trim(),
    company:   (fields.company || '').trim(),
    location:  (fields.location || '').trim(),
    city:      fields.city || detectCity(fields.location || ''),
    mode:      fields.mode || detectMode(fields.location || ''),
    country:   'India',
    fn:        fields.fn || detectFn(fields.title || ''),
    tier:      fields.tier || 2,
    seniority: fields.seniority || detectSeniority(fields.title || ''),
    dept:      (fields.dept || '').trim(),
    url:       fields.url || '',
    color:     fields.color || '#6366f1',
    posted_at: fields.posted_at || '',
    src:       fields.src || 'other',
  };
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// ── FETCHERS ──────────────────────────────────────────────────────────────────

async function fetchGreenhouse(co) {
  const d = await fetchJSON(`https://boards-api.greenhouse.io/v1/boards/${co.s}/jobs?content=false`);
  if (!d) return [];
  const jobs = [];
  for (const j of (d.jobs || [])) {
    const loc = j.location?.name || '';
    if (classifyIndia(loc, co.t, 'greenhouse') === 'skip') continue;
    jobs.push(makeJob({
      id:        `gh-${j.id}`,
      title:     j.title,
      company:   co.n,
      location:  loc,
      dept:      j.departments?.[0]?.name || '',
      url:       `https://boards.greenhouse.io/${co.s}/jobs/${j.id}`,
      color:     co.c,
      tier:      co.t,
      posted_at: j.updated_at ? j.updated_at.slice(0, 10) : '',
      src:       'greenhouse',
    }));
  }
  await sleep(150);
  return jobs;
}

async function fetchLever(co) {
  const d = await fetchJSON(`https://api.lever.co/v0/postings/${co.s}?mode=json`);
  if (!d || !Array.isArray(d)) return [];
  const jobs = [];
  for (const j of d) {
    const loc = j.categories?.location || j.workplaceType || '';
    if (classifyIndia(loc, co.t, 'lever') === 'skip') continue;
    jobs.push(makeJob({
      id:        `lv-${j.id}`,
      title:     j.text,
      company:   co.n,
      location:  loc,
      dept:      j.categories?.department || '',
      url:       j.hostedUrl || `https://jobs.lever.co/${co.s}/${j.id}`,
      color:     co.c,
      tier:      co.t,
      posted_at: j.createdAt ? new Date(j.createdAt).toISOString().slice(0, 10) : '',
      src:       'lever',
    }));
  }
  await sleep(150);
  return jobs;
}

async function fetchAshby(co) {
  const d = await fetchJSON(`https://api.ashbyhq.com/posting-api/job-board/${co.s}`);
  if (!d) return [];
  const jobs = [];
  for (const j of (d.jobPostings || [])) {
    const loc = j.locationName || '';
    if (classifyIndia(loc, co.t, 'ashby') === 'skip') continue;
    jobs.push(makeJob({
      id:        `ab-${j.id}`,
      title:     j.title,
      company:   co.n,
      location:  loc,
      dept:      j.departmentName || '',
      url:       j.jobUrl || `https://jobs.ashbyhq.com/${co.s}/${j.id}`,
      color:     co.c,
      tier:      co.t,
      posted_at: j.publishedDate ? j.publishedDate.slice(0, 10) : '',
      src:       'ashby',
    }));
  }
  await sleep(150);
  return jobs;
}

async function fetchWorkable(co) {
  const jobs = [];
  let offset = 0;
  while (true) {
    const d = await fetchJSON(
      `https://apply.workable.com/api/v3/accounts/${co.s}/jobs?limit=50&offset=${offset}`
    );
    if (!d?.results?.length) break;
    for (const j of d.results) {
      const loc = j.location?.city
        ? `${j.location.city}, ${j.location.country || ''}`
        : '';
      if (classifyIndia(loc, co.t, 'workable') === 'skip') continue;
      jobs.push(makeJob({
        id:        `wk-${j.shortcode || j.id}`,
        title:     j.title,
        company:   co.n,
        location:  loc,
        dept:      j.department || '',
        url:       `https://apply.workable.com/${co.s}/j/${j.shortcode || j.id}`,
        color:     co.c,
        tier:      co.t,
        posted_at: j.published_on ? j.published_on.slice(0, 10) : '',
        src:       'workable',
      }));
    }
    if (!d.next) break;
    offset += 50;
    await sleep(500);
  }
  return jobs;
}

async function fetchSmartRecruiters(co) {
  const jobs = [];
  let offset = 0;
  while (true) {
    const d = await fetchJSON(
      `https://api.smartrecruiters.com/v1/companies/${co.s}/postings?country=IN&limit=100&offset=${offset}&status=PUBLISHED`
    );
    if (!d?.content?.length) break;
    for (const j of d.content) {
      const city = j.location?.city || '';
      jobs.push(makeJob({
        id:        `sr-${j.id}`,
        title:     j.name,
        company:   co.n,
        location:  city ? `${city}, India` : 'India',
        dept:      j.department?.label || '',
        url:       j.ref || '',
        color:     co.c,
        tier:      co.t,
        posted_at: j.releasedDate ? j.releasedDate.slice(0, 10) : '',
        src:       'smartrecruiters',
      }));
    }
    // Guard: totalFound may be missing
    const total = d.totalFound ?? d.totalElements ?? (d.content.length < 100 ? offset + d.content.length : offset + 200);
    offset += 100;
    if (offset >= total || d.content.length < 100) break;
    await sleep(500);
  }
  return jobs;
}

async function fetchEightfold(co) {
  const jobs = [];
  let cursor = null;
  let page = 0;
  const MAX_PAGES = 200; // increased from 50 — AmEx India can have 500+ jobs at 10/page = 50 pages minimum
  while (true) {
    const url = `https://${co.host}/api/apply/v2/jobs?domain=${co.tenant}&location=India&count=10${cursor ? `&cursor=${cursor}` : ''}`;
    const d = await fetchJSON(url);
    if (!d?.positions?.length) break;
    for (const j of d.positions) {
      jobs.push(makeJob({
        id:        `ef-${j.id}`,
        title:     j.name,
        company:   co.n,
        location:  j.location || 'India',
        dept:      j.department || '',
        url:       `https://${co.host}/careers?query=${encodeURIComponent(j.name)}&location=India`,
        color:     co.c,
        tier:      co.t,
        posted_at: j.updated_at ? j.updated_at.slice(0, 10) : '',
        src:       'eightfold',
      }));
    }
    cursor = d.next_cursor;
    if (!cursor || !d.next_cursor) break;
    page++;
    if (page >= MAX_PAGES) {
      console.log(`  ⚠️  Eightfold ${co.n} hit ${MAX_PAGES}-page cap — may be truncated`);
      break;
    }
    await sleep(400);
  }
  return jobs;
}

/**
 * Workday — POST-based API used by Target India, Walmart, SAP etc.
 * Pattern: POST to https://{tenant}.wd5.myworkdayjobs.com/wday/cxs/{tenant}/{board}/jobs
 * Body: { limit: 20, offset: 0, searchText: "", appliedFacets: { "locations": ["India"] } }
 *
 * The locationFacetKey may vary by tenant — we try both "locations" and "primaryLocation".
 * We paginate until total is exhausted.
 */
async function fetchWorkday(co) {
  const jobs = [];
  const base = co.api_base;
  if (!base) {
    console.log(`  ⚠️  No api_base for Workday company ${co.n}`);
    return [];
  }

  const PAGE_SIZE = 20;
  let offset = 0;
  let total = null;

  // Try "India" as location facet value — Workday uses internal codes, try common ones
  const locationKeys = ['India', 'IND', 'IN'];
  const facetFields  = ['locations', 'primaryLocation', 'locationCountry'];

  // We'll try each combo until we get results
  let workingFacet = null;
  let workingKey   = null;

  outer:
  for (const field of facetFields) {
    for (const key of locationKeys) {
      const body = {
        limit: PAGE_SIZE,
        offset: 0,
        searchText: '',
        appliedFacets: { [field]: [key] },
      };
      const d = await postJSON(base, body);
      if (d?.jobPostings?.length || d?.total > 0) {
        workingFacet = field;
        workingKey   = key;
        total = d.total || d.jobPostings?.length || 0;
        // Process this first page
        for (const j of (d.jobPostings || [])) {
          jobs.push(makeJob({
            id:        `wd-${hashStr(co.n + j.title + j.externalPath)}`,
            title:     j.title,
            company:   co.n,
            location:  j.locationsText || j.primaryLocation || 'India',
            dept:      j.jobFunctionSummary || '',
            url:       j.externalPath
              ? (j.externalPath.startsWith('http') ? j.externalPath : `https://${co.tenant}.wd5.myworkdayjobs.com${j.externalPath}`)
              : '',
            color:     co.c,
            tier:      co.t,
            posted_at: j.postedOn ? new Date(j.postedOn).toISOString().slice(0, 10) : '',
            src:       'workday',
          }));
        }
        offset = PAGE_SIZE;
        break outer;
      }
      await sleep(300);
    }
  }

  // If no facet worked, try no location filter (get all, then accept all as India since it's company's India board)
  if (!workingFacet && jobs.length === 0) {
    const body = { limit: PAGE_SIZE, offset: 0, searchText: '' };
    const d = await postJSON(base, body);
    if (d?.jobPostings?.length) {
      total = d.total || d.jobPostings.length;
      workingFacet = null; // signal: no location filter
      for (const j of (d.jobPostings || [])) {
        const loc = j.locationsText || j.primaryLocation || '';
        // For India-specific boards (like Target India), accept all
        if (co.notes?.includes('India-specific') || classifyIndia(loc, co.t, 'workday') !== 'skip') {
          jobs.push(makeJob({
            id:        `wd-${hashStr(co.n + j.title + (j.externalPath||''))}`,
            title:     j.title,
            company:   co.n,
            location:  loc || 'India',
            dept:      j.jobFunctionSummary || '',
            url:       j.externalPath
              ? (j.externalPath.startsWith('http') ? j.externalPath : `https://${co.tenant}.wd5.myworkdayjobs.com${j.externalPath}`)
              : '',
            color:     co.c,
            tier:      co.t,
            posted_at: j.postedOn ? new Date(j.postedOn).toISOString().slice(0, 10) : '',
            src:       'workday',
          }));
        }
      }
      offset = PAGE_SIZE;
    }
  }

  // Paginate remaining pages
  while (offset < (total || 0)) {
    const body = workingFacet
      ? { limit: PAGE_SIZE, offset, searchText: '', appliedFacets: { [workingFacet]: [workingKey] } }
      : { limit: PAGE_SIZE, offset, searchText: '' };
    const d = await postJSON(base, body);
    if (!d?.jobPostings?.length) break;
    for (const j of (d.jobPostings || [])) {
      const loc = j.locationsText || j.primaryLocation || '';
      if (!workingFacet && classifyIndia(loc, co.t, 'workday') === 'skip') continue;
      jobs.push(makeJob({
        id:        `wd-${hashStr(co.n + j.title + (j.externalPath||''))}`,
        title:     j.title,
        company:   co.n,
        location:  loc || 'India',
        dept:      j.jobFunctionSummary || '',
        url:       j.externalPath
          ? (j.externalPath.startsWith('http') ? j.externalPath : `https://${co.tenant}.wd5.myworkdayjobs.com${j.externalPath}`)
          : '',
        color:     co.c,
        tier:      co.t,
        posted_at: j.postedOn ? new Date(j.postedOn).toISOString().slice(0, 10) : '',
        src:       'workday',
      }));
    }
    total = d.total || total; // update total in case it changed
    offset += PAGE_SIZE;
    if (d.jobPostings.length < PAGE_SIZE) break; // last page
    await sleep(500);
  }

  return jobs;
}

async function fetchAdzunaMNC(co) {
  const jobs = [];
  const seen = new Set();
  const url = `https://api.adzuna.com/v1/api/jobs/in/search/1?app_id=${ADZUNA_ID}&app_key=${ADZUNA_KEY}&results_per_page=50&company=${encodeURIComponent(co.q)}&content-type=application/json`;
  const d = await fetchJSON(url);
  if (!d?.results) return [];
  for (const j of d.results) {
    const id = `az-mnc-${j.id || hashStr(co.n + j.title)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    jobs.push(makeJob({
      id,
      title:     j.title || '',
      company:   co.n,
      location:  j.location?.display_name || 'India',
      dept:      j.category?.label || '',
      url:       j.redirect_url || '',
      color:     co.c,
      tier:      3,
      posted_at: j.created ? j.created.slice(0, 10) : '',
      src:       'adzuna',
    }));
  }
  await sleep(300);
  return jobs;
}

async function fetchAdzunaCity(query) {
  const { cat, where } = query;
  const jobs = [];
  const seen = new Set();
  for (let page = 1; page <= 3; page++) {
    const url = `https://api.adzuna.com/v1/api/jobs/in/search/${page}?app_id=${ADZUNA_ID}&app_key=${ADZUNA_KEY}&results_per_page=50&category=${cat}&where=${where}&content-type=application/json`;
    const d = await fetchJSON(url);
    if (!d?.results?.length) break;
    for (const j of d.results) {
      const id = `az-${j.id || hashStr(j.title + (j.company?.display_name || ''))}`;
      if (seen.has(id)) continue;
      seen.add(id);
      jobs.push(makeJob({
        id,
        title:     j.title || '',
        company:   j.company?.display_name || '',
        location:  j.location?.display_name || where,
        dept:      j.category?.label || '',
        url:       j.redirect_url || '',
        color:     '#F97316',
        tier:      2,
        posted_at: j.created ? j.created.slice(0, 10) : '',
        src:       'adzuna',
      }));
    }
    const total = d.count || 0;
    if (page * 50 >= total) break;
    await sleep(300);
  }
  return jobs;
}

// ── DISPATCH ──────────────────────────────────────────────────────────────────
async function scrapeCompany(method, co, state) {
  const slug = co.s || co.host || co.q || co.n;
  if (!shouldScrape(state, method, slug)) {
    const entry = state.companies[stateKey(method, slug)];
    console.log(`  ⏭  ${co.n} — skipped (scraped ${Math.round((Date.now() - new Date(entry.last_scraped).getTime()) / 3600000)}h ago, ${entry.last_count} jobs)`);
    return null; // null = use cached jobs
  }

  try {
    let jobs;
    if      (method === 'greenhouse')     jobs = await fetchGreenhouse(co);
    else if (method === 'lever')          jobs = await fetchLever(co);
    else if (method === 'ashby')          jobs = await fetchAshby(co);
    else if (method === 'workable')       jobs = await fetchWorkable(co);
    else if (method === 'smartrecruiters')jobs = await fetchSmartRecruiters(co);
    else if (method === 'eightfold')      jobs = await fetchEightfold(co);
    else if (method === 'workday')        jobs = await fetchWorkday(co);
    else if (method === 'adzuna_mnc')     jobs = await fetchAdzunaMNC(co);
    else {
      console.log(`  ⚠️  Unknown method: ${method}`);
      return [];
    }

    const count = jobs.length;
    console.log(`  ✓  ${co.n} — ${count} India jobs`);
    recordState(state, method, slug, count);
    return jobs;

  } catch (e) {
    console.log(`  ✗  ${co.n} — error: ${e.message}`);
    recordState(state, method, slug, 0, e.message);
    return [];
  }
}

// ── DEDUP ─────────────────────────────────────────────────────────────────────
function dedup(jobs) {
  const seen = new Map();
  const out = [];
  for (const j of jobs) {
    if (!j.id || !j.title) continue;
    const key = `${j.company}|${j.title}|${j.city}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
    if (seen.has(key)) {
      const idx = seen.get(key);
      if ((j.posted_at || '') > (out[idx].posted_at || '')) out[idx] = j;
    } else {
      seen.set(key, out.length);
      out.push(j);
    }
  }
  return out;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const mode = FORCE ? 'FORCE' : NEW_ONLY ? 'NEW-ONLY' : 'INCREMENTAL';
  console.log(`\n🚀 JobScout Crawler v7 — mode: ${mode}`);
  console.log(`   ${new Date().toISOString()}\n`);

  const startTime = Date.now();
  const state = loadState();

  // Load existing jobs.json so we can merge when skipping companies
  let existingJobs = [];
  if (!FORCE) {
    try {
      const existing = JSON.parse(fs.readFileSync(JOBS_F, 'utf8'));
      existingJobs = existing.jobs || [];
      console.log(`📦 Loaded ${existingJobs.length} existing jobs from cache\n`);
    } catch {
      console.log(`📦 No existing jobs.json — will do full scrape\n`);
    }
  }

  const freshJobs = [];    // jobs from companies scraped this run
  const skippedCompanies = new Set(); // companies we skipped (will use existing)

  // Scrape each method/source group
  const methods = ['greenhouse','lever','ashby','workable','smartrecruiters','eightfold','workday'];
  for (const method of methods) {
    const companies = (CONFIG[method] || []).filter(co => (co.status || 'active') === 'active');
    if (!companies.length) continue;
    console.log(`\n── ${method.toUpperCase()} (${companies.length} companies) ──`);
    for (const co of companies) {
      const result = await scrapeCompany(method, co, state);
      if (result === null) {
        // skipped — will pull from existing jobs
        const slug = co.s || co.host || co.q || co.n;
        skippedCompanies.add(co.n);
      } else {
        freshJobs.push(...result);
      }
    }
  }

  // Adzuna (only if keys present)
  if (ADZUNA_ID) {
    const mncList = (CONFIG.adzuna_mnc || []).filter(co => (co.status || 'active') === 'active');
    if (mncList.length) {
      console.log(`\n── ADZUNA MNC (${mncList.length} companies) ──`);
      for (const co of mncList) {
        const result = await scrapeCompany('adzuna_mnc', co, state);
        if (result !== null) freshJobs.push(...result);
      }
    }

    const cityList = (CONFIG.adzuna_city || []).filter(co => (co.status || 'active') === 'active');
    if (cityList.length) {
      console.log(`\n── ADZUNA CITY (${cityList.length} queries) ──`);
      for (const q of cityList) {
        const key = `${q.cat}/${q.where}`;
        if (!shouldScrape(state, 'adzuna_city', key)) {
          console.log(`  ⏭  ${key} — skipped`);
          continue;
        }
        try {
          const jobs = await fetchAdzunaCity(q);
          console.log(`  ✓  ${key} — ${jobs.length} jobs`);
          recordState(state, 'adzuna_city', key, jobs.length);
          freshJobs.push(...jobs);
        } catch (e) {
          console.log(`  ✗  ${key} — ${e.message}`);
          recordState(state, 'adzuna_city', key, 0, e.message);
        }
      }
    }
  } else {
    console.log('\n⚠️  Skipping Adzuna — ADZUNA_APP_ID not set');
  }

  // Merge: fresh jobs + preserved jobs from skipped companies
  let allJobs;
  if (skippedCompanies.size > 0 && existingJobs.length > 0) {
    console.log(`\n── Merging ${skippedCompanies.size} skipped companies from cache ──`);
    const preserved = existingJobs.filter(j => skippedCompanies.has(j.company));
    console.log(`   Preserved ${preserved.length} cached jobs`);
    allJobs = [...freshJobs, ...preserved];
  } else {
    allJobs = freshJobs;
  }

  // Dedup
  console.log('\n── Deduplicating ──');
  const deduped = dedup(allJobs);

  // Drop stale (>30 days, but only if they have a date — undated jobs are kept)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const fresh = deduped.filter(j => !j.posted_at || j.posted_at >= cutoffStr);

  // Stats
  const sources  = {};
  const cities   = {};
  const byMethod = {};
  for (const j of fresh) {
    sources[j.src]  = (sources[j.src]  || 0) + 1;
    cities[j.city]  = (cities[j.city]  || 0) + 1;
    byMethod[j.src] = (byMethod[j.src] || 0) + 1;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n── Results ──────────────────────`);
  console.log(`Total jobs:    ${fresh.length.toLocaleString()}`);
  console.log(`Deduped from:  ${deduped.length.toLocaleString()}`);
  console.log(`Elapsed:       ${elapsed}s`);
  console.log(`Sources:`, sources);
  console.log(`Cities:`, cities);

  // Write output
  const dataDir = path.join(ROOT, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(JOBS_F, JSON.stringify({
    v: 7,
    count: fresh.length,
    updated_at: new Date().toISOString(),
    jobs: fresh,
  }));

  fs.writeFileSync(META_F, JSON.stringify({
    v: 7,
    count: fresh.length,
    updated_at: new Date().toISOString(),
    sources,
    cities,
    elapsed_s: parseFloat(elapsed),
    mode,
  }, null, 2));

  // Update + save state
  state.last_full_run  = FORCE || !NEW_ONLY ? new Date().toISOString() : state.last_full_run;
  state.last_run_count = fresh.length;
  saveState(state);

  console.log('\n✅ Done — wrote data/jobs.json, data/meta.json, data/state.json\n');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
