#!/usr/bin/env node
'use strict';

/**
 * Radar Editorial PRO – General Post One Software.
 * Nu necesită acces de admin în WordPress și nu instalează pluginuri.
 * Rulează separat, citește surse publice și verifică oficiuldestiri.ro prin endpointuri/public pages.
 *
 * Cerințe: Node.js 18+ pentru fetch nativ.
 */

const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { URL } = require('url');

function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  try {
    const text = require('fs').readFileSync(envPath, 'utf8');
    text.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) return;
      const key = match[1];
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    });
  } catch (_) {
    // .env este opțional. Dacă nu există, folosim valorile implicite.
  }
}

loadDotEnv();

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOCAL_CONTACTS_PATH = path.join(__dirname, 'contacts-deputati.json');
const OFICIU_BASE = trimTrailingSlash(process.env.OFICIU_BASE || 'https://oficiuldestiri.ro');
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);
const MAX_AGE_MINUTES = Number(process.env.MAX_AGE_MINUTES || 120);
const MAX_TOPICS = Number(process.env.MAX_TOPICS || 60);
const MIN_SCAN_MINUTES = 60;
const MAX_SCAN_MINUTES = 24 * 60;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const STRICT_SOURCE_AGE = String(process.env.STRICT_SOURCE_AGE || '1') !== '0';
const FAST_OFICIU_SCAN = String(process.env.FAST_OFICIU_SCAN || '1') !== '0';
const AUTO_REFRESH_MINUTES = Number(process.env.AUTO_REFRESH_MINUTES || 3);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const STOPWORDS_RO = new Set([
  'si', 'sau', 'ori', 'cu', 'de', 'la', 'in', 'pe', 'pentru', 'din', 'un', 'o', 'ale', 'al', 'ai',
  'a', 'este', 'sunt', 'fost', 'va', 'au', 'are', 'ce', 'cine', 'cum', 'cand', 'unde', 'cat', 'cati',
  'romania', 'romani', 'romanii', 'stire', 'stiri', 'ultima', 'ultimele', 'acum', 'nou', 'noua',
  'dupa', 'care', 'despre', 'mai', 'mult', 'putin', 'foto', 'video', 'live', 'breaking', 'news',
  'actualizare', 'ora', 'azi', 'maine', 'ieri', 'toate', 'toata', 'toate', 'fara', 'prin', 'dintr',
  'dintre', 'sursa', 'surse', 'acest', 'aceasta', 'aceste', 'acesti'
]);

const CATEGORY_RULES = [
  { category: 'Politică', interest: 'Politică', words: ['guvern', 'premier', 'presedinte', 'nicusor', 'psd', 'pnl', 'usr', 'aur', 'parlament', 'coalitie', 'ministru', 'motiune', 'alegeri', 'politic'] },
  { category: 'Business', interest: 'Economie/Bani', words: ['economie', 'bani', 'taxe', 'impozit', 'tva', 'pret', 'preturi', 'facturi', 'energie', 'bnr', 'anaf', 'salariu', 'pensii', 'piata', 'business', 'firma', 'companie'] },
  { category: 'Actualitate', interest: 'Social', words: ['social', 'trafic', 'accident', 'meteo', 'anm', 'isu', 'politie', 'cod', 'avertizare', 'cutremur', 'incendiu', 'spital', 'transport'] },
  { category: 'Actualitate', interest: 'Educație', words: ['educatie', 'scoala', 'elevi', 'bacalaureat', 'bac', 'evaluare', 'profesori', 'universitate', 'admitere'] },
  { category: 'Actualitate', interest: 'Sănătate', words: ['sanatate', 'medic', 'spital', 'boala', 'virus', 'vaccin', 'farmacie', 'tratament', 'pacienti'] },
  { category: 'Sport', interest: 'Sport', words: ['sport', 'fotbal', 'fcsb', 'rapid', 'dinamo', 'cfr', 'craiova', 'transfer', 'liga', 'simona', 'tenis', 'meci'] },
  { category: 'Life', interest: 'Vedete/Showbiz', words: ['vedeta', 'vedete', 'showbiz', 'artist', 'cantaret', 'actor', 'divort', 'nunta', 'influencer', 'televiziune'] },
  { category: 'Life', interest: 'Horoscop/Lifestyle', words: ['horoscop', 'zodie', 'zodii', 'lifestyle', 'casa', 'gradina', 'reteta', 'fitness', 'stil'] },
  { category: 'Călătorii', interest: 'Travel', words: ['vacanta', 'travel', 'calatorii', 'aeroport', 'zbor', 'zboruri', 'turism', 'hotel', 'destinatie', 'vama'] },
  { category: 'Actualitate', interest: 'Auto', words: ['auto', 'masina', 'dacia', 'bmw', 'tesla', 'trafic', 'rovinieta', 'rca', 'permis'] },
  { category: 'Actualitate', interest: 'Tehnologie', words: ['tehnologie', 'telefon', 'iphone', 'android', 'ai', 'inteligenta', 'aplicatie', 'internet', 'cyber'] },
  { category: 'Special', interest: 'Justiție', words: ['justitie', 'instanta', 'dosar', 'dna', 'diicot', 'procuror', 'judecator', 'ancheta', 'condamnat'] },
  { category: 'Actualitate', interest: 'Externe relevante pentru români', words: ['ue', 'nato', 'ucraina', 'moldova', 'europa', 'sua', 'rusia', 'romani', 'diaspora', 'frontiera'] }
];

const OFFICIAL_HINTS = ['gov.ro', 'mai.gov.ro', 'anaf.ro', 'bnr.ro', 'edu.ro', 'ms.ro', 'politiaromana.ro', 'igsu.ro', 'anm.ro', 'presidency.ro', 'cdep.ro', 'senat.ro', 'mae.ro'];
const HIGH_RISK_WORDS = ['dosar', 'ancheta', 'acuzat', 'condamnat', 'sanatate', 'tratament', 'boala', 'virus', 'bani', 'investitie', 'taxe', 'impozit', 'pensii', 'copil', 'minor'];
const EDITORIAL_FOCUS_TERMS = ['nicusor dan','george simion','marcel ciolacu','anaf','bnr','anm','meteo','cod galben','cod portocaliu','vreme','accident','accidente','pensii','pensie','tva','salarii','salariu','facturi','energie','preturi','guvern','minister','bucuresti','romania','romani','diaspora','bac','evaluare nationala','politie','isu'];

const cache = new Map();


function parseScanInterval(value) {
  const requested = Number(value || MAX_AGE_MINUTES);
  if (!Number.isFinite(requested)) return MAX_AGE_MINUTES;
  const rounded = Math.round(requested);
  return clamp(rounded, MIN_SCAN_MINUTES, MAX_SCAN_MINUTES);
}

async function main() {
  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      console.error('[server-error]', error);
      json(res, 500, { error: 'Eroare server', detail: error.message });
    }
  });

  server.listen(PORT, () => {
    console.log(`Radar Editorial PRO rulează pe http://localhost:${PORT}`);
    console.log(`Oficiul de Știri scan base: ${OFICIU_BASE}`);
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      mode: 'standalone-no-wordpress-admin',
      oficiuBase: OFICIU_BASE,
      maxAgeMinutes: MAX_AGE_MINUTES,
      strictSourceAge: STRICT_SOURCE_AGE,
      fastOficiuScan: FAST_OFICIU_SCAN,
      autoRefreshMinutes: AUTO_REFRESH_MINUTES,
      supportedScanIntervalsMinutes: [60, 120, 180, 240, 360, 480, 720, 1440]
    });
  }

  if (url.pathname === '/api/radar') {
    const fresh = url.searchParams.get('fresh') === '1';
    const maxAgeMinutes = parseScanInterval(url.searchParams.get('maxAge'));
    const key = `radar:v3:${maxAgeMinutes}`;
    const data = fresh
      ? await buildRadar(maxAgeMinutes)
      : await cached(key, CACHE_TTL_MS, () => buildRadar(maxAgeMinutes));
    return json(res, 200, data);
  }

  if (url.pathname === '/api/oficiu-check') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q || q.length < 3) {
      return json(res, 400, { error: 'Trimite parametrul q cu minimum 3 caractere.' });
    }
    const topic = topicFromManualQuery(q);
    const result = await checkOficiuCoverage(topic, { deep: true });
    return json(res, 200, result);
  }


  if (url.pathname === '/api/contact-drafts' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const topic = body?.topic || {};
    if (!topic.title) {
      return json(res, 400, { error: 'Trimite topic cu titlu.' });
    }
    const result = await buildContactDrafts(topic);
    return json(res, 200, result);
  }

  return serveStatic(req, res, url);
}

async function buildRadar(maxAgeMinutes = MAX_AGE_MINUTES) {
  const generatedAt = new Date();
  const sourceErrors = [];

  const rawItemsAll = await fetchAllCandidateItems(sourceErrors, maxAgeMinutes);
  const rawItems = rawItemsAll.filter((item) => isStrictlyFreshItem(item, generatedAt, maxAgeMinutes));
  const grouped = groupCandidateItems(rawItems, generatedAt, maxAgeMinutes);

  const freshGroups = grouped
    .filter((topic) => topic.startedMinutesAgo <= maxAgeMinutes)
    .sort((a, b) => b.preCoveragePriority - a.preCoveragePriority)
    .slice(0, MAX_TOPICS);

  const enriched = await mapLimit(freshGroups, 6, async (topic) => enrichTopicWithCoverage(topic, maxAgeMinutes));

  const sorted = enriched.sort((a, b) => b.priorityScore - a.priorityScore);
  const eligible = sorted.filter((topic) => topic.eligibility.isEligible);

  return {
    generatedAt: generatedAt.toISOString(),
    mode: 'standalone-no-wordpress-admin',
    note: 'Dashboard extern: nu modifică WordPress, nu cere pluginuri și scanează doar conținut public.',
    dataQuality: {
      googleTrends: 'Scanarea folosește RSS-uri directe de publicații românești. Google News RSS este opțional prin USE_GOOGLE_NEWS_RSS=1, deoarece poate răspunde cu HTTP 503 pe Render.',
      oficiuScan: 'Verificare publică: WP REST dacă este permis, search intern, sitemap și opțional Google CSE/SerpAPI.'
    },
    limits: {
      maxAgeMinutes: MAX_AGE_MINUTES,
      strictSourceAge: STRICT_SOURCE_AGE,
      fastOficiuScan: FAST_OFICIU_SCAN,
      autoRefreshMinutes: AUTO_REFRESH_MINUTES,
      maxTopics: MAX_TOPICS,
      cacheTtlMinutes: Math.round(CACHE_TTL_MS / 60000)
    },
    stats: {
      rawItems: rawItems.length,
      rawItemsBeforeStrictFreshFilter: rawItemsAll.length,
      groupedTopics: grouped.length,
      checkedFreshTopics: sorted.length,
      eligibleTopics: eligible.length,
      blockedTopics: sorted.length - eligible.length
    },
    sourceErrors,
    topics: sorted
  };
}

async function fetchAllCandidateItems(sourceErrors, maxAgeMinutes = MAX_AGE_MINUTES) {
  // 10 iunie 2026: Google News RSS răspunde cu HTTP 503 din Render pentru
  // majoritatea interogărilor. De aceea sursa principală devine RSS-ul direct
  // al publicațiilor, iar Google News rămâne opțional prin env USE_GOOGLE_NEWS_RSS=1.
  const urls = [
    ...getTrendRssUrls(),
    ...getPublisherRssUrls(),
    ...getGoogleNewsRssUrls(maxAgeMinutes)
  ];
  const results = await mapLimit(urls, 3, async (feed) => {
    try {
      const xml = await cached(`feed:${feed.url}`, Math.min(CACHE_TTL_MS, 5 * 60 * 1000), () => fetchText(feed.url));
      return parseRssItems(xml).map((item) => ({ ...item, feedType: feed.type, feedUrl: feed.url, feedLabel: feed.label }));
    } catch (error) {
      sourceErrors.push({ source: feed.label, url: feed.url, error: error.message });
      return [];
    }
  });

  return results.flat().filter((item) => item.title && item.title.length > 3);
}

function getTrendRssUrls() {
  const configured = process.env.GOOGLE_TRENDS_RSS_URLS || process.env.GOOGLE_TRENDS_RSS_URL;
  // Google Trends RSS vechi întoarce 404 pentru RO în unele momente/zone.
  // Dacă nu este setat explicit un RSS Trends valid, nu mai folosim fallback-ul vechi,
  // ca să nu blocheze scanarea principală bazată pe Google News.
  const urls = configured
    ? configured.split(',').map((u) => u.trim()).filter(Boolean)
    : [];

  return urls.map((url) => ({ type: 'trends', label: 'Google Trends RSS', url }));
}


function getPublisherRssUrls() {
  const configured = process.env.PUBLISHER_RSS_URLS;
  const urls = configured
    ? configured.split(',').map((u) => u.trim()).filter(Boolean).map((url, index) => ({ label: `RSS personalizat ${index + 1}`, url }))
    : [
        { label: 'RSS · Digi24', url: 'https://www.digi24.ro/rss_files/google_news.xml' },
        { label: 'RSS · HotNews', url: 'https://rss.hotnews.ro/' },
        { label: 'RSS · G4Media', url: 'https://www.g4media.ro/feed' },
        { label: 'RSS · Economedia', url: 'https://economedia.ro/feed' },
        { label: 'RSS · Edupedu', url: 'https://www.edupedu.ro/feed/' },
        { label: 'RSS · Libertatea', url: 'https://www.libertatea.ro/feed' },
        { label: 'RSS · Europa FM', url: 'https://www.europafm.ro/feed/' },
        { label: 'RSS · Mediafax', url: 'https://www.mediafax.ro/rss' },
        { label: 'RSS · Stirile ProTV', url: 'https://stirileprotv.ro/rss' },
        { label: 'RSS · Observator', url: 'https://observatornews.ro/rss' },
        { label: 'RSS · Antena 3 CNN', url: 'https://www.antena3.ro/rss' },
        { label: 'RSS · News.ro', url: 'https://www.news.ro/rss' }
      ];

  return urls.map((feed) => ({ type: 'publisher-rss', label: feed.label, url: feed.url }));
}

function getGoogleNewsRssUrls(maxAgeMinutes = MAX_AGE_MINUTES) {
  // Google News RSS poate răspunde cu HTTP 503 pe Render. Îl ținem oprit implicit.
  // Dacă vrei să-l reactivezi: Environment -> USE_GOOGLE_NEWS_RSS=1.
  if (String(process.env.USE_GOOGLE_NEWS_RSS || '0') !== '1') return [];
  // PRO: interogări orientate pe România și pe temele editoriale cu impact.
  // Evităm feedul generic mare, pentru că aduce sport extern și surse vechi.
  const whenHours = Math.max(1, Math.ceil(maxAgeMinutes / 60));
  const when = `when:${whenHours}h`;
  const queryFeeds = [
    { label: `News · România ultimele ${whenHours}h`, q: `România ${when}` },
    { label: 'News · politică România', q: `(Nicușor Dan OR George Simion OR Ciolacu OR Guvern OR Parlament OR alegeri) România ${when}` },
    { label: 'News · bani România', q: `(ANAF OR BNR OR TVA OR pensii OR salarii OR facturi OR energie OR taxe) România ${when}` },
    { label: 'News · meteo trafic urgențe', q: `(ANM OR meteo OR vreme OR cod galben OR cod portocaliu OR accident OR incendiu OR ISU OR Poliția) România ${when}` },
    { label: 'News · educație sănătate', q: `(BAC OR Evaluare Națională OR elevi OR școală OR sănătate OR spital) România ${when}` },
    { label: 'News · români diaspora externe', q: `(români OR diaspora OR Moldova OR Ucraina OR UE OR NATO) ${when}` },
    { label: 'News · showbiz România', q: `(Pro TV OR Românii au talent OR vedete OR showbiz OR Antena 1) România ${when}` },
    { label: 'News · sport România', q: `(FCSB OR Rapid OR Dinamo OR CFR Cluj OR Craiova OR Simona Halep OR România fotbal) ${when}` }
  ];

  return queryFeeds.map((feed) => ({
    type: 'google-news',
    label: feed.label,
    url: `https://news.google.com/rss/search?q=${encodeURIComponent(feed.q)}&hl=ro&gl=RO&ceid=RO:ro`
  }));
}

function parseRssItems(xml) {
  const items = [];
  const itemMatches = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)];

  for (const match of itemMatches) {
    const block = match[0];
    const titleRaw = getXmlTag(block, 'title');
    const linkRaw = getXmlTag(block, 'link');
    const pubDateRaw = getXmlTag(block, 'pubDate') || getXmlTag(block, 'dc:date') || getXmlTag(block, 'updated');
    const sourceRaw = getXmlTag(block, 'source');
    const authorRaw = getXmlTag(block, 'author') || getXmlTag(block, 'dc:creator') || getXmlTag(block, 'creator');
    const descriptionRaw = getXmlTag(block, 'description');
    const approxTraffic = getXmlTag(block, 'ht:approx_traffic') || getXmlTag(block, 'approx_traffic') || '';

    const nestedNews = [...block.matchAll(/<ht:news_item\b[\s\S]*?<\/ht:news_item>/gi)].map((newsMatch) => ({
      title: cleanText(getXmlTag(newsMatch[0], 'ht:news_item_title')),
      url: cleanText(getXmlTag(newsMatch[0], 'ht:news_item_url')),
      source: cleanText(getXmlTag(newsMatch[0], 'ht:news_item_source'))
    })).filter((n) => n.title || n.url);

    const title = cleanNewsTitle(cleanText(titleRaw));
    const link = cleanText(linkRaw);
    const pubDate = parseDate(pubDateRaw);
    const source = cleanText(sourceRaw) || inferSourceFromTitle(titleRaw) || inferHost(link) || 'Sursă necunoscută';
    const description = cleanText(stripHtml(descriptionRaw));

    items.push({
      title,
      rawTitle: cleanText(titleRaw),
      link,
      pubDate: pubDate ? pubDate.toISOString() : null,
      source,
      author: cleanText(authorRaw),
      description,
      approxTraffic: cleanText(approxTraffic),
      nestedNews
    });
  }

  return items;
}

function getXmlTag(block, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i');
  const match = block.match(re);
  return match ? stripCdata(match[1]) : '';
}


function isStrictlyFreshItem(item, now, maxAgeMinutes = MAX_AGE_MINUTES) {
  // Regula editorială cerută: nu intră în dashboard nimic fără dată clară și nimic peste 120 min.
  if (!STRICT_SOURCE_AGE) return true;
  if (!item.pubDate) return false;
  const age = Math.round((now - new Date(item.pubDate)) / 60000);
  if (!Number.isFinite(age)) return false;
  return age >= 0 && age <= maxAgeMinutes;
}

function groupCandidateItems(items, now, maxAgeMinutes = MAX_AGE_MINUTES) {
  const groups = [];

  for (const item of items) {
    const title = cleanNewsTitle(item.title);
    if (!title || title.length < 8) continue;

    const itemDate = item.pubDate ? new Date(item.pubDate) : now;
    const ageMinutes = Math.max(0, Math.round((now - itemDate) / 60000));
    if (STRICT_SOURCE_AGE && (!item.pubDate || ageMinutes > maxAgeMinutes)) continue;
    const tokens = significantTokens(title);
    if (tokens.length < 2) continue;

    let group = groups.find((g) => {
      const sim = jaccard(tokens, g.tokens);
      const overlap = tokens.filter((t) => g.tokens.includes(t)).length;
      return sim >= 0.42 || (overlap >= 4 && sim >= 0.28);
    });

    if (!group) {
      group = {
        id: stableId(title),
        title,
        tokens,
        items: [],
        sources: [],
        ages: [],
        dates: [],
        approxTrafficValues: [],
        fromTrends: false,
        fromGoogleNews: false
      };
      groups.push(group);
    }

    group.items.push(item);
    group.ages.push(ageMinutes);
    if (item.pubDate) group.dates.push(new Date(item.pubDate));
    group.fromTrends = group.fromTrends || item.feedType === 'trends';
    group.fromGoogleNews = group.fromGoogleNews || item.feedType === 'google-news';
    if (item.approxTraffic) group.approxTrafficValues.push(item.approxTraffic);

    addSource(group.sources, {
      name: item.source || item.feedLabel || inferHost(item.link) || 'Sursă',
      url: item.link || '#',
      title: item.title,
      official: isOfficialUrl(item.link),
      publishedAt: item.pubDate,
      sourceAgeMinutes: ageMinutes,
      author: item.author || ''
    });

    // PRO: nu afișăm linkuri nested din Google Trends dacă nu avem dată publicării.
    // Altfel se deschid articole vechi, deși trendul este nou.
    group.nestedSignalCount = (group.nestedSignalCount || 0) + ((item.nestedNews || []).length);
  }

  return groups.map((group) => toTopic(group, maxAgeMinutes));
}

function toTopic(group, maxAgeMinutes = MAX_AGE_MINUTES) {
  const allTitles = group.items.map((item) => item.title).filter(Boolean);
  const title = chooseRepresentativeTitle(allTitles, group.title);
  const tokens = significantTokens(title);
  const sources = group.sources.slice(0, 8);
  const sourceCount = uniqueBy(sources, (s) => `${s.name}|${s.url}`).length;
  const startedMinutesAgo = group.ages.length ? Math.max(...group.ages) : maxAgeMinutes + 1;
  const newestSourceMinutesAgo = group.ages.length ? Math.min(...group.ages) : startedMinutesAgo;
  const dates = (group.dates || []).filter((d) => d instanceof Date && !Number.isNaN(d.getTime()));
  const startedAt = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))).toISOString() : null;
  const newestSourceAt = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString() : null;
  const approxTraffic = chooseHighestTraffic(group.approxTrafficValues);
  const classification = classifyTopic(title, tokens);
  const trendScore = estimateTrendScore({ approxTraffic, sourceCount, newestSourceMinutesAgo, fromTrends: group.fromTrends });
  const recencyScore = clamp(100 - (startedMinutesAgo / maxAgeMinutes) * 100, 0, 100);
  const romaniaRelevance = estimateRomaniaRelevance(title, tokens, sources);
  const seoPotential = estimateSeoPotential(title, tokens, trendScore, sourceCount);
  const impact = estimateImpact(title, tokens, classification.interest);
  const preCoveragePriority = calculatePriority({ trendScore, recencyScore, romaniaRelevance, coverageScore: 100, seoPotential, impact });
  const trendStatus = inferTrendStatus(trendScore, newestSourceMinutesAgo, sourceCount, group.fromTrends);
  const risk = inferRisk(title, tokens, classification.interest);
  const entities = extractEntities(title);
  const keywords = tokens.slice(0, 8);

  return {
    id: group.id,
    title,
    category: classification.category,
    subcategory: classification.subcategory,
    interest: classification.interest,
    intensity: inferIntensity(trendScore),
    trendStatus,
    trendScore,
    trendsIndex: group.fromTrends ? trendScore : null,
    trendsIndexLabel: group.fromTrends ? String(trendScore) : 'n/a',
    estimatedVolume: approxTraffic ? `${approxTraffic} (Google Trends RSS)` : '—',
    growthPercent: group.fromTrends && trendScore >= 92 ? 'breakout' : '—',
    startedMinutesAgo,
    newestSourceMinutesAgo,
    startedAt,
    newestSourceAt,
    sourceCount,
    romaniaRelevance,
    seoPotential,
    impact,
    risk,
    recommendation: 'monitorizează',
    officialConfirmed: sources.some((s) => s.official),
    entities,
    keywords,
    sources,
    summary: buildSummary(title, classification.interest, sources.length),
    reason: buildReason(trendScore, romaniaRelevance, sourceCount, classification.interest),
    seoTitle: buildSeoTitle(title),
    meta: buildMeta(title, classification.interest),
    editorialAngle: buildEditorialAngle(classification.interest, title),
    wpCategory: classification.category,
    tags: keywords.slice(0, 5),
    warnings: buildWarnings(risk, group.fromTrends),
    doNotSay: buildDoNotSay(risk, classification.interest),
    fromTrends: group.fromTrends,
    fromGoogleNews: group.fromGoogleNews,
    preCoveragePriority
  };
}

async function enrichTopicWithCoverage(topic, maxAgeMinutes = MAX_AGE_MINUTES) {
  const coverage = await checkOficiuCoverage(topic, { maxAgeMinutes });
  const coverageScore = coverage.status === 'neacoperit' ? 100 : coverage.status === 'posibil-similar' ? 55 : 0;
  const recencyScore = clamp(100 - (topic.startedMinutesAgo / maxAgeMinutes) * 100, 0, 100);
  const priorityScore = calculatePriority({
    trendScore: topic.trendScore,
    recencyScore,
    romaniaRelevance: topic.romaniaRelevance,
    coverageScore,
    seoPotential: topic.seoPotential,
    impact: topic.impact
  });

  const hasEnoughSources = topic.sourceCount >= 2 || topic.officialConfirmed;
  const tooOld = topic.startedMinutesAgo > maxAgeMinutes;
  const duplicate = coverage.status === 'deja-acoperit';
  const lowInterest = topic.trendScore < 45 && !topic.fromTrends;
  const lowRomaniaRelevance = topic.romaniaRelevance < 45;
  const sourceTooOld = (topic.sources || []).some((src) => typeof src.sourceAgeMinutes === 'number' && src.sourceAgeMinutes > maxAgeMinutes);
  const blockedReasons = [];

  if (tooOld) blockedReasons.push(`Subiect mai vechi de ${maxAgeMinutes} minute.`);
  if (duplicate) blockedReasons.push('Subiect deja abordat pe oficiuldestiri.ro.');
  if (!hasEnoughSources) blockedReasons.push('Nu are minimum două surse.');
  if (lowInterest) blockedReasons.push('Interesul estimat este prea scăzut.');
  if (lowRomaniaRelevance) blockedReasons.push('Relevanță prea mică pentru publicul din România.');
  if (sourceTooOld) blockedReasons.push(`Are surse mai vechi de ${maxAgeMinutes} minute.`);

  let recommendation = 'monitorizează';
  if (!blockedReasons.length && priorityScore >= 80) recommendation = 'scrie acum';
  if (blockedReasons.length || priorityScore < 55) recommendation = 'ignoră';

  return {
    ...topic,
    onlineCount: coverage.onlineCount ?? null,
    onlineMatches: coverage.onlineMatches || [],
    priorityScore,
    recommendation,
    coverage,
    eligibility: {
      isEligible: blockedReasons.length === 0,
      blockedReasons
    }
  };
}

async function checkOficiuCoverage(topic, options = {}) {
  const queries = buildCoverageQueries(topic);
  const deepScan = Boolean(options.deep);
  const maxAgeMinutes = Number(options.maxAgeMinutes || MAX_AGE_MINUTES);
  const errors = [];
  const matches = [];

  for (const q of queries) {
    const [wpPosts, wpSearch, internalSearch, cse, serp] = await Promise.all([
      fetchWpPosts(q, errors),
      fetchWpSearch(q, errors),
      (!FAST_OFICIU_SCAN || deepScan) ? fetchInternalSearch(q, errors) : Promise.resolve([]),
      fetchGoogleCse(q, errors),
      fetchSerpApi(q, errors)
    ]);

    matches.push(...wpPosts, ...wpSearch, ...internalSearch, ...cse, ...serp);
  }

  // Sitemap/recent index: util mai ales dacă WP REST este blocat.
  const sitemapMatches = (!FAST_OFICIU_SCAN || deepScan) ? await fetchSitemapCandidates(topic, errors) : [];
  matches.push(...sitemapMatches);

  const onlineArticles = await fetchGoogleNewsOnlineArticles(topic, errors, maxAgeMinutes);

  const deduped = uniqueBy(matches, (m) => m.url || `${m.source}|${m.title}`)
    .filter((m) => m.title || m.slug || m.url)
    .map((m) => ({
      ...m,
      similarity: calculateCoverageSimilarity(topic, m)
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 8);

  const best = deduped[0] || null;
  const similarity = best ? best.similarity : 0;
  const status = similarity >= 68 ? 'deja-acoperit' : similarity >= 38 ? 'posibil-similar' : 'neacoperit';

  return {
    status,
    similarity,
    onlineCount: onlineArticles.count,
    onlineMatches: onlineArticles.matches,
    label: status === 'neacoperit' ? 'Neacoperit' : status === 'posibil-similar' ? 'Posibil acoperit' : 'Deja acoperit',
    bestMatch: best,
    matches: deduped,
    methods: {
      wpRestPosts: true,
      wpRestSearch: true,
      internalSearch: !FAST_OFICIU_SCAN || deepScan,
      sitemap: !FAST_OFICIU_SCAN || deepScan,
      googleCse: Boolean(process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_ID),
      serpApi: Boolean(process.env.SERPAPI_KEY)
    },
    queries,
    errors: errors.slice(0, 5)
  };
}

function buildCoverageQueries(topic) {
  const title = cleanText(topic.title || '').replace(/[„”"']/g, ' ');
  const tokens = significantTokens(title).slice(0, 10);
  const keywordQuery = tokens.slice(0, 6).join(' ');
  const shortKeywordQuery = tokens.slice(0, 3).join(' ');
  const entityQuery = (topic.entities || []).slice(0, 4).join(' ');
  const keywordOnly = (topic.keywords || []).slice(0, 6).join(' ');
  const slugLike = normalize(title).replace(/\s+/g, ' ');

  const baseQueries = [
    title,
    keywordQuery,
    shortKeywordQuery,
    entityQuery,
    keywordOnly,
    slugLike
  ].map((q) => (q || '').replace(/\s+/g, ' ').trim()).filter((q) => q.length >= 3);

  // Oficiul de Știri folosește diacritice în titluri, dar utilizatorul poate scrie fără.
  // Aici păstrăm AMBELE forme: cu diacritice + fără diacritice + variante uzuale.
  return expandQueriesWithRomanianDiacritics(baseQueries, 16);
}

function expandQueriesWithRomanianDiacritics(queries, limit = 16) {
  const out = [];
  for (const q of queries) {
    if (!q) continue;
    const clean = String(q).replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    out.push(clean);
    out.push(normalize(clean));
    out.push(toRomanianDiacriticsGuess(clean));
    out.push(titleCaseDiacritics(toRomanianDiacriticsGuess(clean)));

    // Pentru titluri lungi: caută și fragmentele cele mai probabile.
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length >= 3) {
      out.push(words.slice(0, 4).join(' '));
      out.push(toRomanianDiacriticsGuess(words.slice(0, 4).join(' ')));
      out.push(words.slice(-4).join(' '));
      out.push(toRomanianDiacriticsGuess(words.slice(-4).join(' ')));
    }
  }

  return uniqueBy(
    out.map((q) => (q || '').replace(/\s+/g, ' ').trim()).filter((q) => q.length >= 3),
    (q) => normalize(q)
  ).slice(0, limit);
}

function toRomanianDiacriticsGuess(text) {
  let v = String(text || '');
  const replacements = [
    [/\boficiul de stiri\b/gi, 'Oficiul de Știri'],
    [/\bstiri\b/gi, 'știri'],
    [/\bstirile\b/gi, 'știrile'],
    [/\bbucuresti\b/gi, 'București'],
    [/\bromania\b/gi, 'România'],
    [/\bromaniei\b/gi, 'României'],
    [/\bromani\b/gi, 'români'],
    [/\bromanilor\b/gi, 'românilor'],
    [/\bnicusor\b/gi, 'Nicușor'],
    [/\brazboi\b/gi, 'război'],
    [/\brazboiul\b/gi, 'războiul'],
    [/\bgentiana\b/gi, 'Gențiana'],
    [/\bcabana gentiana\b/gi, 'Cabana Gențiana'],
    [/\bretezat\b/gi, 'Retezat'],
    [/\bcluj\b/gi, 'Cluj'],
    [/\bploiesti\b/gi, 'Ploiești'],
    [/\bbrasov\b/gi, 'Brașov'],
    [/\biasi\b/gi, 'Iași'],
    [/\bconstanta\b/gi, 'Constanța'],
    [/\btimisoara\b/gi, 'Timișoara'],
    [/\btargu\b/gi, 'Târgu'],
    [/\btargoviste\b/gi, 'Târgoviște'],
    [/\bpitesti\b/gi, 'Pitești'],
    [/\bgalati\b/gi, 'Galați'],
    [/\bcalatori\b/gi, 'călători'],
    [/\bcalatorii\b/gi, 'călătorii'],
    [/\bsanatate\b/gi, 'sănătate'],
    [/\binvatamant\b/gi, 'învățământ'],
    [/\beducatie\b/gi, 'educație'],
    [/\bpreturi\b/gi, 'prețuri'],
    [/\bfara\b/gi, 'fără'],
    [/\bin\b/gi, 'în'],
    [/\bsi\b/gi, 'și']
  ];
  for (const [re, repl] of replacements) v = v.replace(re, repl);
  return v;
}

function titleCaseDiacritics(text) {
  return String(text || '').replace(/\b\p{L}/gu, (m) => m.toUpperCase());
}

async function fetchWpPosts(q, errors) {
  const url = `${OFICIU_BASE}/wp-json/wp/v2/posts?per_page=10&search=${encodeURIComponent(q)}&_fields=link,title,slug,date,excerpt`;
  try {
    const text = await cached(`wp-posts:${q}`, CACHE_TTL_MS, () => fetchText(url));
    const json = JSON.parse(text);
    if (!Array.isArray(json)) return [];
    return json.map((post) => ({
      source: 'Oficiul de Știri WP posts',
      title: cleanText(post?.title?.rendered || post?.title || ''),
      slug: post.slug || '',
      url: post.link || '',
      date: post.date || ''
    }));
  } catch (error) {
    errors.push({ method: 'wp-posts', q, error: error.message });
    return [];
  }
}

async function fetchWpSearch(q, errors) {
  const url = `${OFICIU_BASE}/wp-json/wp/v2/search?search=${encodeURIComponent(q)}&per_page=10&subtype=post`;
  try {
    const text = await cached(`wp-search:${q}`, CACHE_TTL_MS, () => fetchText(url));
    const json = JSON.parse(text);
    if (!Array.isArray(json)) return [];
    return json.map((item) => ({
      source: 'Oficiul de Știri WP search',
      title: cleanText(item.title || ''),
      slug: item.slug || '',
      url: item.url || ''
    }));
  } catch (error) {
    errors.push({ method: 'wp-search', q, error: error.message });
    return [];
  }
}

async function fetchInternalSearch(q, errors) {
  const url = `${OFICIU_BASE}/?s=${encodeURIComponent(q)}`;
  try {
    const html = await cached(`internal-search:${q}`, CACHE_TTL_MS, () => fetchText(url));
    const links = extractLinksFromHtml(html)
      .filter((link) => link.url.startsWith(OFICIU_BASE))
      .filter((link) => !/\/(tag|category|author|page)\//.test(link.url))
      .slice(0, 12);

    return links.map((link) => ({
      source: 'Oficiul de Știri search public',
      title: link.text || titleFromSlug(link.url),
      slug: slugFromUrl(link.url),
      url: link.url
    }));
  } catch (error) {
    errors.push({ method: 'internal-search', q, error: error.message });
    return [];
  }
}

async function fetchGoogleCse(q, errors) {
  if (!process.env.GOOGLE_CSE_KEY || !process.env.GOOGLE_CSE_ID) return [];
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(process.env.GOOGLE_CSE_KEY)}&cx=${encodeURIComponent(process.env.GOOGLE_CSE_ID)}&q=${encodeURIComponent(`site:oficiuldestiri.ro ${q}`)}&num=10`;
  try {
    const text = await cached(`google-cse:${q}`, CACHE_TTL_MS, () => fetchText(url));
    const json = JSON.parse(text);
    return (json.items || []).map((item) => ({
      source: 'Google CSE site:oficiuldestiri.ro',
      title: cleanText(item.title || ''),
      url: item.link || '',
      snippet: cleanText(item.snippet || '')
    }));
  } catch (error) {
    errors.push({ method: 'google-cse', q, error: error.message });
    return [];
  }
}

async function fetchSerpApi(q, errors) {
  if (!process.env.SERPAPI_KEY) return [];
  const url = `https://serpapi.com/search.json?engine=google&num=10&q=${encodeURIComponent(`site:oficiuldestiri.ro ${q}`)}&api_key=${encodeURIComponent(process.env.SERPAPI_KEY)}`;
  try {
    const text = await cached(`serpapi:${q}`, CACHE_TTL_MS, () => fetchText(url));
    const json = JSON.parse(text);
    return (json.organic_results || []).map((item) => ({
      source: 'SerpAPI site:oficiuldestiri.ro',
      title: cleanText(item.title || ''),
      url: item.link || '',
      snippet: cleanText(item.snippet || '')
    }));
  } catch (error) {
    errors.push({ method: 'serpapi', q, error: error.message });
    return [];
  }
}


async function fetchGoogleNewsOnlineArticles(topic, errors, maxAgeMinutes = MAX_AGE_MINUTES) {
  const queries = buildCoverageQueries(topic).slice(0, 6);
  const now = new Date();
  const whenHours = Math.max(1, Math.ceil(maxAgeMinutes / 60));
  const when = `when:${whenHours}h`;
  const topicTokens = significantTokens(`${topic.title || ''} ${(topic.keywords || []).join(' ')} ${(topic.entities || []).join(' ')}`);
  const out = [];

  for (const q of queries) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} ${when}`)}&hl=ro&gl=RO&ceid=RO:ro`;

    try {
      const xml = await cached(`google-news-online:${q}`, Math.min(CACHE_TTL_MS, 15 * 60 * 1000), () => fetchText(url));
      const items = parseRssItems(xml);

      for (const item of items) {
        if (!item.pubDate) continue;
        const ageMinutes = Math.round((now - new Date(item.pubDate)) / 60000);
        if (!Number.isFinite(ageMinutes) || ageMinutes < 0 || ageMinutes > maxAgeMinutes) continue;
        const itemTokens = significantTokens(`${item.title || ''} ${item.description || ''}`);
        const sim = jaccard(topicTokens, itemTokens);
        const overlap = itemTokens.filter((t) => topicTokens.includes(t)).length;

        if (sim >= 0.16 || overlap >= 3) {
          out.push({
            source: item.source || inferHost(item.link) || 'Google News',
            title: cleanNewsTitle(item.title || ''),
            url: item.link || '',
            publishedAt: item.pubDate || '',
            similarity: Math.round(sim * 100)
          });
        }
      }
    } catch (error) {
      errors.push({ method: 'google-news-online', q, error: error.message });
    }
  }

  const unique = uniqueBy(out, (item) => item.url || `${normalize(item.source)}|${normalize(item.title)}`)
    .filter((item) => item.title || item.url)
    .sort((a, b) => (b.similarity || 0) - (a.similarity || 0));

  return {
    count: unique.length,
    matches: unique.slice(0, 10)
  };
}

async function fetchSitemapCandidates(topic, errors) {
  try {
    const entries = await cached('oficiu-sitemap-index', 30 * 60 * 1000, fetchOficiuSitemapIndex);
    const topicTokens = significantTokens(topic.title);
    return entries
      .map((entry) => ({
        source: 'Oficiul de Știri sitemap',
        title: entry.title || titleFromSlug(entry.url),
        slug: slugFromUrl(entry.url),
        url: entry.url,
        date: entry.lastmod || ''
      }))
      .filter((entry) => jaccard(topicTokens, significantTokens(`${entry.title} ${entry.slug}`)) >= 0.18)
      .slice(0, 10);
  } catch (error) {
    errors.push({ method: 'sitemap', error: error.message });
    return [];
  }
}

async function fetchOficiuSitemapIndex() {
  const roots = [
    `${OFICIU_BASE}/sitemap.xml`,
    `${OFICIU_BASE}/sitemap_index.xml`,
    `${OFICIU_BASE}/wp-sitemap.xml`,
    `${OFICIU_BASE}/post-sitemap.xml`,
    `${OFICIU_BASE}/wp-sitemap-posts-post-1.xml`
  ];

  const sitemapUrls = new Set();
  const entries = [];

  for (const root of roots) {
    try {
      const xml = await fetchText(root);
      for (const loc of extractXmlLocs(xml)) {
        if (/sitemap/i.test(loc) && sitemapUrls.size < 8) sitemapUrls.add(loc);
        if (!/sitemap/i.test(loc) && loc.includes(OFICIU_BASE)) entries.push({ url: loc, lastmod: extractLastmodForLoc(xml, loc) });
      }
    } catch (_) {
      // Continuă cu următorul sitemap posibil.
    }
  }

  for (const sitemapUrl of [...sitemapUrls].slice(0, 8)) {
    try {
      const xml = await fetchText(sitemapUrl);
      for (const loc of extractXmlLocs(xml)) {
        if (loc.includes(OFICIU_BASE) && !/\.(jpg|jpeg|png|webp|pdf)$/i.test(loc)) {
          entries.push({ url: loc, lastmod: extractLastmodForLoc(xml, loc) });
        }
      }
    } catch (_) {
      // Unele sitemapuri pot fi blocate sau nerelevante.
    }
  }

  return uniqueBy(entries, (entry) => entry.url).slice(0, 1000);
}

function extractXmlLocs(xml) {
  return [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((m) => cleanText(m[1])).filter(Boolean);
}

function extractLastmodForLoc(xml, loc) {
  const escaped = loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<url>[\\s\\S]*?<loc>${escaped}<\\/loc>[\\s\\S]*?<lastmod>([\\s\\S]*?)<\\/lastmod>[\\s\\S]*?<\\/url>`, 'i');
  const match = xml.match(re);
  return match ? cleanText(match[1]) : '';
}

function calculateCoverageSimilarity(topic, match) {
  const topicText = `${topic.title || ''} ${(topic.keywords || []).join(' ')} ${(topic.entities || []).join(' ')}`;
  const matchText = `${match.title || ''} ${match.slug || ''} ${match.snippet || ''}`;
  const topicTokens = significantTokens(topicText);
  const matchTokens = significantTokens(matchText);
  const titleSim = jaccard(significantTokens(topic.title || ''), significantTokens(match.title || match.slug || ''));
  const fullSim = jaccard(topicTokens, matchTokens);
  const entityOverlap = (topic.entities || []).length
    ? overlapRatio((topic.entities || []).map(normalize), matchTokens)
    : 0;
  const score = Math.max(titleSim, fullSim * 0.9, entityOverlap * 0.75);
  return Math.round(clamp(score * 100, 0, 100));
}

function calculatePriority({ trendScore, recencyScore, romaniaRelevance, coverageScore, seoPotential, impact }) {
  return Math.round(
    trendScore * 0.35 +
    recencyScore * 0.20 +
    romaniaRelevance * 0.15 +
    coverageScore * 0.15 +
    seoPotential * 0.10 +
    impact * 0.05
  );
}

function topicFromManualQuery(q) {
  const tokens = significantTokens(q);
  const classification = classifyTopic(q, tokens);
  return {
    id: stableId(q),
    title: q,
    keywords: tokens.slice(0, 8),
    entities: extractEntities(q),
    category: classification.category,
    interest: classification.interest
  };
}

function classifyTopic(title, tokens = significantTokens(title)) {
  let best = { category: 'Actualitate', interest: 'Social', subcategory: 'News', score: 0 };
  for (const rule of CATEGORY_RULES) {
    const score = rule.words.reduce((sum, word) => sum + (tokens.includes(normalize(word)) ? 1 : 0), 0);
    if (score > best.score) best = { ...rule, subcategory: inferSubcategory(rule.category, rule.interest), score };
  }
  return best;
}

function inferSubcategory(category, interest) {
  if (category === 'Politică') return 'Politică';
  if (category === 'Business') return 'Economie';
  if (category === 'Sport') return 'Sport';
  if (interest === 'Vedete/Showbiz') return 'Entertainment & Showbiz';
  if (interest === 'Horoscop/Lifestyle') return 'Life';
  if (interest === 'Justiție') return 'Anchete';
  if (interest === 'Travel') return 'Călătorii';
  return 'News';
}

function estimateTrendScore({ approxTraffic, sourceCount, newestSourceMinutesAgo, fromTrends }) {
  let score = fromTrends ? 68 : 52;
  score += Math.min(sourceCount, 6) * 5;
  score += Math.max(0, 25 - newestSourceMinutesAgo / 2);
  if (approxTraffic) score = Math.max(score, scaleTrafficToScore(approxTraffic));
  return Math.round(clamp(score, 0, 100));
}

function scaleTrafficToScore(value) {
  const n = parseApproxTraffic(value);
  if (n >= 500000) return 100;
  if (n >= 200000) return 96;
  if (n >= 100000) return 92;
  if (n >= 50000) return 88;
  if (n >= 20000) return 82;
  if (n >= 10000) return 76;
  if (n >= 5000) return 70;
  if (n >= 1000) return 62;
  return 55;
}

function parseApproxTraffic(value) {
  const clean = String(value || '').toLowerCase().replace(/[+,\s]/g, '');
  const match = clean.match(/([0-9]+(?:[.,][0-9]+)?)(k|m)?/i);
  if (!match) return 0;
  const num = Number(match[1].replace(',', '.'));
  const mult = match[2] === 'm' ? 1000000 : match[2] === 'k' ? 1000 : 1;
  return Math.round(num * mult);
}

function estimateRomaniaRelevance(title, tokens, sources) {
  const roSignals = ['romania', 'roman', 'romani', 'bucuresti', 'cluj', 'iasi', 'timisoara', 'constanta', 'guvern', 'anaf', 'bnr', 'mai', 'anm'];
  let score = 55;
  score += roSignals.filter((s) => tokens.includes(s)).length * 10;
  score += sources.some((s) => /\.ro\b|gov\.ro|bnr\.ro|anaf\.ro/i.test(s.url || s.name)) ? 15 : 0;
  return Math.round(clamp(score, 35, 100));
}

function estimateSeoPotential(title, tokens, trendScore, sourceCount) {
  let score = Math.min(100, 40 + trendScore * 0.45 + tokens.length * 3 + Math.min(sourceCount, 5) * 4);
  if (/ce|cum|cand|unde|cat|cine|explicat|calendar|lista|pret|facturi|pensii/i.test(normalize(title))) score += 8;
  return Math.round(clamp(score, 0, 100));
}

function estimateImpact(title, tokens, interest) {
  let score = 55;
  const publicUtility = ['meteo', 'trafic', 'taxe', 'facturi', 'pensii', 'salariu', 'sanatate', 'scoala', 'transport', 'aeroport', 'cutremur', 'incendiu'];
  score += publicUtility.filter((word) => tokens.includes(word)).length * 9;
  if (['Economie/Bani', 'Sănătate', 'Social', 'Educație'].includes(interest)) score += 12;
  if (tokens.includes('breaking')) score += 10;
  return Math.round(clamp(score, 35, 100));
}

function inferTrendStatus(score, newestMinutes, sourceCount, fromTrends) {
  if (fromTrends && score >= 92) return 'breakout';
  if (score >= 78 && newestMinutes <= 60) return 'în creștere';
  if (score >= 55 && sourceCount >= 2) return 'activ';
  return 'în scădere';
}

function inferIntensity(score) {
  if (score >= 88) return 'exploziv';
  if (score >= 72) return 'ridicat';
  if (score >= 52) return 'mediu';
  return 'in-scadere';
}

function inferRisk(title, tokens, interest) {
  const riskSignals = HIGH_RISK_WORDS.filter((word) => tokens.includes(normalize(word))).length;
  if (riskSignals >= 2 || ['Justiție', 'Sănătate', 'Economie/Bani'].includes(interest)) return 'mare';
  if (riskSignals === 1 || /breaking|accident|ancheta|dosar/i.test(normalize(title))) return 'mediu';
  return 'mic';
}


function pluralSursa(count) {
  return Number(count) === 1 ? 'sursă' : 'surse';
}

function buildSummary(title, interest, sources) {
  return `Subiect detectat ca posibil relevant pentru ${interest.toLowerCase()}, cu ${sources} ${pluralSursa(sources)} publice în fluxurile monitorizate. Verifică datele oficiale, apoi folosește un unghi propriu pentru publicul român.`;
}

function buildReason(trendScore, romaniaRelevance, sourceCount, interest, maxAgeMinutes = MAX_AGE_MINUTES) {
  return `Merită urmărit deoarece are scor de interes ${trendScore}/100, relevanță pentru România ${romaniaRelevance}/100 și apare în ${sourceCount} ${pluralSursa(sourceCount)} publicate în intervalul selectat. Unghi recomandat: utilitate practică pentru cititorii interesați de ${interest.toLowerCase()}.`;
}

function buildSeoTitle(title) {
  const clean = title.replace(/\s+-\s+[^-]+$/, '').trim();
  return clean.length > 76 ? `${clean.slice(0, 73).trim()}...` : clean;
}

function buildMeta(title, interest) {
  return `Află pe scurt ce se știe despre ${title}, de ce contează pentru români și ce informații trebuie confirmate înainte de publicare.`.slice(0, 158);
}

function buildEditorialAngle(interest, title) {
  const map = {
    'Economie/Bani': 'Explică impactul în bani: cine este afectat, ce se schimbă concret și ce document oficial trebuie verificat.',
    'Politică': 'Separă declarațiile de decizii oficiale și explică efectul politic pentru public.',
    'Social': 'Fă articol util: ce s-a întâmplat, unde, când și ce trebuie să facă cititorii.',
    'Sănătate': 'Folosește doar surse medicale/oficiale și evită recomandările medicale neverificate.',
    'Educație': 'Listează clar cine este vizat: elevi, părinți, profesori, calendar și documente oficiale.',
    'Sport': 'Pune accent pe confirmare, context și reacții oficiale ale clubului/ligii.',
    'Travel': 'Transformă subiectul în ghid pentru pasageri: rute, ore, drepturi și linkuri oficiale.'
  };
  return map[interest] || `Găsește unghiul „ce înseamnă pentru români” și evită rescrierea articolelor altor publicații.`;
}

function buildWarnings(risk, fromTrends) {
  const warnings = [];
  if (risk === 'mare') warnings.push('Risc editorial mare: verificare suplimentară obligatorie înainte de publicare.');
  if (risk === 'mediu') warnings.push('Verifică minimum două surse independente sau o sursă oficială.');
  if (fromTrends) warnings.push('Google Trends indică interes de căutare, nu confirmă factual informația.');
  warnings.push('Nu copia textul altor publicații; folosește sursele doar pentru verificare și context.');
  return warnings;
}

function buildDoNotSay(risk, interest) {
  const items = ['Nu afirma că informația este certă dacă sursele nu sunt oficiale.'];
  if (risk === 'mare') items.push('Nu formula acuzații, concluzii medicale sau financiare fără documente confirmate.');
  if (interest === 'Justiție') items.push('Nu încălca prezumția de nevinovăție.');
  if (interest === 'Sănătate') items.push('Nu oferi sfaturi medicale personalizate.');
  return items;
}

function chooseRepresentativeTitle(titles, fallback) {
  const cleaned = titles.map(cleanNewsTitle).filter(Boolean);
  if (!cleaned.length) return fallback;
  cleaned.sort((a, b) => scoreTitle(b) - scoreTitle(a));
  return cleaned[0];
}

function scoreTitle(title) {
  let score = 0;
  const len = title.length;
  if (len >= 45 && len <= 95) score += 20;
  score += significantTokens(title).length;
  if (/romania|romani|guvern|meteo|taxe|pensii|sport|bucuresti/i.test(normalize(title))) score += 6;
  return score;
}

function chooseHighestTraffic(values) {
  if (!values.length) return '';
  return values.slice().sort((a, b) => parseApproxTraffic(b) - parseApproxTraffic(a))[0];
}

function extractEntities(text) {
  const words = String(text || '').match(/(?:[A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+){0,3})/g) || [];
  return uniqueBy(words.map((w) => w.trim()).filter((w) => w.length > 3), normalize).slice(0, 8);
}

function addSource(sources, source) {
  if (!source.name && !source.url) return;
  const key = `${normalize(source.name || '')}|${source.url || ''}`;
  if (!sources.some((s) => `${normalize(s.name || '')}|${s.url || ''}` === key)) {
    sources.push(source);
  }
}

function isOfficialUrl(url = '') {
  return OFFICIAL_HINTS.some((domain) => String(url).toLowerCase().includes(domain));
}

function cleanNewsTitle(title) {
  let cleaned = cleanText(title);
  // Google News RSS folosește des „Titlu - Publicație”. Scoatem doar sursa de la final, nu cratimele din titlu.
  cleaned = cleaned.replace(/\s+-\s+([A-ZĂÂÎȘȚa-zăâîșț0-9 .]+)$/u, (full, source) => {
    return source.length <= 34 ? '' : full;
  }).trim();
  return cleaned;
}

function inferSourceFromTitle(title) {
  const clean = cleanText(title);
  const parts = clean.split(/\s+-\s+/);
  return parts.length > 1 ? parts[parts.length - 1].trim() : '';
}

function extractLinksFromHtml(html) {
  const links = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(re)) {
    const url = absolutizeUrl(cleanText(match[1]), OFICIU_BASE);
    const text = cleanText(stripHtml(match[2]));
    if (url && text && text.length >= 12) links.push({ url, text });
  }
  return uniqueBy(links, (l) => l.url);
}

function stripHtml(input) {
  return String(input || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
}

function stripCdata(input) {
  return String(input || '').replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
}

function cleanText(input) {
  return decodeHtml(stripCdata(String(input || '')))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtml(input) {
  return String(input || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ș/g, 's').replace(/ț/g, 't')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantTokens(text) {
  return normalize(text)
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .filter((token) => !STOPWORDS_RO.has(token))
    .slice(0, 40);
}

function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection += 1;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

function overlapRatio(items, tokens) {
  const tokenSet = new Set(tokens);
  const cleanItems = items.filter(Boolean);
  if (!cleanItems.length) return 0;
  const matches = cleanItems.filter((item) => tokenSet.has(item) || significantTokens(item).some((t) => tokenSet.has(t))).length;
  return matches / cleanItems.length;
}

function stableId(text) {
  return normalize(text).split(' ').slice(0, 8).join('-') || `topic-${Date.now()}`;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(cleanText(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function inferHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function slugFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.replace(/\/$/, '');
    return pathname.split('/').pop() || '';
  } catch (_) {
    return '';
  }
}

function titleFromSlug(urlOrSlug) {
  const slug = urlOrSlug.includes('http') ? slugFromUrl(urlOrSlug) : urlOrSlug;
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function absolutizeUrl(url, base) {
  try {
    return new URL(url, base).href;
  } catch (_) {
    return '';
  }
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/rss+xml, application/xml, application/json, text/html, text/plain;q=0.8',
        'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.6',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} pentru ${url}`);
    return await response.text();
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.message === 'This operation was aborted')) {
      throw new Error(`Timeout după ${REQUEST_TIMEOUT_MS}ms pentru ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function cached(key, ttlMs, producer) {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && entry.expiresAt > now) return entry.value;
  const value = await producer();
  cache.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await mapper(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function json(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=60'
    });
    res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}


async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('Body prea mare'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (_) { reject(new Error('JSON invalid')); }
    });
    req.on('error', reject);
  });
}

async function buildContactDrafts(topic) {
  const localContacts = await loadLocalDeputyContacts();
  const publicFromSources = await extractPublicContactsFromSources(topic);
  const ruleContacts = inferOfficialContactTargets(topic);
  const localMatches = matchLocalPoliticalContacts(topic, localContacts);

  const candidates = uniqueBy([...ruleContacts, ...localMatches, ...publicFromSources],
    (c) => `${normalize(c.name || '')}|${normalize(c.role || '')}|${normalize(c.email || '')}|${normalize(c.phone || '')}`)
    .slice(0, 12)
    .map((c, index) => ({ ...c, id: c.id || `contact-${index + 1}` }));

  const drafts = candidates.map((contact) => ({
    contactId: contact.id,
    toLabel: contact.email || contact.phone || contact.url || 'Contact de completat manual',
    subject: buildContactEmailSubject(topic, contact),
    body: buildContactEmailBody(topic, contact),
    questions: buildContactQuestions(topic, contact)
  }));

  return {
    topicId: topic.id || stableId(topic.title),
    topicTitle: topic.title,
    generatedAt: new Date().toISOString(),
    notice: 'Contactele din fișierul încărcat sunt folosite local. Contactele publice sunt extrase doar când apar explicit pe pagini accesibile public; nu se inventează numere sau e-mailuri.',
    candidates,
    drafts
  };
}

async function loadLocalDeputyContacts() {
  try {
    const text = await fs.readFile(LOCAL_CONTACTS_PATH, 'utf8');
    const list = JSON.parse(text);
    return Array.isArray(list) ? list : [];
  } catch (_) { return []; }
}

function inferOfficialContactTargets(topic) {
  const text = normalize(`${topic.title || ''} ${(topic.entities || []).join(' ')} ${(topic.keywords || []).join(' ')} ${topic.interest || ''}`);
  const contacts = [];
  const add = (name, role, url, reason, competence, email = '', phone = '') => contacts.push({ type: 'oficial', name, role, url, reason, competence, email, phone, confidence: 70 });

  if (/presedint|cotroceni|nicusor|ziua europei|csat/.test(text)) add('Administrația Prezidențială', 'Biroul de presă / comunicare publică', 'https://www.presidency.ro/ro/contact', 'Subiect cu miză prezidențială sau instituțională.', 'poate confirma agenda, poziția oficială și contextul instituțional.');
  if (/guvern|premier|minister|coalitie|motiune|ordonanta|hotarare/.test(text)) add('Guvernul României', 'Biroul de presă', 'https://gov.ro/ro/contact', 'Subiect cu posibilă decizie guvernamentală.', 'poate confirma calendarul, decizia oficială și instituțiile implicate.');
  if (/anaf|taxe|impozit|tva|fiscal|contribuabil/.test(text)) add('ANAF', 'Comunicare publică', 'https://www.anaf.ro/anaf/internet/ANAF/contact', 'Subiect fiscal / contribuabili.', 'poate clarifica aplicarea practică, termenele și categoriile vizate.');
  if (/bnr|dobanzi|curs|inflatie|banca|credit|rate/.test(text)) add('BNR', 'Comunicare publică', 'https://www.bnr.ro/Contact-16.aspx', 'Subiect monetar / dobânzi / curs.', 'poate oferi date oficiale și context economic.');
  if (/anm|meteo|vreme|cod galben|cod portocaliu|furtuna|canicula|ploi/.test(text)) add('Administrația Națională de Meteorologie', 'Relații publice / prognoză', 'https://www.meteoromania.ro/', 'Subiect meteo cu impact public.', 'poate confirma avertizările, intervalele și zonele vizate.');
  if (/politie|accident|trafic|dosar|ancheta|mai|frontiera/.test(text)) add('Poliția Română / MAI', 'Comunicare publică', 'https://www.politiaromana.ro/ro/contact', 'Subiect de ordine publică / incident / trafic.', 'poate confirma datele operative și măsurile luate.');
  if (/isu|dsu|incendiu|explozie|urgenta|evacuare/.test(text)) add('DSU / IGSU', 'Comunicare publică', 'https://www.igsu.ro/', 'Subiect de urgență publică.', 'poate confirma bilanțul, intervenția și recomandările pentru populație.');
  if (/educatie|scoala|bac|evaluare|elev|profesor|admitere/.test(text)) add('Ministerul Educației', 'Biroul de presă', 'https://www.edu.ro/contact', 'Subiect de educație.', 'poate confirma calendarul, metodologia și categoriile de elevi vizate.');
  if (/sanatate|spital|medicament|pacient|boala|vaccin/.test(text)) add('Ministerul Sănătății', 'Biroul de presă', 'https://www.ms.ro/ro/contact/', 'Subiect medical / sănătate publică.', 'poate confirma datele oficiale și recomandările publice.');
  if (/ue|bruxelles|parlamentul european|comisia europeana|nato|rusia|ucraina|moldova|razboi/.test(text)) add('Ministerul Afacerilor Externe', 'Comunicare publică', 'https://www.mae.ro/contact', 'Subiect extern cu miză pentru România.', 'poate confirma poziția României și contextul diplomatic.');

  return contacts;
}

function matchLocalPoliticalContacts(topic, contacts) {
  if (!contacts.length) return [];
  const text = normalize(`${topic.title || ''} ${(topic.entities || []).join(' ')} ${(topic.keywords || []).join(' ')} ${topic.interest || ''}`);
  const parties = ['PSD', 'PNL', 'USR', 'AUR', 'UDMR', 'POT', 'SOS'];
  const counties = { alba:'ALBA', arad:'ARAD', arges:'ARGEŞ', bacau:'BACĂU', bihor:'BIHOR', bistrita:'BISTRIŢA', botosani:'BOTOŞANI', brasov:'BRAŞOV', braila:'BRĂILA', bucuresti:'BUCUREŞTI', buzau:'BUZĂU', cluj:'CLUJ', constanta:'CONSTANŢA', dolj:'DOLJ', galati:'GALAŢI', iasi:'IAŞI', timis:'TIMIŞ', prahova:'PRAHOVA', suceava:'SUCEAVA', tulcea:'TULCEA' };

  const titleTokens = new Set(text.split(/\s+/).filter(Boolean));
  const nameMatches = contacts.filter((c) => normalize(c.name).split(/\s+/).some((part) => part.length > 5 && titleTokens.has(part)));
  const detectedParties = parties.filter((p) => titleTokens.has(normalize(p)));
  const partyMatches = detectedParties.length ? contacts.filter((c) => detectedParties.some((p) => normalize(c.party).includes(normalize(p)))).slice(0, 4) : [];
  const countyKeys = Object.keys(counties).filter((k) => titleTokens.has(k));
  const countyMatches = countyKeys.length ? contacts.filter((c) => countyKeys.some((k) => normalize(c.constituency).includes(normalize(counties[k])))).slice(0, 4) : [];
  const politicalContext = /politic|guvern|parlament|deputat|senat|motiune|lege|alegeri|psd|pnl|usr|aur|udmr|nicusor|simion|ciolacu|bolojan/.test(text);
  const genericPolitical = politicalContext && !nameMatches.length && !partyMatches.length && !countyMatches.length
    ? contacts.filter((c) => ['PSD', 'PNL', 'USR', 'AUR', 'UDMR'].some((p) => normalize(c.party).includes(normalize(p)))).slice(0, 5)
    : [];

  return uniqueBy([...nameMatches, ...partyMatches, ...countyMatches, ...genericPolitical], (c) => `${normalize(c.name)}|${c.phone}`)
    .slice(0, 8)
    .map((c) => ({
      type: 'contact local',
      name: c.name,
      role: `Deputat ${c.party || ''}${c.constituency ? ` · ${c.constituency}` : ''}`,
      phone: c.phone,
      email: '',
      url: '',
      reason: 'Contact din fișierul încărcat de redacție.',
      competence: 'poate oferi reacție politică, poziție de partid sau context parlamentar, dacă subiectul are componentă politică.',
      confidence: 78
    }));
}

async function extractPublicContactsFromSources(topic) {
  const out = [];
  const sources = (topic.sources || []).filter((s) => s.url && /^https?:\/\//.test(s.url)).slice(0, 4);
  for (const source of sources) {
    try {
      const html = await fetchText(source.url);
      const text = cleanText(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '));
      const emails = uniqueBy((html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []), (x) => x.toLowerCase()).slice(0, 3);
      const phones = uniqueBy((text.match(/(?:\+4)?0[237][0-9][\s.-]?[0-9]{3}[\s.-]?[0-9]{3}/g) || []), normalize).slice(0, 3);
      for (const email of emails) out.push({ type: 'extras public', name: source.name || domainFromUrl(source.url), role: 'E-mail public extras din pagina sursei', email, phone: '', url: source.url, reason: 'E-mail găsit public în pagina sursei.', competence: 'poate ajuta la clarificare, dar verifică dacă adresa este potrivită pentru presă.', confidence: 55 });
      for (const phone of phones) out.push({ type: 'extras public', name: source.name || domainFromUrl(source.url), role: 'Telefon public extras din pagina sursei', email: '', phone, url: source.url, reason: 'Telefon găsit public în pagina sursei.', competence: 'folosește prudent: verifică dacă este contact redacțional/instituțional, nu număr personal irelevant.', confidence: 45 });
    } catch (_) {}
  }
  return out.slice(0, 6);
}

function buildContactEmailSubject(topic, contact) {
  const base = (topic.title || 'subiect de actualitate').replace(/\s+/g, ' ').trim();
  if (contact.type === 'contact local') return `Solicitare punct de vedere – ${base}`;
  if (/ANAF|BNR|ANM|Minister|Guvern|Poliția|DSU|Administrația/i.test(contact.name || contact.role || '')) return `Solicitare confirmare oficială – ${base}`;
  return `Solicitare informații pentru articol – ${base}`;
}

function buildContactEmailBody(topic, contact) {
  const questions = buildContactQuestions(topic, contact);
  const roleLine = contact.role ? `Vă contactez în legătură cu aria dumneavoastră de competență: ${contact.role}.` : 'Vă contactez pentru o clarificare legată de un subiect de actualitate.';
  const competenceLine = contact.competence ? `Am considerat relevantă solicitarea deoarece ${contact.competence}` : '';
  return [`Bună ziua,`, ``, `Sunt (numele tău), redactor la Oficiul de Știri.`, roleLine, ``, `Pregătesc un material despre: „${topic.title}”. ${competenceLine}`, `Pentru acuratețe, aș avea nevoie de câteva clarificări:`, ``, ...questions.map((q, i) => `${i + 1}. ${q}`), ``, `Dacă este posibil, vă rog să îmi transmiteți un răspuns în scris sau să îmi indicați persoana competentă pentru acest subiect.`, ``, `Menționez că nu voi atribui declarații care nu sunt confirmate explicit.`, ``, `Mulțumesc,`, `(numele tău)`, `Oficiul de Știri`].join('\n');
}

function buildContactQuestions(topic, contact) {
  const text = normalize(`${topic.title || ''} ${topic.interest || ''} ${(topic.entities || []).join(' ')}`);
  const official = contact.type === 'oficial';
  const political = /politic|guvern|parlament|deputat|senat|psd|pnl|usr|aur|udmr|motiune|lege|premier|presedint/.test(text) || contact.type === 'contact local';
  const economy = /anaf|bnr|taxe|tva|facturi|energie|pret|salarii|pensii|dobanzi|curs|buget/.test(text);
  const social = /accident|vreme|meteo|cod|trafic|sanatate|educatie|scoala|spital|politie|isu/.test(text);
  if (economy) return [`Care este informația oficială confirmată în acest moment privind subiectul „${topic.title}”?`, 'Ce categorii de persoane, firme sau contribuabili sunt afectate direct?', 'Există un calendar, termen sau document oficial care trebuie consultat?', 'Care este impactul practic: costuri, plăți, rate, facturi, taxe sau obligații?', 'Ce ar trebui să verifice cititorii pentru a evita interpretări greșite?'];
  if (political) return [`Care este poziția dumneavoastră/instituției privind subiectul „${topic.title}”?`, 'Există o decizie oficială sau este, deocamdată, doar o declarație politică?', 'Care este următorul pas concret: vot, negociere, ședință, document, comunicat?', 'Cine este afectat direct de această evoluție și în ce mod?', 'Ce elemente considerați că lipsesc din relatarea publică de până acum?'];
  if (social) return [`Ce date sunt confirmate oficial în acest moment despre „${topic.title}”?`, 'Care sunt zonele, persoanele sau categoriile afectate?', 'Ce recomandări concrete există pentru public?', 'Există un interval, termen sau o evoluție estimată pentru următoarele ore?', 'Unde pot cititorii verifica informațiile oficiale actualizate?'];
  if (official) return [`Ce informații puteți confirma oficial despre „${topic.title}”?`, 'Există un document, comunicat sau calendar oficial disponibil public?', 'Care este impactul concret pentru publicul din România?', 'Ce urmează în următoarele ore sau zile?', 'Există o persoană/instituție mai potrivită pentru clarificări suplimentare?'];
  return [`Ce puteți confirma despre subiectul „${topic.title}”?`, 'Care este sursa primară a informației?', 'Ce detalii sunt încă neconfirmate?', 'Care este miza pentru publicul din România?', 'Ce evoluții ar trebui urmărite în următoarele ore?'];
}

function domainFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return 'sursă publică'; }
}


main().catch((error) => {
  console.error(error);
  process.exit(1);
});
