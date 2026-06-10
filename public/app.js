'use strict';

const THEME_KEY = 'radarEditorialExtern.theme';
const ALERTED_KEY = 'radarEditorialExtern.alertedWriteNowIds';
const RISK_ORDER = { mic: 1, mediu: 2, mare: 3 };
const LIVE_REFRESH_MS = 3 * 60 * 1000;
const MAX_STORED_ALERT_IDS = 250;

const state = {
  topics: [],
  topicStore: new Map(),
  lastUpdate: null,
  currentCategory: 'toate',
  loading: false,
  stats: null,
  sourceErrors: [],
  firstLoadDone: false,
  liveMode: false,
  liveTimer: null,
  lastLiveTick: 0,
  audioContext: null,
  alertsReady: false,
  alertedIds: new Set(loadAlertedIds())
};

const el = {
  refreshBtn: document.getElementById('refreshBtn'),
  exportBtn: document.getElementById('exportBtn'),
  themeBtn: document.getElementById('themeBtn'),
  lastUpdateLabel: document.getElementById('lastUpdateLabel'),
  freshnessDot: document.getElementById('freshnessDot'),
  freshnessAlert: document.getElementById('freshnessAlert'),
  liveStatusLabel: document.getElementById('liveStatusLabel'),
  searchInput: document.getElementById('searchInput'),
  interestFilter: document.getElementById('interestFilter'),
  intensityFilter: document.getElementById('intensityFilter'),
  ageFilter: document.getElementById('ageFilter'),
  coverageFilter: document.getElementById('coverageFilter'),
  sortFilter: document.getElementById('sortFilter'),
  resetFiltersBtn: document.getElementById('resetFiltersBtn'),
  topicsGrid: document.getElementById('topicsGrid'),
  emptyState: document.getElementById('emptyState'),
  loader: document.getElementById('loader'),
  resultsSummary: document.getElementById('resultsSummary'),
  eligibleMetric: document.getElementById('eligibleMetric'),
  checkedMetric: document.getElementById('checkedMetric'),
  blockedMetric: document.getElementById('blockedMetric'),
  topScoreMetric: document.getElementById('topScoreMetric'),
  sourceNotice: document.getElementById('sourceNotice'),
  manualCheckInput: document.getElementById('manualCheckInput'),
  manualCheckBtn: document.getElementById('manualCheckBtn'),
  manualResult: document.getElementById('manualResult'),
  briefDialog: document.getElementById('briefDialog'),
  dialogTitle: document.getElementById('dialogTitle'),
  dialogBody: document.getElementById('dialogBody'),
  closeDialogBtn: document.getElementById('closeDialogBtn')
};

init();

function init() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'light');
  bindEvents();
  updateLiveStatus();
  loadRadar(false);
  setInterval(updateFreshnessUI, 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.liveMode && Date.now() - state.lastLiveTick > 45 * 1000) {
      loadRadar(true);
    }
  });
  window.addEventListener('focus', () => {
    if (state.liveMode && Date.now() - state.lastLiveTick > 45 * 1000) {
      loadRadar(true);
    }
  });
}

function bindEvents() {
  el.refreshBtn.addEventListener('click', startLiveMode);
  el.exportBtn.addEventListener('click', exportCsv);
  el.themeBtn.addEventListener('click', toggleTheme);
  el.resetFiltersBtn.addEventListener('click', resetFilters);
  el.closeDialogBtn.addEventListener('click', () => el.briefDialog.close());
  if (el.manualCheckBtn && el.manualCheckInput) {
    el.manualCheckBtn.addEventListener('click', runManualCheck);
    el.manualCheckInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') runManualCheck();
    });
  }

  [el.searchInput, el.interestFilter, el.intensityFilter, el.coverageFilter, el.sortFilter]
    .forEach((input) => input.addEventListener('input', render));
  el.ageFilter.addEventListener('input', () => {
    pruneStoredTopics();
    render();
    if (state.liveMode && !state.loading) loadRadar(true);
  });

  document.querySelectorAll('.nav-pill').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.nav-pill').forEach((btn) => btn.classList.remove('active'));
      button.classList.add('active');
      state.currentCategory = button.dataset.category;
      render();
    });
  });

  el.topicsGrid.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const topic = state.topics.find((item) => item.id === button.dataset.id);
    if (!topic) return;

    const conceptActions = ['brief', 'titles', 'contacts', 'links', 'draft'];
    if (conceptActions.includes(button.dataset.action)) {
      showApiConceptNotice(button.dataset.action, topic);
      return;
    }
  });
}

async function startLiveMode() {
  await ensureAlertsReady();
  state.liveMode = true;
  updateLiveStatus();
  if (state.liveTimer) clearInterval(state.liveTimer);
  await loadRadar(true);
  state.liveTimer = setInterval(() => {
    if (!state.loading) loadRadar(true);
  }, LIVE_REFRESH_MS);
}

async function loadRadar(forceFresh) {
  setLoading(true);
  const maxAge = getSelectedMaxAgeMinutes();
  try {
    const params = new URLSearchParams();
    if (forceFresh) params.set('fresh', '1');
    params.set('maxAge', String(maxAge));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    const response = await fetch(`/api/radar?${params.toString()}`, { cache: 'no-store', signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const incomingTopics = Array.isArray(data.topics) ? data.topics : [];
    const newVisibleWriteNow = mergeIncomingTopics(incomingTopics);
    pruneStoredTopics();
    state.topics = Array.from(state.topicStore.values());
    state.lastUpdate = data.generatedAt ? new Date(data.generatedAt) : new Date();
    state.lastLiveTick = Date.now();
    state.stats = data.stats || null;
    state.sourceErrors = data.sourceErrors || [];
    updateNotice(data);
    render();
    notifyWriteNowTopics(newVisibleWriteNow);
  } catch (error) {
    console.warn('Folosesc date demo fallback:', error);
    const fallback = buildFallbackData();
    mergeIncomingTopics(fallback.topics);
    state.topics = Array.from(state.topicStore.values());
    state.lastUpdate = new Date(fallback.generatedAt);
    state.stats = fallback.stats;
    state.sourceErrors = [{ source: 'API live', error: 'Backendul nu a răspuns la timp sau Render a returnat 502. Apasă Refresh live peste câteva secunde.' }];
    el.sourceNotice.innerHTML = `<strong>Scanare întreruptă:</strong> backendul nu a răspuns la timp. Render poate fi în cold start sau o sursă externă răspunde greu. Apasă din nou Refresh live.`;
    render();
  } finally {
    setLoading(false);
    updateFreshnessUI();
    updateLiveStatus();
  }
}

function mergeIncomingTopics(incomingTopics) {
  const maxAge = getSelectedMaxAgeMinutes();
  const newVisibleWriteNow = [];

  for (const rawTopic of incomingTopics) {
    const topic = withCurrentAge(rawTopic);
    if (!topic.id || !isTopicWithinSelectedInterval(topic, maxAge)) continue;

    const existed = state.topicStore.has(topic.id);
    const previous = state.topicStore.get(topic.id) || {};
    state.topicStore.set(topic.id, {
      ...previous,
      ...topic,
      firstSeenAt: previous.firstSeenAt || new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    });

    if (!existed && shouldAlertForTopic(topic)) {
      newVisibleWriteNow.push(topic);
    }
  }

  return newVisibleWriteNow;
}

function pruneStoredTopics() {
  const maxAge = getSelectedMaxAgeMinutes();
  for (const [id, topic] of state.topicStore.entries()) {
    const updated = withCurrentAge(topic);
    if (!isTopicWithinSelectedInterval(updated, maxAge)) {
      state.topicStore.delete(id);
    } else {
      state.topicStore.set(id, updated);
    }
  }
}

function withCurrentAge(topic) {
  const copy = { ...topic };
  if (copy.startedAt) {
    const started = new Date(copy.startedAt).getTime();
    if (Number.isFinite(started)) {
      copy.startedMinutesAgo = Math.max(0, Math.round((Date.now() - started) / 60000));
    }
  }
  if (Array.isArray(copy.sources)) {
    copy.sources = copy.sources.map((source) => {
      if (!source.publishedAt) return source;
      const ts = new Date(source.publishedAt).getTime();
      if (!Number.isFinite(ts)) return source;
      return { ...source, sourceAgeMinutes: Math.max(0, Math.round((Date.now() - ts) / 60000)) };
    });
  }
  return copy;
}

function isTopicWithinSelectedInterval(topic, maxAge) {
  return Number(topic.startedMinutesAgo || 0) <= maxAge;
}

function shouldAlertForTopic(topic) {
  if (!topic.eligibility?.isEligible) return false;
  if (topic.recommendation !== 'scrie acum') return false;
  if (state.alertedIds.has(topic.id)) return false;
  const visibleIds = new Set(getFilteredTopics([...state.topicStore.values(), topic]).map((item) => item.id));
  return visibleIds.has(topic.id);
}

async function ensureAlertsReady() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass && !state.audioContext) {
      state.audioContext = new AudioContextClass();
    }
    if (state.audioContext?.state === 'suspended') await state.audioContext.resume();
  } catch (_) {}

  try {
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  } catch (_) {}

  state.alertsReady = true;
}

function notifyWriteNowTopics(topics) {
  if (!topics.length) return;
  const topic = topics.sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0))[0];
  markAlerted(topic.id);
  playWriteNowSound();
  document.title = `🔥 Scrie acum: ${topic.title}`;

  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Radar Editorial PRO: SCRIE ACUM', {
        body: `${topic.title} · scor ${topic.priorityScore || 0}`,
        tag: `radar-${topic.id}`,
        requireInteraction: false
      });
    }
  } catch (_) {}
}

function markAlerted(id) {
  if (!id) return;
  state.alertedIds.add(id);
  const ids = Array.from(state.alertedIds).slice(-MAX_STORED_ALERT_IDS);
  state.alertedIds = new Set(ids);
  localStorage.setItem(ALERTED_KEY, JSON.stringify(ids));
}

function loadAlertedIds() {
  try {
    const raw = JSON.parse(localStorage.getItem(ALERTED_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

function playWriteNowSound() {
  try {
    const ctx = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
    state.audioContext = ctx;
    const now = ctx.currentTime;
    [0, 0.18, 0.36].forEach((offset) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, now + offset);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.08, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.14);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.15);
    });
  } catch (_) {}
}


function pluralSursa(count) {
  return Number(count) === 1 ? 'sursă' : 'surse';
}

function pluralAu(count) {
  return Number(count) === 1 ? 'A existat' : 'Au existat';
}


function getRadarSourceCount(topic) {
  return Number(topic?.sourceCount || (topic?.sources || []).length || 0);
}

function getOnlineCount(topic) {
  const radarCount = getRadarSourceCount(topic);
  const onlineCount = Number(topic?.onlineCount || 0);
  if (Number.isFinite(onlineCount) && onlineCount > 0) {
    return Math.max(onlineCount, radarCount);
  }
  return radarCount || '—';
}

function renderOnlineArticleLinks(topic) {
  const online = Array.isArray(topic?.onlineMatches) ? topic.onlineMatches : [];
  const fallback = Array.isArray(topic?.sources) ? topic.sources : [];
  const items = (online.length ? online : fallback)
    .filter((item) => item && (item.url || item.link))
    .slice(0, 10);

  if (!items.length) return '';

  return `
    <div class="online-article-links">
      <strong>Articole / surse în interval</strong>
      <ul>
        ${items.map((item, index) => {
          const url = item.url || item.link || '#';
          const title = item.title || item.name || item.source || `Articol ${index + 1}`;
          const source = item.source || item.name || '';
          const label = source ? `${source}: ${title}` : title;
          return `<li><a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a></li>`;
        }).join('')}
      </ul>
      <p class="online-note">Număr orientativ. Verifică manual înainte de publicare.</p>
    </div>
  `;
}


function formatSourceCount(count) {
  const n = Number(count || 0);
  return `${n} ${pluralSursa(n)}`;
}

function formatAuthor(source) {
  const author = source?.author || source?.creator || source?.byline || source?.publisher || '';
  return ` · autor: ${author || 'neprecizat'}`;
}

function updateNotice(data) {
  const errors = (data.sourceErrors || []).length;
  const message = errors
    ? `${pluralAu(errors)} ${errors} ${pluralSursa(errors)} care nu au răspuns, dar dashboardul a continuat cu restul fluxurilor.`
    : 'Fluxurile au fost citite. PRO strict: intră doar subiecte cu dată publică în intervalul ales; linkurile nested fără dată sunt ascunse.';

  el.sourceNotice.innerHTML = `<strong>Scanare externă:</strong> ${escapeHtml(message)}`;
}

function setLoading(isLoading) {
  state.loading = isLoading;
  el.loader.classList.toggle('hidden', !isLoading);
  el.refreshBtn.disabled = isLoading;
  if (isLoading) el.refreshBtn.textContent = 'Se scanează...';
  else el.refreshBtn.textContent = state.liveMode ? 'Live pornit · refresh acum' : 'Pornește Refresh live';
}

function render() {
  pruneStoredTopics();
  state.topics = Array.from(state.topicStore.values());
  const topics = getFilteredTopics();
  updateMetrics(topics);

  el.resultsSummary.textContent = `${topics.length} subiect(e) afișate din ${state.topics.length} păstrate în intervalul ${formatScanInterval(getSelectedMaxAgeMinutes())}. Sunt afișate automat și subiectele cu o singură sursă.`;
  el.emptyState.hidden = topics.length > 0;
  el.topicsGrid.innerHTML = topics.map(renderTopicCard).join('');
}

function getFilteredTopics(sourceList = state.topics) {
  const search = normalize(el.searchInput.value);
  let list = sourceList.map(withCurrentAge).filter((topic) => isTopicWithinSelectedInterval(topic, getSelectedMaxAgeMinutes()));

  // Nu mai ascundem subiectele marcate anterior ca blocate; apar automat în listă.
  if (state.currentCategory !== 'toate') list = list.filter((topic) => topic.category === state.currentCategory);
  if (el.interestFilter.value !== 'toate') list = list.filter((topic) => topic.interest === el.interestFilter.value);
  if (el.intensityFilter.value !== 'toate') list = list.filter((topic) => topic.intensity === el.intensityFilter.value);
  if (search) {
    list = list.filter((topic) => normalize(`${topic.title} ${topic.keywords?.join(' ')} ${topic.entities?.join(' ')}`).includes(search));
  }

  // Intervalul de scanare este deja aplicat pe backend și la păstrarea locală.

  const coverage = el.coverageFilter.value;
  if (coverage === 'neacoperit') list = list.filter((topic) => topic.coverage?.status === 'neacoperit');
  if (coverage === 'posibil-similar') list = list.filter((topic) => topic.coverage?.status === 'posibil-similar');

  const sort = el.sortFilter.value;
  list.sort((a, b) => {
    if (sort === 'recency') return a.startedMinutesAgo - b.startedMinutesAgo;
    if (sort === 'trend') return b.trendScore - a.trendScore;
    if (sort === 'risk') return (RISK_ORDER[b.risk] || 0) - (RISK_ORDER[a.risk] || 0);
    return b.priorityScore - a.priorityScore;
  });

  return list;
}

function updateMetrics(visible) {
  const eligible = state.topics.filter((topic) => topic.eligibility?.isEligible).length;
  const blocked = state.topics.filter((topic) => !topic.eligibility?.isEligible).length;
  const topScore = visible.length ? Math.max(...visible.map((topic) => topic.priorityScore || 0)) : 0;
  el.eligibleMetric.textContent = eligible;
  el.checkedMetric.textContent = state.topics.length;
  el.blockedMetric.textContent = blocked;
  el.topScoreMetric.textContent = topScore || '—';
}

function renderTopicCard(topic) {
  const coverage = topic.coverage || { status: 'neacoperit', label: 'Neacoperit', similarity: 0 };
  const isBlocked = !topic.eligibility?.isEligible;
  const scoreStyle = `--score:${Math.max(0, Math.min(100, topic.priorityScore || 0))}%`;
  const coverageBadgeClass = coverage.status === 'neacoperit' ? 'green' : coverage.status === 'posibil-similar' ? 'yellow' : 'red';
  const blockedHtml = '';
  const sourcesHtml = (topic.sources || []).slice(0, 5).map((source) => {
    const href = source.url && source.url !== '#' ? source.url : '#';
    const age = typeof source.sourceAgeMinutes === 'number' ? ` · ${formatMinutes(source.sourceAgeMinutes)}` : '';
    return `<a class="source-link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.name || 'Sursă')}${escapeHtml(formatAuthor(source))}${escapeHtml(age)}</a>`;
  }).join('');

  return `
    <article class="topic-card ${escapeAttr(coverage.status)}">
      <div class="card-top">
        <div>
          <div class="badges">
            <span class="badge">${escapeHtml(topic.category || 'Actualitate')}</span>
            <span class="badge blue">${escapeHtml(topic.interest || 'Social')}</span>
            <span class="badge hot">${escapeHtml(topic.trendStatus || 'activ')}</span>
            <span class="badge ${coverageBadgeClass}">${escapeHtml(coverage.label || 'Neacoperit')} · ${coverage.similarity || 0}%</span>
          </div>
          <h3 class="topic-title">${escapeHtml(topic.title)}</h3>
          <p class="topic-summary">${escapeHtml(topic.summary || '')}</p>
        </div>
        <div class="score-ring" style="${scoreStyle}" aria-label="Scor prioritate ${topic.priorityScore}">
          <span>${topic.priorityScore || 0}</span>
        </div>
      </div>

      ${blockedHtml}

      <div class="data-grid">
        <div class="data-cell"><span>Scor interes</span><strong>${topic.trendScore ?? '—'}/100</strong></div>
        <div class="data-cell"><span>Vechime subiect</span><strong>${formatMinutes(topic.startedMinutesAgo)}</strong></div>
        <div class="data-cell"><span>Surse detectate de radar</span><strong>${topic.sourceCount || (topic.sources || []).length}</strong></div>
        <div class="data-cell"><span>Articole în interval</span><strong>${getOnlineCount(topic)}</strong></div>
        <div class="data-cell"><span>Acoperit de Oficiul de Știri</span><strong>${coverage.status === 'deja-acoperit' ? 'DA' : coverage.status === 'posibil-similar' ? 'POSIBIL' : 'NU'}</strong></div>
        <div class="data-cell"><span>Recomandare</span><strong>${escapeHtml(topic.recommendation || 'monitorizează')}</strong></div>
      </div>


      <div class="sources-list">${sourcesHtml || '<span class="badge">Surse indisponibile</span>'}</div>

      <div class="card-actions">
        <button class="btn btn-primary" type="button" data-action="brief" data-id="${escapeAttr(topic.id)}">Brief</button>
        <button class="btn" type="button" data-action="titles" data-id="${escapeAttr(topic.id)}">SEO complet</button>
        <button class="btn" type="button" data-action="contacts" data-id="${escapeAttr(topic.id)}">Contacte + drafturi</button>
        <button class="btn" type="button" data-action="draft" data-id="${escapeAttr(topic.id)}">Draft</button>
      </div>

      ${renderOnlineArticleLinks(topic)}
    </article>
  `;
}


function getApiFeatureLabel(action) {
  const labels = {
    brief: 'Brief editorial',
    titles: 'SEO complet',
    contacts: 'Contacte + drafturi mail',
    draft: 'Draft articol'
  };
  return labels[action] || 'Funcție editorială';
}

function showApiConceptNotice(action, topic) {
  const label = getApiFeatureLabel(action);
  const title = topic?.title || 'subiectul selectat';
  el.dialogTitle.textContent = label;
  el.dialogBody.innerHTML = `
    <div class="concept-box">
      <h3>Funcție concept — necesită API AI</h3>
      <p><strong>${escapeHtml(label)}</strong> nu este activ în varianta curentă, pentru că ar trebui conectat un API AI real care să citească sursele, să înțeleagă contextul și să genereze text editorial corect.</p>
      <p>Subiect selectat: <strong>${escapeHtml(title)}</strong></p>
      <p>În versiunea finală, modulul ar lucra cu un API AI real și ar folosi regulile redacției Oficiul de Știri: text umanizat, expresii-cheie reale, anti-duplicate, surse verificate și structură gata de lucru editorial.</p>
      ${getApiFeatureDetails(action)}
      <p class="muted">Pentru activare este nevoie de integrare API AI + cost lunar de rulare. Radarul rămâne funcțional pentru scanarea știrilor și identificarea subiectelor apărute recent.</p>
    </div>
  `;
  openDialog();
}

function getApiFeatureDetails(action) {
  if (action === 'brief') {
    return `<ul>
      <li>ar genera un brief editorial clar despre ce este vorba în subiectul selectat;</li>
      <li>ar scoate ideile principale, persoanele/instituțiile implicate și informațiile care trebuie verificate;</li>
      <li>ar propune unghiul editorial util pentru cititor, fără formulări generice și fără preluare mecanică din presă.</li>
    </ul>`;
  }
  if (action === 'titles') {
    return `<ul>
      <li>ar furniza un pachet SEO complet pentru subiectul selectat;</li>
      <li>ar include expresii naturale de indexat, focus keyword, slug, meta description, excerpt și 4 taguri fără diacritice;</li>
      <li>ar genera variante de titluri și variante de H2-uri relevante, umane și optimizate pentru Google, nu șabloane.</li>
    </ul>`;
  }
  if (action === 'contacts') {
    return `<ul>
      <li>ar furniza contacte relevante pentru subiectul respectiv: instituții, persoane, birouri de presă sau sursa inițială;</li>
      <li>ar afișa date de contact doar acolo unde sunt disponibile public și nu ar inventa numere sau e-mailuri;</li>
      <li>ar genera întrebări și drafturi diferite pentru fiecare instituție contactată, în funcție de responsabilitatea ei reală.</li>
    </ul>`;
  }
  if (action === 'draft') {
    return `<ul>
      <li>ar scrie un draft editabil, nu text final publicabil, pe care redactorul poate interveni cu tonul personal, stilul propriu și verificările finale;</li>
          <li>ar include indicații clare despre cum poate fi editat textul ca să se indexeze mai bine în Google, prin expresii naturale căutate de oameni și integrate în primele 300–400 de cuvinte;</li>
      <li>ar integra expresii-cheie în primele 300–400 de cuvinte;</li>
      <li>ar păstra stilul Oficiul de Știri și ar evita formulările de tip Copilot.</li>
    </ul>`;
  }
  return '';
}


async function copyTopicForAI(topic, button) {
  const prompt = buildPromptForAI(topic);
  try {
    await navigator.clipboard.writeText(prompt);
    if (button) {
      const old = button.textContent;
      button.textContent = 'Copiat pentru AI';
      setTimeout(() => { button.textContent = old; }, 1800);
    }
  } catch (error) {
    el.dialogTitle.textContent = 'Prompt pentru AI';
    el.dialogBody.innerHTML = `
      <p class="muted">Nu am putut copia automat. Selectează textul de mai jos și copiază-l manual.</p>
      <textarea class="copy-area" readonly>${escapeHtml(prompt)}</textarea>
    `;
    openDialog();
  }
}

function buildPromptForAI(topic) {
  const sources = (topic.sources || [])
    .filter((source) => source && (source.url || source.link || source.name))
    .slice(0, 6)
    .map((source, index) => `${index + 1}. ${source.name || source.domain || 'Sursă'}${source.author ? ` · autor: ${source.author}` : ''}${source.publishedAt ? ` · publicat: ${source.publishedAt}` : ''}\n   Link: ${source.url || source.link || ''}\n   Titlu/descriere: ${source.title || source.description || ''}`)
    .join('\n');

  const online = (topic.onlineMatches || [])
    .filter((item) => item && (item.url || item.link))
    .slice(0, 6)
    .map((item, index) => `${index + 1}. ${item.title || item.name || 'Articol'}\n   Link: ${item.url || item.link}`)
    .join('\n');

  const category = topic.category || 'Actualitate';
  const interest = topic.interest || 'Actualitate';
  const coverage = topic.coverage || {};
  const age = typeof topic.startedMinutesAgo === 'number' ? `${topic.startedMinutesAgo} minute` : 'n/a';

  return `Lucrează ca editor Oficiul de Știri, în stilul lui Horia Stoian. Folosește AI doar ca sprijin și direcție, nu copia formulări mecanice. Textul trebuie să fie uman, clar, citit ușor și indexabil pe expresii-cheie uzuale, nu să sune ca un răspuns de Copilot.

SUBIECT DIN RADAR:
Titlu detectat: ${topic.title || ''}
Categorie radar: ${category}
Interes radar: ${interest}
Vechime: ${age}
Scor prioritate: ${topic.priorityScore || 'n/a'}
Status Oficiul: ${coverage.status || 'n/a'} / similaritate ${coverage.similarity || 0}%
Surse detectate: ${topic.sourceCount || (topic.sources || []).length || 0}

SURSE DETECTATE:
${sources || 'Nu există surse în card. Cere-mi să verific manual înainte de articol.'}

ARTICOLE / MATCH-URI ÎN INTERVAL:
${online || 'Nu există match-uri suplimentare.'}

CERINȚE OBLIGATORII:
1. Fă întâi anti-duplicate pe oficiuldestiri.ro pentru subiect, nume și cuvinte-cheie. Dacă există deja același unghi, spune clar și propune alt unghi, nu scrie dublură.
2. Verifică informațiile actuale din surse credibile/oficiale. Nu inventa date, reacții, persoane, linkuri, imagini sau citate. Dacă ceva nu se poate verifica, spune clar.
3. Scrie material gata de copy-paste pentru Oficiul de Știri, maximum o pagină, ideal 550–700 de cuvinte.
4. Primele 300–400 de cuvinte trebuie să fie foarte bine indexate, cu expresii naturale pe care oamenii le caută pe Google. Bolduiește expresiile SEO în text.
5. Nu folosi formulări robotice de tip „de ce contează”, „ce urmează” dacă sună șablon. Intertitlurile trebuie să fie finale, concrete, umane și indexabile.
6. Nu folosi cuvântul „miza”. Folosește natural: partea importantă, punctul sensibil, problema de fond, întrebarea reală, ce contează de fapt.
7. Include exact 2 linkuri externe relevante, ancorate pe grupuri de cuvinte cu sens, nu pe „aici” sau „sursa”.
8. Include exact 2 linkuri interne Oficiul, natural, în formulări de tipul „Oficiul de Știri a scris despre...”, ancorate pe grupuri relevante.
9. Include o secțiune „Pe scurt” de 1–2 fraze, nu tabel.
10. Include pachet SEO complet: focus keyword fără diacritice, SEO title fără diacritice, slug, meta description max 155–160 caractere, excerpt, categorie, categorii secundare, max 4 taguri, H2/H3 finale, expresii SEO folosite.
11. Include 2 poze legale numai din Wikimedia Commons, cu link pagină, link direct download dacă există, credit, licență, filename recomandat, alt text, title, caption și descriere. Caption format: „[descriere imagine]. / Sursa foto: [sursa]”.
12. Scrie șapou principal și șapou rescris pentru poza de după șapou.
13. La final, dă checklist scurt: anti-duplicate, surse, linkuri, SEO, poze.

FORMAT CERUT:
A) Anti-duplicate check
B) Articol gata de copy-paste
C) Verificare expresii SEO naturale
D) Pachet SEO complet
E) Poze legale Wikimedia
F) Checklist final

Important: nu produce text generic. Găsește unghiul real al subiectului pentru cititorii din România: ce s-a întâmplat, cine e afectat, ce se schimbă concret, ce trebuie urmărit și ce înseamnă pentru cititor.`;
}


function showBrief(topic) {
  const coverage = topic.coverage || {};
  const focusKeyword = buildFocusKeyword(topic);
  el.dialogTitle.textContent = 'Brief + reguli șef';
  el.dialogBody.innerHTML = `
    <h3>${escapeHtml(topic.seoTitle || topic.title)}</h3>
    <div class="editorial-box">
      <p><strong>Unghi:</strong> ${escapeHtml(buildOficiulAngle(topic))}</p>
    </div>

    <h3>Rezumat rapid</h3>
    <ul>
      <li><strong>Ce s-a întâmplat:</strong> ${escapeHtml(topic.title)}</li>
      <li><strong>De ce contează:</strong> ${escapeHtml(buildImpactReasonClient(topic))}</li>
      <li><strong>Cine este afectat:</strong> ${escapeHtml(inferAffectedPeople(topic))}</li>
      <li><strong>Ce urmează:</strong> ${escapeHtml(inferNextStep(topic))}</li>
    </ul>

    <h3>Structură articol, maximum 700 de cuvinte</h3>
    <ol>
      <li><strong>Titlu cu partea importantă clară:</strong> ${escapeHtml(topic.seoTitle || buildSeoHeadline(topic))}</li>
      <li><strong>Lead 2–4 rânduri:</strong> ${escapeHtml(buildLead(topic))}</li>
      <li><strong>Context:</strong> ${escapeHtml(buildOficiulAngle(topic))}</li>
      <li><strong>Pe scurt:</strong> 3–4 bulleturi cu date verificate.</li>
      <li><strong>Ce înseamnă pentru cititor:</strong> ${escapeHtml(buildImpactReasonClient(topic))}</li>
      <li><strong>Ce urmează:</strong> ${escapeHtml(inferNextStep(topic))}</li>
    </ol>

    <h3>Pe scurt</h3>
    <ul>
      <li>Subiect în intervalul selectat: ${escapeHtml(formatMinutes(topic.startedMinutesAgo))}.</li>
      <li>Surse detectate de radar: ${formatSourceCount(topic.sourceCount || (topic.sources || []).length)}.</li>
      <li>Recomandare: ${escapeHtml(topic.recommendation || 'monitorizează')}.</li>
      <li>Risc editorial: ${escapeHtml(topic.risk || 'mediu')}.</li>
    </ul>

    <h3>SEO și categorii</h3>
    <p><strong>Focus keyword:</strong> ${escapeHtml(focusKeyword)}</p>
    <p><strong>Meta description:</strong> ${escapeHtml(topic.meta || buildMetaClient(topic, focusKeyword))}</p>
    <p><strong>Categorie principală:</strong> ${escapeHtml(topic.wpCategory || topic.category || 'Actualitate')}</p>
    <p><strong>Taguri recomandate:</strong> ${escapeHtml(buildTags(topic).join(', '))}</p>

    <h3>Linkuri și surse</h3>
    <p><strong>Surse externe de verificat:</strong></p>
    <ul>${(topic.sources || []).slice(0, 5).map((s) => `<li><a href="${escapeAttr(s.url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.name || s.url || 'Sursă')}${escapeHtml(formatAuthor(s))}</a></li>`).join('') || '<li>Nu există surse externe disponibile în card.</li>'}</ul>
    <h3>Întrebări pentru telefon</h3>
    <ol>${buildPhoneQuestions(topic).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>

    <h3>Avertismente editoriale</h3>
    <ul>${(topic.warnings || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>

    <h3>Ce NU trebuie afirmat fără confirmare</h3>
    <ul>${(topic.doNotSay || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
  `;
  openDialog();
}

function showTitles(topic) {
  const focusKeyword = buildFocusKeyword(topic);
  const base = topic.title.replace(/[.!?]+$/, '');
  const titles = buildSeoTitleIdeas(topic);

  el.dialogTitle.textContent = 'SEO complet';
  el.dialogBody.innerHTML = `
    <h3>Titluri propuse</h3>
    <ol>${titles.map((title) => `<li>${escapeHtml(title)}</li>`).join('')}</ol>

    <h3>Pachet SEO</h3>
    <p><strong>Focus keyword:</strong> ${escapeHtml(focusKeyword)}</p>
    <p><strong>SEO title fără diacritice:</strong> ${escapeHtml(removeDiacritics(titles[0]))}</p>
    <p><strong>Slug:</strong> ${escapeHtml(slugify(titles[0]))}</p>
    <p><strong>Meta description:</strong> ${escapeHtml(buildMetaClient(topic, focusKeyword))}</p>
    <p><strong>Excerpt:</strong> ${escapeHtml(buildLead(topic))}</p>
    <p><strong>Categorie principală:</strong> ${escapeHtml(topic.wpCategory || topic.category || 'Actualitate')}</p>
    <p><strong>Categorii secundare:</strong> ${escapeHtml(buildSecondaryCategories(topic).join(', '))}</p>
    <p><strong>Taguri max 4:</strong> ${escapeHtml(buildTags(topic).join(', '))}</p>

    <h3>H2/H3 recomandate</h3>
    <p class="muted">Intertitluri finale, concrete și indexabile, generate pe subiect, nu șabloane generice.</p>
    <ul>${buildSeoH2Recommendations(topic).map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>
  `;
  openDialog();
}

async function showContactsAndDrafts(topic) {
  el.dialogTitle.textContent = 'Contacte relevante + drafturi mail';
  el.dialogBody.innerHTML = '<p>Se caută contacte locale, instituționale și publice din sursele subiectului...</p>';
  openDialog();

  try {
    const response = await fetch('/api/contact-drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const contactsHtml = (data.candidates || []).map((c, index) => renderContactCandidate(c, (data.drafts || [])[index])).join('');
    el.dialogBody.innerHTML = `
      <p class="muted">${escapeHtml(data.notice || '')}</p>
      ${contactsHtml || '<p>Nu am găsit contacte clare. Verifică manual sursa oficială și pagina instituției relevante.</p>'}
    `;
  } catch (error) {
    el.dialogBody.innerHTML = `<p>Nu am putut genera contactele: ${escapeHtml(error.message)}</p>`;
  }
}


function showGptArticlePrompt(topic) {
  const prompt = buildGptArticlePrompt(topic);
  el.dialogTitle.textContent = 'Prompt articol';
  el.dialogBody.innerHTML = `
    <p class="muted"></p>
    <textarea class="draft-textarea large" readonly>${escapeHtml(prompt)}</textarea>
    <div class="dialog-actions">
      <button class="btn btn-primary" type="button" onclick="navigator.clipboard.writeText(this.closest('.dialog-body').querySelector('textarea').value)">Copiază promptul</button>
    </div>
  `;
  openDialog();
}

function showCopyPasteDraft(topic) {
  el.dialogTitle.textContent = 'Draft local';
  try {
    const draft = buildLocalCopyPasteDraft(topic);
    el.dialogBody.innerHTML = `
      <p class="muted">Draft local gata de copy-paste, construit din informațiile găsite în sursele cardului.</p>
      <textarea class="draft-textarea large" readonly>${escapeHtml(draft)}</textarea>
      <div class="dialog-actions">
        <button class="btn btn-primary" type="button" onclick="navigator.clipboard.writeText(this.closest('.dialog-body').querySelector('textarea').value)">Copiază draftul</button>
      </div>
    `;
  } catch (error) {
    console.error('Draft local error', error, topic);
    el.dialogBody.innerHTML = `<p><strong>Draftul nu s-a putut genera.</strong> ${escapeHtml(error.message || String(error))}</p>`;
  }
  openDialog();
}

function showLinksAndImages(topic) {
  const externals = chooseExternalLinks(topic);
  el.dialogTitle.textContent = 'Linkuri + surse';
  el.dialogBody.innerHTML = `
    <h3>Linkuri externe detectate</h3>
    <ol>${externals.map((l) => `<li><a href="${escapeAttr(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.anchor)}</a> — ${escapeHtml(l.url)}</li>`).join('') || '<li>Nu sunt suficiente surse externe în card. Verifică manual sursa oficială sau comunicatul instituției.</li>'}</ol>

    <h3>Surse de verificat înainte de publicare</h3>
    <ul>
      <li>sursa inițială a informației: comunicat, document oficial, agenție de presă sau declarație directă;</li>
      <li>ora publicării și eventualele actualizări apărute după prima știre;</li>
      <li>instituția care poate confirma oficial datele;</li>
      <li>dacă subiectul există deja pe Oficiul de Știri, dar pe alt unghi.</li>
    </ul>
  `;
  openDialog();
}


function buildImpactReasonClient(topic) {
  const text = normalize(`${topic.title || ''} ${topic.summary || ''} ${topic.interest || ''} ${(topic.keywords || []).join(' ')} ${(topic.entities || []).join(' ')}`);
  const title = cleanupForArticle(topic.title || 'subiectul');
  if (/alimente|adaos|plafon|pret|preturi|cosul|magazin|retailer|facturi|tva|taxe|impozit|anaf|pensii|salarii/.test(text)) {
    return 'Contează pentru România pentru că atinge direct prețurile, bugetul familiilor și regulile după care vând magazinele. Cititorii au nevoie să știe ce produse sunt vizate, până când se aplică măsura și dacă efectul se vede la raft.';
  }
  if (/notar|parchet|procuror|judecat|instanta|dosar|ancheta|prejudiciu|evaziune|frauda/.test(text)) {
    return 'Contează pentru că vorbește despre bani publici, răspundere legală și încrederea în instituții sau profesii cu rol public. Pentru cititori este important să fie separate acuzațiile de fapte dovedite și să fie explicat stadiul dosarului.';
  }
  if (/injunghiat|crima|omor|amenintat|violenta|agres|victima|suspect|arest|retinut/.test(text)) {
    return 'Contează pentru că pune în discuție siguranța oamenilor, reacția autorităților și felul în care sunt protejate victimele. Partea importantă este ce s-a întâmplat concret, ce măsuri au fost luate și ce informații sunt confirmate de autorități.';
  }
  if (/meteo|anm|cod galben|cod portocaliu|vreme|furtuna|ploi|canicula|inundatii|vijelie|isu|trafic/.test(text)) {
    return 'Contează imediat pentru cititori pentru că poate afecta drumuri, locuințe, școli, evenimente și programul zilnic. Informația utilă este zona vizată, intervalul avertizării și ce trebuie făcut concret.';
  }
  if (/cfr cluj|fcsb|rapid|dinamo|craiova|fotbal|meci|transfer|cantonament|superliga|sport/.test(text)) {
    return 'Contează pentru publicul de sport pentru că arată programul echipei, pregătirea sezonului și posibilele decizii care pot influența lotul sau rezultatele. Cititorii caută date concrete: reunire, cantonament, adversari și transferuri.';
  }
  if (/kovesi|eppo|pnrr|ue|bruxelles|italia|rusia|ucraina|nato|moldova|sua|iran|bulgaria|marea neagra/.test(text)) {
    return 'Contează pentru România pentru că are legătură cu instituții europene, bani publici, securitate regională sau decizii care pot afecta poziția țării în UE și NATO. Partea importantă este legătura românească: securitate, bani europeni, diaspora sau poziția României în UE și NATO.';
  }
  if (/guvern|parlament|premier|ministru|lege|ordonanta|vot|coalitie|psd|pnl|usr|aur|udmr|alegeri|grindeanu|tomac|nicusor|simion|ciolacu/.test(text)) {
    return 'Contează politic pentru că poate schimba decizii publice, negocieri de putere sau reguli care ajung să afecteze cetățenii. Pentru cititori contează dacă este doar declarație, conflict politic sau pas instituțional concret.';
  }
  if (/bac|evaluare|educatie|scoala|elev|profesor|examen|admitere|student/.test(text)) {
    return 'Contează pentru elevi, părinți și profesori, pentru că poate schimba calendarul, procedura sau informațiile de care depinde pregătirea. Pentru elevi și părinți contează clar cine este vizat și ce termen trebuie urmărit.';
  }
  if (/sanatate|spital|medic|pacient|boala|tratament|medicament|cnas|dsp/.test(text)) {
    return 'Contează pentru pacienți și familii pentru că poate influența accesul la servicii medicale, tratamente sau reguli de sănătate publică. Pentru pacienți contează informația sigură, explicată fără alarmism.';
  }
  return `Contează dacă informația din „${title}” schimbă ceva concret pentru cititori: bani, siguranță, servicii publice, drepturi sau decizii politice. Partea utilă este efectul practic pentru România, nu doar faptul că subiectul a apărut în fluxuri.`;
}

function buildCleanSearchQuery(topic) {
  const title = cleanupForArticle(topic.title || '');
  const words = title
    .replace(/[|:;,.!?„”"'()\[\]]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => w.length > 2)
    .filter((w) => !/^(breaking|ultima|ora|video|foto|live|update|exclusiv|revista|presei|cum|care|este|sunt|fost|după|dupa|până|pana|pentru|despre|dintre|dintre|dintr|prin|mai|mult|multe|unui|unei|ale|sau|iar|dar|când|cand|unde|lista|arată|arata)$/i.test(w));
  const picked = [];
  for (const w of words) {
    if (!picked.some((x) => sameNormalized(x, w))) picked.push(w);
    if (picked.length >= 7) break;
  }
  const q = picked.join(' ').trim();
  return q || buildFocusKeyword(topic) || title.slice(0, 80);
}

function buildInternalContextQuery(topic) {
  const category = topic.category || '';
  const interest = topic.interest || '';
  const clean = buildCleanSearchQuery(topic);
  return `${clean} ${category} ${interest}`.trim();
}

function buildGptArticlePrompt(topic) {
  const focusKeyword = buildFocusKeyword(topic);
  const externals = chooseExternalLinks(topic);
  const internals = chooseInternalLinks(topic);
  const externalText = externals.map((l, i) => `${i + 1}. ${l.anchor}: ${l.url}`).join('\n') || 'Nu sunt suficiente surse externe clare în card. Caută și verifică 2 surse externe relevante înainte de articol.';
  const internalText = internals.map((l, i) => `${i + 1}. ${l.anchor}: ${l.url}`).join('\n') || 'Nu sunt suficiente linkuri interne clare. Caută 2 articole relevante pe oficiuldestiri.ro, fără să dublezi unghiul.';
  const sourcesText = (topic.sources || []).slice(0, 8).map((s, i) => `${i + 1}. ${s.name || 'Sursă'}${formatAuthor(s)}${typeof s.sourceAgeMinutes === 'number' ? ` — ${formatMinutes(s.sourceAgeMinutes)}` : ''}: ${s.url || ''}`).join('\n');
  const similarText = ((topic.coverage || {}).matches || []).slice(0, 5).map((m, i) => `${i + 1}. ${m.similarity || 0}% — ${m.title || m.slug || m.url}: ${m.url || ''}`).join('\n') || 'Nu au fost găsite articole similare relevante în scanarea publică.';
  const phoneQuestions = buildPhoneQuestions(topic).map((q, i) => `${i + 1}. ${q}`).join('\n');
  return `Acționează ca editor pentru Oficiul de Știri, în stilul jurnalistic al lui Horia Stoian. Eu sunt Horia Stoian. Vreau un material gata de copy-paste/rescris pentru oficiuldestiri.ro.

REGULĂ ZERO — ANTI-DUPLICAT:
Înainte să scrii articolul, verifică online dacă subiectul există deja pe oficiuldestiri.ro cu:
site:oficiuldestiri.ro "${topic.title}"
site:oficiuldestiri.ro "${focusKeyword}"
site:oficiuldestiri.ro + entități + cuvinte-cheie relevante.
Dacă subiectul există pe același unghi, NU scrie articolul. Spune ce există și propune alt unghi.

SUBIECT DETECTAT DE RADAR:
Titlu brut: ${topic.title}
Categorie propusă: ${topic.wpCategory || topic.category || 'Actualitate'}
Interes: ${topic.interest || 'Social'}
Scor prioritate: ${topic.priorityScore || '—'}/100
Scor interes: ${topic.trendScore || '—'}/100
Vechime: ${formatMinutes(topic.startedMinutesAgo)}
Recomandare radar: ${topic.recommendation || 'monitorizează'}
Risc editorial: ${topic.risk || 'mediu'}
Entități detectate: ${(topic.entities || []).join(', ') || '—'}
Keywords detectate: ${(topic.keywords || []).join(', ') || focusKeyword}
Focus keyword propus: ${focusKeyword}
Acoperire Oficiul de Știri: ${(topic.coverage || {}).label || 'Neacoperit'} — similaritate ${(topic.coverage || {}).similarity || 0}%

SURSE RECENTE DETECTATE:
${sourcesText || 'Nu există surse listate în card. Caută surse recente și oficiale înainte de articol.'}

REZULTATE POSIBIL SIMILARE PE OFICIUL:
${similarText}

LINKURI OBLIGATORII:
Folosește exact 2 linkuri externe și exact 2 linkuri interne, toate relevante și ancorate pe grupuri de cuvinte cu sens, niciodată pe „aici” / „sursa”.

2 linkuri externe sugerate:
${externalText}

2 linkuri interne Oficiul de Știri sugerate:
${internalText}

STIL OFICIUL / HORIA STOIAN:
Nu scrie doar „s-a întâmplat X”. Scrie ce înseamnă pentru cititor. Materialul trebuie să răspundă la: ce s-a întâmplat, de ce contează, ce urmează, cine este afectat, ce înseamnă pentru cititor. Paragrafe scurte, H2-uri dese, ton clar, explicativ, jurnalistic. Fără clickbait. Nu face preluare seacă. Găsește partea importantă din spatele subiectului.

STRUCTURĂ OBLIGATORIE:
- maximum 700 de cuvinte, ideal 550–700;
- titlu cu partea importantă clară;
- lead/șapou de 2–4 rânduri cu cine, ce, când, esența știrii, de ce contează, cine e afectat;
- context;
- secțiune explicativă: de ce contează / ce înseamnă / cine câștigă și cine pierde;
- element scanabil: „Pe scurt”, tabel, listă sau timeline;
- secțiune „Ce urmează”;
- final cu idee clară, nu final sec.

SEO OBLIGATORIU:
- Focus keyword fără litere care ar necesita diacritice, dacă se poate;
- SEO title fără diacritice și cu focus keyword;
- slug fără diacritice;
- meta description maximum 155–160 caractere;
- excerpt;
- categorie principală doar din lista Oficiul de Știri;
- 1–2 categorii secundare;
- taguri minim 2, maxim 4; tag principal = tema, nu persoana;
- H2/H3 recomandate;
- image SEO.

CATEGORII DISPONIBILE:
ACTUALITATE, Extern, Lumea de lângă noi, Alegeri 2025, Breaking News, Business, Călătorii, Comunicat de presa, Cross, Gica Contra, Libertatea, Life, Casa și grădina, Cultură, De gustibus, Entertainment & Showbiz, Health & Fitness, Horoscop, Style, Motion, News, OPINII, Pamfletul zilei, Pastila de râs, Politică, Puterea, Realitatea, Special, Analiză, Anchete, Interviuri, Reportaje, Sport, Summit G7, Tehnologie, Utilitare.

IMAGINI:
Propune două imagini legale: main + după șapou. Pentru fiecare dă pagina exactă, link direct de descărcare dacă există, credit, licență/drepturi, nume fișier, alt text, title, caption, descriere. Preferă Wikimedia, instituții oficiale, Guvern, ministere, Parlament, NATO, UE, cluburi sportive sau comunicate oficiale. Dacă licența nu e clară, spune clar.

REACȚII / TELEFON:
Dacă materialul cere reacții, spune pe cine să sun sau cui să scriu, cu 5–10 întrebări scurte. Nu inventa numere sau reacții.
Întrebări posibile:
${phoneQuestions}

OUTPUT OBLIGATORIU, în această ordine:
A. Verificare anti-duplicat
B. Articol gata de copy-paste
C. Pachet SEO complet
D. Poze legale
E. Checklist final

Checklist final:
- Titlu clar?
- Lead cu esența?
- Exact 2 linkuri interne?
- Exact 2 linkuri externe?
- Poze relevante?
- Taguri max 4?
- Nu există duplicat?
- Text sub 700 cuvinte?
- Secțiune „Ce urmează”?
- Element scanabil?`;
}

function buildLocalCopyPasteDraft(topic) {
  const sources = getCleanSources(topic).slice(0, 3);
  const title = buildPublishableDraftTitle(topic);
  const lead = buildPublishableLead(topic, sources);
  const mainH2 = buildArticleMainH2(topic);
  const mainSection = buildPublishableMainSection(topic, sources);
  const impactH2 = buildArticleImpactH2(topic);
  const impactSection = buildPublishableImpactSection(topic, sources);
  const shortBox = buildPublishableShortBox(topic, sources);
  const nextH2 = buildPublishableNextH2(topic);
  const nextSection = buildPublishableNextSection(topic, sources);

  return `# ${title}

${lead}

## ${mainH2}

${mainSection}

## ${impactH2}

${impactSection}

## Pe scurt

${shortBox}

## ${nextH2}

${nextSection}`;
}

function detectTopicKind(topic) {
  const text = normalize(`${topic.title || ''} ${topic.interest || ''} ${(topic.keywords || []).join(' ')} ${(topic.entities || []).join(' ')} ${(topic.sources || []).map((s) => `${s.title || ''} ${s.description || ''}`).join(' ')}`);
  if (/anofm|locuri de munca|joburi|angajari|somaj|ocuparea fortei de munca/.test(text)) return 'jobs';
  if (/agricover|fermieri|fermier|agricol|agricultura|culturi|cultura|seceta|subventii|apia|credite agricole|indatorati/.test(text)) return 'agri';
  if (/jupiter|documente false|cetateni ucraineni|refugiati|gazduieste|prejudiciu|frauda|inselaciune|bani publici/.test(text)) return 'fraud_public_money';
  if (/robor|banca|bnr|consiliul concurentei|concurenta|credit|rate|dobanda|dobanzi|manipulare/.test(text)) return 'banking';
  if (/notar|impozit|contributii|prejudiciu|parchet|judecat|trimis in judecata|evaziune|dosar/.test(text)) return 'legal_tax';
  if (/tomac|guvern|premier|ministr|coalitie|parlament|pnl|psd|usr|aur|presedint|nicusor|grindeanu|motiune/.test(text)) return 'politics';
  if (/alimente|adaos|plafon|pret|preturi|retail|magazine|raft/.test(text)) return 'food_prices';
  if (/ucraina|rusia|nato|patriot|marea neagra|moldova|sua|iran|bulgaria|ue|bruxelles/.test(text)) return 'external';
  if (/cfr cluj|fcsb|rapid|dinamo|craiova|fotbal|cantonament|transfer|meci|superliga|club/.test(text)) return 'sport';
  if (/meteo|anm|cod galben|cod portocaliu|furtuni|ploi|canicula|vreme|vijelie/.test(text)) return 'weather';
  if (/injunghiat|crima|omor|violenta|accident|incendiu|politie|victima|suspect|retinut/.test(text)) return 'incident';
  if (/bac|evaluare|educatie|scoala|elev|profesor|examen|admitere|subiecte|barem/.test(text)) return 'education';
  if (/sanatate|spital|medic|pacient|boala|tratament|medicament|cnas|dsp/.test(text)) return 'health';
  return 'general';
}

function cleanPublisherName(source) {
  const urlName = domainFromUrlClient(source?.url || '').replace(/^www\./, '');
  const raw = cleanupForArticle(source?.name || '').trim();
  const tooLong = raw.length > 35 || raw.split(/\s+/).length > 4;
  const looksLikeTitle = raw && source?.title && normalize(raw) === normalize(source.title);
  if (!raw || tooLong || looksLikeTitle || /http|operatiunea|barbat|femeie|live video|breaking/i.test(raw)) return urlName || 'sursa citată';
  return raw;
}

function buildPublishableDraftTitle(topic) {
  const raw = cleanupForArticle(topic.title || topic.seoTitle || 'Subiect nou');
  const kind = detectTopicKind(topic);
  const short = raw.replace(/^live video\s*/i, '').replace(/\s*\|\s*/g, '. ');
  if (kind === 'jobs') return 'Aproape 34.000 de locuri de muncă sunt disponibile în România. Ce trebuie să verifice cei care caută un job';
  if (kind === 'agri') return 'Fermierii români și presiunea datoriilor. Ce arată datele Agricover despre creditele din agricultură';
  if (kind === 'fraud_public_money') return 'Bani pentru găzduirea refugiaților ucraineni, obținuți cu documente false. Ce anchetează procurorii';
  if (kind === 'banking') return 'Băncile, ROBOR și ancheta de concurență. Ce trebuie să știe românii cu rate';
  if (kind === 'legal_tax') return `${short}. Ce sumă indică anchetatorii și ce urmează în dosar`;
  if (kind === 'politics') return `${short}. De ce contează în negocierile pentru putere`;
  if (kind === 'food_prices') return `${short}. Ce produse și ce termen sunt importante pentru cumpărători`;
  if (kind === 'external') return `${short}. Legătura cu România și cu deciziile din regiune`;
  if (kind === 'sport') return `${short}. Programul echipei și primele decizii pentru noul sezon`;
  if (kind === 'weather') return `${short}. Zonele vizate și intervalul în care vremea se schimbă`;
  if (kind === 'incident') return `${short}. Primele date despre victimă, suspect și anchetă`;
  return short;
}

function buildPublishableLead(topic, sources) {
  const detail = firstUsefulDetail(topic, sources) || cleanupForArticle(topic.title || '');
  const sourceName = cleanPublisherName(sources[0] || {});
  const kind = detectTopicKind(topic);
  const sentence = detail.charAt(0).toLocaleUpperCase('ro-RO') + detail.slice(1);
  if (kind === 'jobs') return `${sentence}, potrivit ${sourceName}. Anunțul este util pentru cei care caută un loc de muncă acum, dar și pentru angajatorii care încearcă să acopere posturi într-o piață în care oferta diferă mult de la un județ la altul.`;
  if (kind === 'agri') return `${sentence}, potrivit ${sourceName}. Datele arată cât de apăsat este sectorul agricol de credite și costuri, într-un moment în care fermierii depind de finanțare pentru fiecare ciclu de producție.`;
  if (kind === 'fraud_public_money') return `${sentence}, potrivit ${sourceName}. Cazul pune în discuție felul în care sunt verificate plățile din bani publici și ajutoarele acordate în contextul refugiaților ucraineni.`;
  if (kind === 'banking') return `${sentence}, potrivit ${sourceName}. Pentru românii cu credite, subiectul contează prin legătura cu dobânzile, ratele și încrederea în regulile pieței bancare.`;
  if (kind === 'legal_tax') return `${sentence}, potrivit ${sourceName}. Cazul este important pentru că vorbește despre bani care ar fi trebuit să ajungă la buget și despre răspunderea celor care gestionează acte, tranzacții sau obligații fiscale.`;
  if (kind === 'politics') return `${sentence}, potrivit ${sourceName}. Declarația contează pentru că poate schimba negocierile dintre partide, numele puse pe masă și ritmul în care se poate forma o majoritate.`;
  if (kind === 'food_prices') return `${sentence}, potrivit ${sourceName}. Pentru cumpărători, partea importantă este dacă măsura se vede la raft, ce produse intră pe listă și cât timp rămâne valabilă plafonarea.`;
  if (kind === 'external') return `${sentence}, potrivit ${sourceName}. Subiectul are legătură cu România prin securitate regională, decizii europene sau poziționarea statelor din vecinătatea Mării Negre.`;
  if (kind === 'sport') return `${sentence}, potrivit ${sourceName}. Pentru suporteri, informația contează prin programul echipei, lotul care intră în pregătire și următoarele meciuri.`;
  if (kind === 'weather') return `${sentence}, potrivit ${sourceName}. Informația este relevantă pentru cei care circulă, pentru autorități locale și pentru oamenii din zonele unde vremea poate produce probleme.`;
  if (kind === 'incident') return `${sentence}, potrivit ${sourceName}. Cazul contează prin reacția autorităților, starea persoanelor implicate și eventualele măsuri de protecție sau anchetă.`;
  return `${sentence}, potrivit ${sourceName}. Pentru cititori, partea importantă este efectul concret al informației și felul în care subiectul poate schimba o decizie, un cost, o procedură sau un calendar public.`;
}

function buildPublishableMainSection(topic, sources) {
  const main = sources[0] || {};
  const second = sources[1] || null;
  const detail = firstUsefulDetail(topic, sources) || cleanupForArticle(topic.title || '');
  const name = cleanPublisherName(main);
  const link = main.url ? `[${name}](${main.url})` : name || 'sursa citată';
  let text = `Conform ${link}, ${lowercaseFirstForArticle(detail)}.`;
  if (second) {
    const secondName = cleanPublisherName(second);
    const secondDetail = cleanupForArticle(second.description || second.title || '');
    const secondLink = second.url ? `[${secondName}](${second.url})` : secondName;
    if (secondDetail && !sameNormalized(secondDetail, detail)) text += ` ${secondLink} notează și că ${lowercaseFirstForArticle(shortenForArticle(secondDetail, 230))}.`;
    else text += ` Informația este relatată și de ${secondLink}.`;
  }
  return text;
}

function buildPublishableImpactSection(topic, sources) {
  const kind = detectTopicKind(topic);
  if (kind === 'jobs') return 'Pentru cei care caută un job, numărul total de posturi este doar începutul. Contează județul, meseria cerută, salariul, experiența solicitată și cât de repede se actualizează oferta. Pentru angajatori, datele ANOFM arată și unde piața muncii are deficit de oameni.';
  if (kind === 'agri') return 'Pentru România, datoriile fermierilor nu sunt doar o problemă a companiilor agricole. Ele pot influența investițiile în culturi, costul producției, accesul la utilaje și, în lanț, prețurile alimentelor. Când creditul devine mai scump sau mai greu de dus, presiunea se vede în ferme și în piață.';
  if (kind === 'fraud_public_money') return 'Pentru cititori, cazul este despre controlul banilor publici. Ajutorul pentru refugiați a fost o măsură sensibilă, iar suspiciunile de documente false ridică întrebări despre verificări, recuperarea prejudiciului și protejarea celor care chiar aveau nevoie de sprijin.';
  if (kind === 'banking') return 'Pentru românii cu rate, orice anchetă sau acuzație legată de ROBOR și bănci are efect direct în încrederea în piață. Întrebarea reală este dacă regulile au fost respectate și dacă oamenii au primit explicații clare despre costul creditelor.';
  if (kind === 'legal_tax') return 'Pentru contribuabili, un astfel de dosar contează prin suma anunțată și prin felul în care statul recuperează banii datorați. În același timp, trimiterea în judecată este o etapă a procesului, nu o condamnare definitivă.';
  if (kind === 'politics') return 'Pentru public, negocierile politice nu sunt doar dispute între lideri. Ele decid cine ajunge să conducă ministere, ce proiecte intră pe agenda Guvernului și cât de stabilă poate fi următoarea majoritate.';
  if (kind === 'food_prices') return 'Pentru români, efectul se vede în coșul zilnic. Plafonarea poate tempera unele scumpiri, dar ridică întrebări despre lista produselor, marjele comerciale, controale și presiunea pusă pe retaileri sau furnizori.';
  if (kind === 'external') return 'Pentru România, subiectele externe din regiune nu rămân la distanță. Ele pot influența securitatea Mării Negre, deciziile UE și NATO, bugetele de apărare, transporturile sau poziția diplomatică a Bucureștiului.';
  if (kind === 'sport') return 'Pentru suporteri, detaliile despre reunire, cantonament și lot arată cum se pregătește echipa pentru sezon. Programul de pregătire poate indica transferuri, absențe, meciuri amicale și primele opțiuni ale staffului.';
  if (kind === 'weather') return 'Pentru public, informația utilă este unde, când și cât de puternic se schimbă vremea. Un cod meteo poate afecta drumuri, gospodării, școli, evenimente în aer liber sau activitatea fermierilor.';
  if (kind === 'incident') return 'Pentru oameni, astfel de cazuri ridică întrebări despre siguranță, intervenția autorităților și protecția victimelor. Textul trebuie să se concentreze pe date confirmate și pe măsurile anunțate, nu pe detalii spectaculoase.';
  return 'Subiectul contează în măsura în care schimbă ceva concret pentru oameni: bani, timp, siguranță, servicii publice, drepturi sau decizii politice. De aici trebuie pornită explicația pentru cititor.';
}

function buildPublishableShortBox(topic, sources) {
  const kind = detectTopicKind(topic);
  const sourceNames = sources.map((s) => cleanPublisherName(s)).filter(Boolean).slice(0, 2).join(' și ') || 'sursa citată';
  if (kind === 'jobs') return `ANOFM anunță aproape 34.000 de locuri de muncă disponibile, potrivit ${sourceNames}. Cei interesați trebuie să verifice oferta pe județ, domeniu și condițiile cerute de angajator.`;
  if (kind === 'agri') return `Agricover indică o structură a datoriilor fermierilor împărțită între finanțări pe termen mediu și credite legate de ciclul de cultură. Pentru agricultură, costul finanțării rămâne una dintre problemele de fond.`;
  if (kind === 'fraud_public_money') return `Ancheta vizează bani obținuți pe baza unor documente despre găzduirea refugiaților ucraineni, potrivit ${sourceNames}. Cazul trebuie urmărit prin prejudiciu, acuzații și eventualele măsuri de recuperare.`;
  if (kind === 'legal_tax') return `Informația este atribuită ${sourceNames}. Pentru articol contează suma indicată, instituția care a făcut anunțul și stadiul exact al dosarului.`;
  if (kind === 'politics') return `Declarația poate schimba calculele dintre partide. Pentru cititori contează dacă este doar poziționare publică sau un pas real în negocieri.`;
  if (kind === 'food_prices') return `Măsura vizează alimentele de bază și perioada de aplicare. Pentru cumpărători contează lista produselor și efectul la raft.`;
  return `${shortenForArticle(firstUsefulDetail(topic, sources) || topic.title || '', 220)}. Informația este atribuită ${sourceNames}.`;
}

function buildPublishableNextH2(topic) {
  const kind = detectTopicKind(topic);
  if (kind === 'jobs') return 'Unde se verifică posturile și ce contează la angajare';
  if (kind === 'agri') return 'Costul creditelor și următorul ciclu agricol';
  if (kind === 'fraud_public_money') return 'Recuperarea prejudiciului și pașii din anchetă';
  if (kind === 'banking') return 'Ce pot afla clienții băncilor după anchetă';
  if (kind === 'legal_tax') return 'Etapa următoare în dosar și recuperarea prejudiciului';
  if (kind === 'politics') return 'Negocierile politice și următorul pas';
  if (kind === 'food_prices') return 'Când se vede efectul la raft';
  if (kind === 'external') return 'Deciziile care pot schimba situația în regiune';
  if (kind === 'sport') return 'Programul echipei până la următoarele meciuri';
  if (kind === 'weather') return 'Intervalul în care avertizarea rămâne importantă';
  if (kind === 'incident') return 'Ancheta și măsurile anunțate de autorități';
  return 'Ce se poate schimba în următoarele zile';
}

function buildPublishableNextSection(topic, sources) {
  const kind = detectTopicKind(topic);
  if (kind === 'jobs') return 'Cei care caută un loc de muncă trebuie să urmărească oferta actualizată a agențiilor județene, condițiile cerute de angajatori și termenul până la care posturile rămân active. Numărul total poate arăta tendința, dar decizia se ia la nivel de meserie și județ.';
  if (kind === 'agri') return 'Următorul reper pentru fermieri este finanțarea următorului ciclu de cultură: semințe, inputuri, utilaje, irigații și rambursarea creditelor existente. Dacă presiunea datoriilor crește, efectul se poate vedea în investiții și în capacitatea fermelor de a rămâne competitive.';
  if (kind === 'fraud_public_money') return 'Ancheta poate aduce noi date despre valoarea prejudiciului, persoanele implicate și modul în care au fost verificate documentele. Pentru public, întrebarea importantă este dacă banii pot fi recuperați și dacă regulile de control vor fi întărite.';
  if (kind === 'banking') return 'Următoarele clarificări pot veni de la instituțiile de control, bănci sau instanțe. Pentru clienți, partea practică este dacă apar explicații mai clare despre dobânzi, contracte și costurile creditelor.';
  if (kind === 'legal_tax') return 'Dosarul merge mai departe în instanță, unde vor conta probele, poziția apărării și eventualele măsuri pentru recuperarea prejudiciului. Până la o decizie definitivă, acuzațiile trebuie prezentate ca acuzații, nu ca fapte stabilite de instanță.';
  if (kind === 'politics') return 'Următoarele reacții ale partidelor pot arăta dacă declarația rămâne o tactică de negociere sau devine o schimbare reală de poziție. Pentru public, efectul se vede în stabilitatea guvernării și în calendarul deciziilor publice.';
  if (kind === 'food_prices') return 'Aplicarea măsurii va fi urmărită în magazine și în controalele instituțiilor responsabile. Pentru cumpărători contează dacă plafonarea se vede în prețul final și cât timp poate fi menținută.';
  if (kind === 'external') return 'Evoluția depinde de reacțiile oficiale și de deciziile militare sau diplomatice ale actorilor implicați. Pentru România, fiecare schimbare din regiune contează prin securitate, buget și poziționare în NATO și UE.';
  if (kind === 'sport') return 'Următorul reper este confirmarea programului complet al cantonamentului și a meciurilor amicale. Lotul prezent la reunire poate arăta ce poziții mai caută clubul și ce jucători intră în planurile staffului.';
  if (kind === 'weather') return 'Avertizările meteo se pot actualiza rapid, în funcție de evoluția frontului atmosferic. Pentru cei afectați contează ora de început, ora de final și recomandările transmise de autorități.';
  if (kind === 'incident') return 'Următoarele informații importante țin de starea victimei, măsurile luate față de suspect și comunicatul oficial al anchetatorilor. Dacă apar date despre sesizări anterioare, acestea pot schimba contextul cazului.';
  return 'Următoarele zile pot aduce reacții, documente sau decizii care schimbă efectul practic al subiectului pentru public.';
}

function getCleanSources(topic) {
  const seen = new Set();
  return (Array.isArray(topic.sources) ? topic.sources : [])
    .filter((s) => s && (s.title || s.description || s.name || s.url))
    .map((s) => {
      const url = s.url || '';
      const key = url || `${s.name || ''}-${s.title || ''}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        ...s,
        name: cleanupForArticle(s.name || domainFromUrlClient(url) || 'sursa citată'),
        title: cleanupForArticle(s.title || ''),
        description: cleanupForArticle(s.description || ''),
        url
      };
    })
    .filter(Boolean);
}

function buildArticleLead(topic, sources) {
  const title = cleanupForArticle(topic.title || topic.seoTitle || '');
  const main = sources[0] || {};
  const detail = firstUsefulDetail(topic, sources);
  const sourceText = sources.length > 1
    ? `${main.name} și alte surse monitorizate de radar`
    : (main.name || 'sursa monitorizată de radar');
  const age = formatMinutes(topic.startedMinutesAgo);
  const caution = sources.length === 1
    ? 'Informația trebuie confirmată din sursă oficială înainte de publicare.'
    : 'Subiectul trebuie verificat din documente sau comunicări oficiale înainte de publicare.';

  if (detail && !sameNormalized(detail, title)) {
    return `${detail}. Subiectul a fost detectat de radar în ultimele ${age}, prin ${sourceText}. ${caution}`;
  }
  return `${title}. Subiectul a fost detectat de radar în ultimele ${age}, prin ${sourceText}. ${caution}`;
}

function buildArticleMainH2(topic) {
  const text = normalize(`${topic.title || ''} ${(topic.keywords || []).join(' ')} ${(topic.entities || []).join(' ')}`);
  if (/plafon|alimente|pret|preturi|adaos|facturi|taxe|impozit|anaf|buget|salarii|pensii/.test(text)) return 'Ce se schimbă pentru bani, taxe sau prețuri';
  if (/notar|judecat|parchet|procuror|dosar|ancheta|instanta|condamn/.test(text)) return 'Ce se știe despre dosar și prejudiciu';
  if (/injunghiat|crima|omor|amenintat|violenta|politia/.test(text)) return 'Cum s-a produs incidentul, potrivit primelor informații';
  if (/meteo|anm|cod galben|cod portocaliu|furtuni|vreme/.test(text)) return 'Zonele și intervalul vizate de avertizare';
  if (/guvern|parlament|lege|minister|ordonanta|vot/.test(text)) return 'Decizia anunțată și ce schimbă ea';
  if (/ucraina|rusia|nato|ue|moldova|iran|sua|bulgaria/.test(text)) return 'Ce s-a schimbat și de ce contează în regiune';
  return 'Ce se știe până acum din sursele monitorizate';
}

function buildArticleMainSection(topic, sources) {
  const main = sources[0] || {};
  const second = sources[1] || null;
  const detail = firstUsefulDetail(topic, sources) || cleanupForArticle(topic.title || '');
  const link = main.url ? `[${main.name}](${main.url})` : main.name || 'sursa citată';
  let text = `Conform ${link}, ${lowercaseFirstForArticle(detail)}.`;

  if (second) {
    const secondDetail = cleanupForArticle(second.description || second.title || '');
    const secondLink = second.url ? `[${second.name}](${second.url})` : second.name;
    if (secondDetail && !sameNormalized(secondDetail, detail)) {
      text += ` ${secondLink} relatează, la rândul său, că ${lowercaseFirstForArticle(shortenForArticle(secondDetail, 260))}.`;
    } else {
      text += ` Informația apare și în ${secondLink}, ceea ce arată că subiectul circulă deja în mai multe fluxuri de știri.`;
    }
  }

  const officialHint = buildOfficialHint(topic);
  return `${text}\n\n${officialHint}`;
}

function buildArticleImpactH2(topic) {
  const text = normalize(`${topic.title || ''} ${topic.interest || ''} ${(topic.keywords || []).join(' ')}`);
  if (/alimente|pret|preturi|adaos|facturi|tva|taxe|impozit|pensii|salarii/.test(text)) return 'De ce îi afectează pe cititori';
  if (/injunghiat|crima|omor|amenintat|violenta/.test(text)) return 'De ce cazul ridică întrebări despre siguranță';
  if (/notar|impozit|prejudiciu|parchet|dosar/.test(text)) return 'De ce contează pentru contribuabili și justiție';
  if (/meteo|vreme|cod|furtuni/.test(text)) return 'Ce trebuie să știe oamenii din zonele vizate';
  if (/ucraina|rusia|nato|ue|moldova/.test(text)) return 'Legătura cu România și cu regiunea';
  return 'Ce înseamnă pentru cititor';
}

function buildArticleImpactSection(topic, sources) {
  const text = normalize(`${topic.title || ''} ${topic.interest || ''} ${(topic.keywords || []).join(' ')}`);
  if (/alimente|pret|preturi|adaos|facturi|tva|taxe|impozit|pensii|salarii/.test(text)) {
    return 'Partea importantă pentru cititori este efectul concret: prețuri, taxe, bugetul familiei sau costuri pentru firme. Articolul trebuie să explice cine câștigă timp sau bani, cine suportă costul și de când se aplică măsura.';
  }
  if (/injunghiat|crima|omor|amenintat|violenta/.test(text)) {
    return 'Pentru cititori, cazul nu este doar o știre de fapt divers. Contează dacă existau amenințări anterioare, dacă autoritățile fuseseră sesizate și ce măsuri au fost luate după incident. Formulările trebuie să rămână prudente până la confirmarea anchetatorilor.';
  }
  if (/notar|impozit|prejudiciu|parchet|dosar/.test(text)) {
    return 'Subiectul contează pentru că vorbește despre bani care ar fi trebuit să ajungă la bugetul public și despre răspunderea unei profesii cu acces direct la tranzacții importante. În articol trebuie clarificat prejudiciul, instituția care a anunțat dosarul și stadiul exact al procedurii.';
  }
  if (/meteo|vreme|cod|furtuni/.test(text)) {
    return 'Pentru public, informația utilă este intervalul, județele vizate și riscul practic: trafic, gospodării, culturi agricole, școli sau evenimente în aer liber. Textul trebuie actualizat dacă ANM schimbă harta avertizărilor.';
  }
  if (/guvern|parlament|lege|minister|ordonanta|vot/.test(text)) {
    return 'Pentru cititor, decizia trebuie explicată în termeni concreți: cine este vizat, când se aplică și ce document oficial confirmă schimbarea. O știre bună nu se oprește la vot sau declarație, ci arată efectul practic.';
  }
  if (/ucraina|rusia|nato|ue|moldova|sua|iran/.test(text)) {
    return 'Legătura cu România trebuie explicată clar: securitate regională, decizii ale UE sau NATO, energie, transporturi, diaspora ori presiune politică la granița estică. Fără această legătură, subiectul rămâne doar o preluare externă.';
  }
  return 'Subiectul merită urmărit dacă poate schimba ceva concret pentru cititori: bani, siguranță, drepturi, servicii publice sau decizii politice. Textul final trebuie să adauge context, nu doar să repete titlul din flux.';
}

function buildArticleShortBox(topic, sources) {
  const sourceCount = topic.sourceCount || sources.length || 0;
  const sourceNames = sources.map((s) => s.name).filter(Boolean).slice(0, 3).join(', ') || 'sursa monitorizată';
  const first = shortenForArticle(firstUsefulDetail(topic, sources) || topic.title || '', 210);
  const coverage = (topic.coverage || {}).label || 'Neacoperit';
  return `${first}. Subiectul apare în ${formatSourceCount(sourceCount)} monitorizate de radar (${sourceNames}), iar acoperirea Oficiul de Știri este: ${coverage}.`;
}

function buildArticleVerifyH2(topic) {
  const text = normalize(`${topic.title || ''} ${(topic.keywords || []).join(' ')}`);
  if (/notar|parchet|dosar|instanta|trimis in judecata|procuror/.test(text)) return 'Ce trebuie verificat în comunicatul oficial';
  if (/injunghiat|crima|accident|incendiu|politia|isu/.test(text)) return 'Ce trebuie confirmat la autorități';
  if (/lege|parlament|guvern|minister|ordonanta|vot/.test(text)) return 'Documentul oficial care trebuie citat';
  return 'Ce informații trebuie confirmate înainte de publicare';
}

function buildArticleVerifySection(topic, sources) {
  const text = normalize(`${topic.title || ''} ${(topic.keywords || []).join(' ')}`);
  if (/notar|parchet|dosar|instanta|trimis in judecata|procuror/.test(text)) {
    return 'Trebuie verificat comunicatul Parchetului sau al instanței, calitatea persoanei trimise în judecată, suma exactă, perioada vizată și faptul că trimiterea în judecată nu înseamnă condamnare. Dacă există nume, acesta trebuie folosit numai dacă apare într-o sursă oficială sau într-o relatare verificabilă.';
  }
  if (/injunghiat|crima|accident|incendiu|politia|isu/.test(text)) {
    return 'Trebuie confirmate datele la Poliție, Parchet, ISU sau spital, după caz: starea victimei, încadrarea juridică, dacă suspectul a fost reținut și dacă existau sesizări anterioare. Nu se atribuie vinovății înainte de date oficiale.';
  }
  if (/alimente|pret|preturi|adaos|plafon|parlament|lege|vot/.test(text)) {
    return 'Trebuie verificat actul adoptat, instituția decizională, data până la care se aplică măsura și lista produselor vizate. Dacă există vot în Parlament, trebuie confirmat dacă legea merge la promulgare sau intră direct în vigoare.';
  }
  if (/meteo|anm|cod|furtuni/.test(text)) {
    return 'Trebuie verificată harta ANM, intervalul avertizării, județele vizate și eventualele mesaje ISU. Dacă avertizarea se schimbă, titlul și leadul trebuie actualizate imediat.';
  }
  return 'Trebuie verificate sursa inițială, documentul oficial, ora publicării, instituțiile implicate și eventualele reacții. Dacă subiectul are o singură sursă, articolul trebuie formulat prudent.';
}

function buildArticleNextSection(topic, sources) {
  const text = normalize(`${topic.title || ''} ${(topic.keywords || []).join(' ')}`);
  if (/notar|parchet|dosar|instanta|trimis in judecata|procuror/.test(text)) {
    return 'Următoarele date importante sunt termenul stabilit de instanță, poziția apărării și eventualele măsuri pentru recuperarea prejudiciului. Dacă apare comunicatul integral al Parchetului, articolul trebuie completat cu citarea exactă a acuzațiilor.';
  }
  if (/injunghiat|crima|accident|incendiu|politia|isu/.test(text)) {
    return 'Următorul update trebuie să urmărească starea victimei, măsurile luate față de suspect și comunicatul oficial al anchetatorilor. Dacă apar date despre ordine de protecție sau sesizări anterioare, acestea pot schimba unghiul articolului.';
  }
  if (/alimente|pret|preturi|adaos|plafon|parlament|lege|vot/.test(text)) {
    return 'Următorul pas este publicarea formei finale și clarificarea momentului de aplicare. Pentru cititori contează dacă măsura se vede la raft, cât durează și ce produse intră efectiv pe listă.';
  }
  if (/guvern|minister|contract|airbus|licitatie|ordonanta/.test(text)) {
    return 'Trebuie urmărite documentele oficiale, valoarea contractului, calendarul de livrare și instituțiile care vor folosi echipamentele sau fondurile anunțate. Dacă apar reacții, articolul se actualizează cu pozițiile relevante.';
  }
  return 'Următorul pas este confirmarea informației în surse primare și actualizarea articolului dacă apar documente, reacții sau date noi. Dacă Oficiul a publicat deja pe același unghi, subiectul trebuie rescris din altă perspectivă.';
}

function buildOfficialHint(topic) {
  const text = normalize(`${topic.title || ''} ${(topic.keywords || []).join(' ')}`);
  if (/parlament|camera deputatilor|senat|guvern|minister|lege|ordonanta/.test(text)) return 'Pentru forma finală, caută actul oficial, stenograma, comunicatul Guvernului sau pagina instituției care a anunțat decizia.';
  if (/parchet|procuror|instanta|politia|isu/.test(text)) return 'Pentru forma finală, caută anunțul instituției competente: Parchet, Poliție, instanță, ISU sau spital, după caz.';
  if (/anm|meteo|cod galben|cod portocaliu/.test(text)) return 'Pentru forma finală, citează avertizarea ANM și verifică ora de actualizare a hărții oficiale.';
  return 'Pentru forma finală, caută sursa primară și evită concluziile care nu apar în documente sau declarații verificabile.';
}

function isGenericSourceText(text) {
  const clean = normalize(text || '');
  if (!clean) return true;
  const generic = [
    'subiect detectat ca posibil relevant',
    'verifica datele oficiale',
    'foloseste un unghi propriu',
    'merita urmarit deoarece are scor',
    'unghi recomandat',
    'informatie trebuie verificata',
    'inainte de publicare',
    'draft local',
    'ce inseamna pentru cititor',
    'aici trebuie explicat'
  ];
  return generic.some((item) => clean.includes(item));
}

function firstUsefulDetail(topic, sources) {
  const title = cleanupForArticle(topic.title || topic.seoTitle || '');
  const details = sources
    .map((s) => cleanupForArticle(s.description || s.title || ''))
    .filter((value) => value && value.length > 25 && !isGenericSourceText(value));
  const picked = details.find((value) => !sameNormalized(value, title)) || details[0] || title;
  return shortenForArticle(picked, 360);
}

function cleanupForArticle(text) {
  const decoded = decodeHtmlEntities(String(text || ''));
  return decoded
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\[\.\.\.\]|\(\.\.\.\)|\.\.\./g, '')
    .replace(/©\s*[^.]+$/i, '')
    .replace(/&copy;\s*[^.]+$/i, '')
    .replace(/\s*\|\s*[^|]{2,40}$/g, '')
    .trim()
    .replace(/[.!?]+$/g, '');
}

function decodeHtmlEntities(text) {
  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = text;
    return textarea.value;
  }
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&copy;/g, '©');
}

function shortenForArticle(text, max = 260) {
  const clean = cleanupForArticle(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const lastStop = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf(';'), cut.lastIndexOf(','));
  if (lastStop > 120) return cut.slice(0, lastStop).trim();
  return clean.slice(0, max).trim().replace(/\s+\S*$/, '');
}

function lowercaseFirstForArticle(text) {
  const clean = cleanupForArticle(text);
  if (!clean) return '';
  return clean.charAt(0).toLocaleLowerCase('ro-RO') + clean.slice(1);
}

function sameNormalized(a, b) {
  return normalize(a || '') === normalize(b || '');
}


function chooseExternalLinks(topic) {
  return (topic.sources || [])
    .filter((s) => s.url && /^https?:\/\//.test(s.url))
    .slice(0, 2)
    .map((s) => ({ url: s.url, anchor: buildExternalAnchor(topic, s) }));
}

function buildExternalAnchor(topic, source) {
  const name = source.name || domainFromUrlClient(source.url || '');
  const focus = buildFocusKeyword(topic);
  if (/gov|edu|bnr|anaf|anm|presidency|mae|mai|politia/i.test(source.url || name)) return `datele oficiale despre ${focus}`;
  return `informațiile publicate de ${name}`;
}

function chooseInternalLinks(topic) {
  const matches = ((topic.coverage || {}).matches || []).filter((m) => m.url && /^https?:\/\//.test(m.url));
  return matches.slice(0, 2).map((m) => ({
    url: m.url,
    anchor: m.title ? m.title.slice(0, 90) : `contextul publicat anterior de Oficiul de Știri`
  }));
}

function domainFromUrlClient(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return 'sursa externă'; }
}


function renderContactCandidate(contact, draft) {
  const contactLine = [
    contact.email ? `Email: ${contact.email}` : '',
    contact.phone ? `Telefon: ${contact.phone}` : '',
    contact.url ? `URL: ${contact.url}` : ''
  ].filter(Boolean).join(' · ') || 'Contact de completat manual';
  const mailto = contact.email && draft
    ? `<a class="btn" href="mailto:${encodeURIComponent(contact.email)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}">Deschide email</a>`
    : '';
  return `
    <section class="contact-card">
      <h3>${escapeHtml(contact.name || 'Contact relevant')}</h3>
      <p><strong>Rol:</strong> ${escapeHtml(contact.role || '—')}</p>
      <p><strong>Contact:</strong> ${escapeHtml(contactLine)}</p>
      <p><strong>De ce e relevant:</strong> ${escapeHtml(contact.reason || contact.competence || 'Poate ajuta la confirmare.')}</p>
      ${contact.url ? `<p><a href="${escapeAttr(contact.url)}" target="_blank" rel="noopener noreferrer">Pagina publică</a></p>` : ''}
      ${draft ? `
        <h4>Draft mail personalizat</h4>
        <p><strong>Subiect:</strong> ${escapeHtml(draft.subject)}</p>
        <textarea class="draft-textarea" readonly>${escapeHtml(draft.body)}</textarea>
        <div class="dialog-actions">${mailto}<button class="btn" type="button" onclick="navigator.clipboard.writeText(this.closest('.contact-card').querySelector('textarea').value)">Copiază draft</button></div>
      ` : ''}
    </section>
  `;
}

function renderMatches(matches) {
  if (!matches.length) return '<p>Nu au fost găsite articole similare relevante.</p>';
  return `
    <ul>
      ${matches.slice(0, 5).map((match) => `
        <li>
          <strong>${match.similarity || 0}%</strong> ·
          <a href="${escapeAttr(match.url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(match.title || match.slug || match.url || 'Rezultat')}</a>
          <small>(${escapeHtml(match.source || 'sursă')})</small>
        </li>
      `).join('')}
    </ul>
  `;
}

function openDialog() {
  if (typeof el.briefDialog.showModal === 'function') el.briefDialog.showModal();
  else alert(el.dialogBody.textContent);
}

function buildLead(topic) {
  return `Subiectul „${topic.title}” este monitorizat ca posibilă știre de interes pentru români, cu scor de prioritate ${topic.priorityScore}/100. Înainte de publicare, informația trebuie verificată din sursele indicate și completată cu un unghi editorial propriu.`;
}

async function runManualCheck() {
  const query = el.manualCheckInput.value.trim();
  if (query.length < 3) {
    el.manualResult.textContent = 'Scrie minimum 3 caractere.';
    return;
  }

  el.manualResult.textContent = 'Se verifică public pe Oficiul de Știri...';
  el.manualCheckBtn.disabled = true;
  try {
    const response = await fetch(`/api/oficiu-check?q=${encodeURIComponent(query)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    const cls = result.status === 'neacoperit' ? 'green' : result.status === 'posibil-similar' ? 'yellow' : 'red';
    el.manualResult.innerHTML = `
      <span class="badge ${cls}">${escapeHtml(result.label)} · ${result.similarity}%</span>
      ${result.bestMatch ? `<p>Cel mai apropiat rezultat: <a href="${escapeAttr(result.bestMatch.url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(result.bestMatch.title || result.bestMatch.slug || 'rezultat')}</a></p>` : '<p>Nu am găsit rezultate similare relevante.</p>'}
      <small>Căutări folosite: ${escapeHtml((result.queries || []).join(' · '))}</small>
    `;
  } catch (error) {
    el.manualResult.textContent = `Nu am putut verifica: ${error.message}`;
  } finally {
    el.manualCheckBtn.disabled = false;
  }
}



function buildShortSummary(topic) {
  const title = cleanupForArticle(topic.title || 'Subiect nou');
  const affected = inferAffectedPeople(topic);
  const next = inferNextStep(topic);
  return `${title}. Cine este vizat: ${affected}. Următorul pas: ${next}`;
}

function buildOficiulAngle(topic) {
  const text = normalize(`${topic.title || ''} ${topic.interest || ''} ${(topic.keywords || []).join(' ')} ${(topic.entities || []).join(' ')}`);
  const title = cleanupForArticle(topic.title || 'subiectul');
  if (/robor|banca|bnr|concurenta|credit|rate/.test(text)) return 'Unghi propriu: explică ce poate însemna ancheta pentru clienții cu credite, pentru dobânzi și pentru încrederea în bănci, nu doar declarația oficială.';
  if (/tomac|guvern|premier|ministr|coalitie|parlament|pnl|psd|usr|aur|presedint|nicusor|grindeanu/.test(text)) return 'Unghi propriu: arată ce schimbă declarația în negocierile politice și cine câștigă sau pierde spațiu de manevră.';
  if (/notar|impozit|prejudiciu|parchet|judecat|dosar/.test(text)) return 'Unghi propriu: pune în centru prejudiciul, obligațiile fiscale și etapa procesului, cu diferența clară dintre acuzație și verdict.';
  if (/alimente|adaos|plafon|pret|preturi|facturi|tva|taxe|pensii|salarii/.test(text)) return 'Unghi propriu: explică efectul în bani pentru oameni, magazine și firme: ce se schimbă, de când și cine verifică aplicarea.';
  if (/ucraina|rusia|nato|patriot|marea neagra|moldova|ue|sua/.test(text)) return 'Unghi propriu: leagă știrea de România prin securitate, bugete, decizii UE/NATO sau riscurile din regiunea Mării Negre.';
  if (/cfr cluj|fcsb|rapid|dinamo|craiova|fotbal|cantonament|transfer|meci/.test(text)) return 'Unghi propriu: scoate partea utilă pentru suporteri: program, lot, cantonament, transferuri și ce poate schimba pregătirea sezonului.';
  if (/meteo|anm|cod|furtuni|ploi|canicula|vreme/.test(text)) return 'Unghi propriu: fă material util pe zone, interval, riscuri și ce trebuie să facă oamenii afectați.';
  if (/injunghiat|crima|omor|violenta|accident|incendiu|politie|isu/.test(text)) return 'Unghi propriu: separă faptele confirmate de zvonuri și explică reacția autorităților, starea victimei și riscul pentru comunitate.';
  if (/bac|evaluare|scoala|elev|profesor|admitere|educatie/.test(text)) return 'Unghi propriu: explică exact ce au de făcut elevii și părinții, ce termen contează și unde apar informațiile oficiale.';
  if (/sanatate|spital|medic|pacient|medicament|cnas/.test(text)) return 'Unghi propriu: arată efectul pentru pacienți: acces, costuri, programări, documente și riscul de confuzie.';
  return `Unghi propriu: pornește de la ${title} și explică efectul concret pentru cititor, nu doar faptul că informația a apărut în presă.`;
}

function inferAffectedPeople(topic) {
  const text = normalize(`${topic.title} ${topic.interest} ${(topic.keywords || []).join(' ')} ${(topic.entities || []).join(' ')}`);
  if (/ucraina|rusia|nato|patriot|razboi|marea neagra|bulgaria|moldova|sua|iran/.test(text)) return 'cititorii interesați de securitatea regională, deciziile UE/NATO și efectele asupra României';
  if (/cfr cluj|fcsb|rapid|dinamo|craiova|fotbal|cantonament|meci|transfer/.test(text)) return 'suporterii, clubul și cititorii care urmăresc programul echipei';
  if (/pensii|pensie/.test(text)) return 'pensionarii și familiile lor';
  if (/tva|taxe|anaf|impozit/.test(text)) return 'contribuabilii, firmele și oamenii care plătesc taxe';
  if (/facturi|energie|gaze|curent/.test(text)) return 'consumatorii casnici și firmele cu facturi mari';
  if (/elev|scoala|bac|evaluare|admitere/.test(text)) return 'elevii, părinții și profesorii';
  if (/sanatate|spital|medicament|pacient/.test(text)) return 'pacienții și sistemul medical';
  if (/guvern|premier|politic|parlament|motiune/.test(text)) return 'cetățenii afectați de deciziile politice și instituționale';
  if (/vreme|meteo|cod|trafic|accident/.test(text)) return 'oamenii din zonele afectate și cei care circulă';
  return 'publicul interesat de impactul practic al subiectului';
}

function inferNextStep(topic) {
  const text = normalize(`${topic.title} ${topic.interest} ${(topic.entities || []).join(' ')}`);
  if (/guvern|parlament|motiune|lege|vot/.test(text)) return 'următorul vot, comunicat oficial sau decizie instituțională';
  if (/anaf|bnr|tva|taxe|facturi|preturi/.test(text)) return 'documentul oficial, termenul de aplicare și impactul în bani';
  if (/meteo|anm|cod/.test(text)) return 'actualizarea avertizării și intervalul în care riscul rămâne activ';
  if (/accident|politie|isu|ancheta/.test(text)) return 'bilanțul oficial și concluziile autorităților';
  return 'confirmarea din surse oficiale și eventuale reacții proprii';
}

function buildSeoHeadline(topic) {
  const base = shortenTitleForSeo((topic.title || '').replace(/[.!?]+$/, ''));
  const text = normalize(`${topic.title || ''} ${topic.interest || ''} ${(topic.keywords || []).join(' ')}`);
  if (/plafon|alimente|adaos|pret|preturi|facturi|tva|taxe|impozit|anaf|pensii|salarii/.test(text)) return `${base}. Ce se schimbă pentru români`;
  if (/guvern|parlament|pnl|psd|usr|aur|premier|ministru|alegeri|nicusor|simion|grindeanu|tomac/.test(text)) return `${base}. Efectul politic și ce urmează`;
  if (/ucraina|rusia|nato|ue|moldova|sua|iran|bulgaria/.test(text)) return `${base}. De ce contează pentru România`;
  if (/meteo|anm|cod galben|cod portocaliu|furtuni|vreme/.test(text)) return `${base}. Zonele vizate și intervalul anunțat`;
  if (/injunghiat|crima|omor|accident|incendiu|politia|isu/.test(text)) return `${base}. Ce au transmis autoritățile`;
  return `${base}. Ce se știe și ce trebuie verificat`;
}

function buildSeoTitleIdeas(topic) {
  const kind = detectTopicKind(topic);
  const title = cleanupForArticle(topic.title || topic.seoTitle || '');
  const entities = (topic.entities || []).filter(Boolean);
  const mainEntity = entities[0] || sentenceCase(buildFocusKeyword(topic));
  let titles = [];

  if (kind === 'jobs') titles = [
    'Aproape 34.000 de locuri de muncă în România. Ce trebuie să verifice cei care caută un job',
    'Locuri de muncă ANOFM în toată țara. Unde se caută angajați și ce contează pentru candidați',
    'Românii care vor să se angajeze au mii de posturi disponibile. Cum se verifică oferta ANOFM',
    'Piața muncii în România: aproape 34.000 de posturi libere și diferențe mari între județe',
    'Joburi disponibile prin ANOFM. Ce trebuie să știe candidații înainte să aplice',
    'Unde sunt locurile de muncă anunțate de ANOFM și ce domenii pot avea nevoie de oameni'
  ];
  else if (kind === 'agri') titles = [
    'Fermierii români și presiunea datoriilor. Ce arată datele Agricover despre creditele agricole',
    'Cât de îndatorați sunt fermierii români și de ce contează pentru prețurile alimentelor',
    'Creditele fermierilor, între ciclul de cultură și investițiile pe termen mediu',
    'Agricultura românească depinde tot mai mult de finanțare. Ce spune Agricover despre datorii',
    'Datoriile din agricultură și riscul pentru următorul ciclu de cultură',
    'De ce creditele fermierilor pot ajunge să conteze și pentru consumatori'
  ];
  else if (kind === 'fraud_public_money') titles = [
    'Bani pentru refugiați ucraineni, obținuți cu documente false. Ce anchetează procurorii',
    'Caz Jupiter în Maramureș: sute de mii de lei pentru găzduirea refugiaților, sub lupa anchetatorilor',
    'Documente false pentru bani publici. Cum este descris dosarul privind refugiații ucraineni',
    'Anchetă penală după plăți pentru refugiați ucraineni. Ce prejudiciu este verificat',
    'Sprijinul pentru refugiați și controalele statului. Ce arată cazul din Maramureș',
    'Dosar cu bani publici și refugiați ucraineni. Ce trebuie urmărit în anchetă'
  ];
  else if (kind === 'banking') titles = [
    'ROBOR, bănci și concurență. Ce trebuie să știe românii cu rate',
    'Ancheta privind băncile și ROBOR: unde este problema pentru clienți',
    'Ratele românilor și regulile de concurență. Ce se discută în cazul băncilor',
    'Ce pot afla clienții după acuzațiile legate de manipularea ROBOR',
    'Consiliul Concurenței și băncile. De ce contează dosarul pentru credite',
    'Costul creditelor și încrederea în piața bancară: ce întrebări ridică ancheta'
  ];
  else if (kind === 'politics') titles = [
    `${mainEntity} și negocierile politice. Ce se poate schimba după noul anunț`,
    `Schimbare de poziție în negocieri. Cine poate câștiga timp și cine pierde teren`,
    `Numele de miniștri, între presiune politică și compromis. Ce urmează pentru partide`,
    `De ce declarația lui ${mainEntity} poate schimba calculele pentru viitorul Guvern`,
    `Negocierile pentru putere intră într-o nouă etapă. Ce semnal transmite ${mainEntity}`,
    `Partidele caută nume acceptate de toți. Ce ascunde disputa din jurul miniștrilor`
  ];
  else if (kind === 'legal_tax') titles = [
    'Notar trimis în judecată pentru impozite neplătite. Prejudiciul anunțat de anchetatori',
    'Dosar de aproape 1,5 milioane de euro. Ce acuzații apar în cazul notarului din București',
    'Impozite nevirate la stat și tranzacții imobiliare. De ce contează dosarul notarului',
    'Bani care trebuiau să ajungă la buget. Ce urmează după trimiterea în judecată',
    'Cazul notarului din Capitală: prejudiciu, acuzații și prezumția de nevinovăție',
    'Dosar fiscal cu miză publică: ce spun procurorii despre impozitele neplătite'
  ];
  else if (kind === 'food_prices') titles = [
    'Adaos comercial plafonat la alimente. Ce produse și ce termen contează pentru cumpărători',
    'Alimentele de bază rămân cu prețuri plafonate. Ce se schimbă la raft',
    'Plafonarea adaosului comercial, prelungită. Cine verifică magazinele și ce urmăresc cumpărătorii',
    'Coșul zilnic și plafonarea prețurilor. Ce trebuie să știe românii până la finalul anului',
    'Lista alimentelor cu adaos plafonat. Ce produse rămân în măsură',
    'Prețurile la alimente și decizia Parlamentului. Ce efect poate avea pentru familii'
  ];
  else if (kind === 'external') titles = [
    `${mainEntity} și deciziile din regiune. De ce contează pentru România`,
    `Schimbare externă cu efect regional. Ce legătură are România cu subiectul`,
    `UE, NATO și vecinătatea României: ce trebuie urmărit după noul anunț`,
    `Decizia care poate influența flancul estic. Unde intră România în ecuație`,
    `Securitatea regională și efectul pentru România. Ce apare în sursele externe`,
    `De ce subiectul extern nu este doar o știre de peste graniță`
  ];
  else if (kind === 'sport') titles = [
    `${mainEntity}: programul de pregătire și primele semne pentru noul sezon`,
    `Reunirea echipei și cantonamentul: ce urmează pentru lot`,
    `Cum se pregătește ${mainEntity} pentru sezon. Datele care contează pentru suporteri`,
    `Cantonament, lot și meciuri amicale. Ce trebuie urmărit la ${mainEntity}`,
    `Primele decizii după reunire. Ce arată programul echipei`,
    `Suporterii află primele repere ale pregătirii: unde merge echipa și cine intră în lot`
  ];
  else titles = [
    `${title}. Ce se știe acum și cine este afectat`,
    `${mainEntity}: detaliul care schimbă lectura subiectului`,
    `Ce înseamnă subiectul pentru public și ce date contează`,
    `Informația nouă din surse și efectul pentru cititori`,
    `Contextul care lipsește din primele relatări despre ${mainEntity}`,
    `Ce poate urma după anunțul care îl vizează pe ${mainEntity}`
  ];

  return Array.from(new Set(titles.map((t) => shortenTitleForSeo(t).replace(/\s+/g, ' ').trim()).filter(Boolean))).slice(0, 6);
}

function buildSeoH2Recommendations(topic) {
  const kind = detectTopicKind(topic);
  const base = shortenTitleForSeo((topic.title || topic.seoTitle || '').replace(/[.!?]+$/, ''));
  const sets = {
    jobs: [
      'Locuri de muncă disponibile prin ANOFM: ce arată oferta națională',
      'Unde trebuie să caute cei care vor să se angajeze acum',
      'Ce domenii pot avea nevoie de oameni și ce verifică un candidat',
      'De ce numărul posturilor libere diferă de la un județ la altul',
      'Ce pași trebuie făcuți înainte de aplicare'
    ],
    agri: [
      'Datoriile fermierilor români și presiunea pe următorul ciclu agricol',
      'Credite pe termen mediu și finanțarea culturilor: ce spune Agricover',
      'De ce costul finanțării poate influența producția agricolă',
      'Cum se poate vedea presiunea din ferme în prețurile alimentelor',
      'Ce urmăresc fermierii înainte de următoarea campanie agricolă'
    ],
    fraud_public_money: [
      'Documente false pentru bani publici: ce anchetează procurorii',
      'Cum funcționa sprijinul pentru găzduirea refugiaților ucraineni',
      'Prejudiciul anunțat și recuperarea banilor',
      'De ce cazul ridică întrebări despre verificarea plăților',
      'Ce urmează în dosarul din Maramureș'
    ],
    banking: [
      'ROBOR și ancheta privind băncile: ce este important pentru clienți',
      'Ce reguli de concurență sunt în discuție',
      'Cum pot fi afectați românii cu rate',
      'Consiliul Concurenței, BNR și limitele fiecărei instituții',
      'Ce reacții trebuie urmărite din partea băncilor'
    ],
    politics: [
      `${base}: declarația care schimbă negocierile politice`,
      'Numele de miniștri și presiunea pentru un compromis',
      'Ce partide sunt vizate și ce poate urma la negocieri',
      'Cum se poate schimba calendarul unei majorități',
      'Ce reacții politice pot confirma noua linie'
    ],
    legal_tax: [
      `${base}: acuzațiile și prejudiciul anunțat`,
      'Ce impozite ar fi trebuit virate la buget',
      'Stadiul dosarului și prezumția de nevinovăție',
      'De ce cazul contează pentru contribuabili',
      'Ce se poate întâmpla în instanță'
    ],
    food_prices: [
      'Alimentele cu adaos comercial plafonat: ce se schimbă pentru cumpărători',
      'Lista produselor vizate și termenul până la care se aplică măsura',
      'Cum se vede plafonarea la raft și în bugetul familiei',
      'Cine controlează magazinele și ce riscă retailerii',
      'Ce efect poate avea decizia asupra prețurilor'
    ],
    external: [
      `${base}: decizia care contează în regiune`,
      'Legătura cu România, UE și NATO',
      'Ce se schimbă pentru securitatea din zona Mării Negre',
      'Reacțiile care trebuie urmărite în capitalele implicate',
      'De ce subiectul extern are efect pentru România'
    ],
    sport: [
      `${base}: programul de pregătire`,
      'Cantonamentul și meciurile amicale care trebuie confirmate',
      'Ce jucători intră în planurile staffului',
      'De ce reunirea contează pentru suporteri',
      'Ce poate urma pe piața transferurilor'
    ],
    weather: [
      'Cod meteo în România: zonele vizate de avertizare',
      'Intervalul în care sunt așteptate fenomenele severe',
      'Ce trebuie să știe șoferii și locuitorii din județele afectate',
      'Recomandările autorităților în timpul avertizării',
      'Când poate fi actualizată harta ANM'
    ],
    incident: [
      `${base}: primele informații despre victimă și suspect`,
      'Ce spun autoritățile despre incident',
      'Ancheta și măsurile luate după atac',
      'De ce cazul ridică întrebări despre protecția victimelor',
      'Ce date trebuie tratate cu prudență'
    ]
  };
  const h2 = sets[kind] || [
    `${base}: informația nouă din surse`,
    'Cine este afectat și de ce contează subiectul',
    'Contextul care lipsește din primele relatări',
    'Ce se poate schimba în următoarele zile',
    'Datele care trebuie urmărite pentru actualizare'
  ];
  return Array.from(new Set(h2.map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean))).slice(0, 6);
}

function shortenTitleForSeo(text) {
  const clean = cleanupForArticle(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= 95) return clean;
  const cut = clean.slice(0, 95).replace(/[,;:\-–—]?\s+\S*$/, '');
  return cut || clean.slice(0, 95);
}

function sentenceCase(text) {
  const clean = (text || '').trim();
  if (!clean) return '';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function buildFocusKeyword(topic) {
  const source = (topic.keywords && topic.keywords.length ? topic.keywords : significantWordsClient(topic.title)).slice(0, 3).join(' ');
  return removeDiacritics(source || topic.title || 'subiect actualitate').toLowerCase();
}

function significantWordsClient(text) {
  const stop = new Set(['si','sau','cu','de','la','in','pe','pentru','din','un','o','ce','cum','este','sunt','despre','mai','video','foto','live']);
  return normalize(text).split(/\s+/).filter((w) => w.length > 2 && !stop.has(w)).slice(0, 8);
}

function buildMetaClient(topic, focusKeyword) {
  return removeDiacritics(`Află ce se știe despre ${focusKeyword}, de ce contează pentru români și ce urmează în perioada următoare.`).slice(0, 158);
}

function buildSecondaryCategories(topic) {
  const interest = topic.interest || '';
  if (interest === 'Economie/Bani') return ['Actualitate', 'Utilitare'];
  if (interest === 'Politică') return ['Actualitate', 'News'];
  if (interest === 'Sănătate') return ['Life', 'Health & Fitness'];
  if (interest === 'Educație') return ['Actualitate', 'Utilitare'];
  if (interest === 'Externe relevante pentru români') return ['Extern', 'Lumea de lângă noi'];
  return ['News'];
}

function buildTags(topic) {
  const tags = [];
  const main = buildFocusKeyword(topic).split(' ').slice(0, 3).join(' ');
  if (main) tags.push(main);
  (topic.entities || []).slice(0, 2).forEach((entity) => {
    const clean = entity.trim();
    if (clean && clean.split(/\s+/).length <= 3) tags.push(clean);
  });
  const context = topic.interest || topic.category || 'Actualitate';
  tags.push(context);
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).slice(0, 4);
}

function buildPhoneQuestions(topic) {
  const text = normalize(`${topic.title} ${topic.interest} ${(topic.keywords || []).join(' ')}`);
  if (/anaf|taxe|tva|bnr|facturi|energie|salarii|pensii/.test(text)) {
    return [
      'Care este informația oficială confirmată acum?',
      'Cine este afectat concret și de când?',
      'Există un document oficial sau un calendar de aplicare?',
      'Care este impactul în bani pentru cititori?',
      'Ce trebuie să verifice oamenii ca să nu fie induși în eroare?'
    ];
  }
  if (/politic|guvern|parlament|motiune|premier|presedinte|nicusor|simion|ciolacu/.test(text)) {
    return [
      'Este vorba despre o decizie oficială sau doar despre o declarație politică?',
      'Care este următorul pas concret?',
      'Cine câștigă și cine pierde politic?',
      'Ce efect poate avea pentru guvernare sau instituții?',
      'Ce informație lipsește acum din spațiul public?'
    ];
  }
  return [
    'Ce informații sunt confirmate oficial?',
    'De ce contează pentru publicul din România?',
    'Cine este afectat direct?',
    'Ce urmează în următoarele ore?',
    'Unde poate fi verificată informația primară?'
  ];
}

function removeDiacritics(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[ăâîșşțţ]/gi, (m) => ({ă:'a',â:'a',î:'i',ș:'s',ş:'s',ț:'t',ţ:'t',Ă:'A',Â:'A',Î:'I',Ș:'S',Ş:'S',Ț:'T',Ţ:'T'}[m] || m));
}

function slugify(text) {
  return removeDiacritics(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96);
}


function exportCsv() {
  const topics = getFilteredTopics();
  const headers = [
    'titlu', 'categorie', 'interes', 'scor_prioritate', 'scor_interes', 'indice_trends', 'volum_estimat',
    'vechime_minute', 'status_oficiu', 'similaritate_oficiu', 'risc', 'recomandare', 'surse', 'seo_title', 'meta'
  ];
  const rows = topics.map((topic) => [
    topic.title,
    topic.category,
    topic.interest,
    topic.priorityScore,
    topic.trendScore,
    topic.trendsIndexLabel,
    topic.estimatedVolume,
    topic.startedMinutesAgo,
    topic.coverage?.label,
    topic.coverage?.similarity,
    topic.risk,
    topic.recommendation,
    (topic.sources || []).map((source) => source.name).join(' | '),
    topic.seoTitle,
    topic.meta
  ]);

  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `radar-editorial-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? '').replace(/"/g, '""');
  return `"${text}"`;
}

function resetFilters() {
  el.searchInput.value = '';
  el.interestFilter.value = 'toate';
  el.intensityFilter.value = 'toate';
  el.ageFilter.value = '120';
  el.coverageFilter.value = 'neacoperit';
  el.sortFilter.value = 'recency';
  state.currentCategory = 'toate';
  document.querySelectorAll('.nav-pill').forEach((button) => button.classList.toggle('active', button.dataset.category === 'toate'));
  render();
}


function getSelectedMaxAgeMinutes() {
  const value = Number(el.ageFilter?.value || 120);
  return Number.isFinite(value) ? Math.max(60, Math.min(1440, value)) : 120;
}

function formatScanInterval(minutes) {
  if (minutes < 60) return `0–${minutes} minute`;
  if (minutes === 60) return '0–60 minute';
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return `0–${hours} ${hours === 1 ? 'oră' : 'ore'}`;
  return `0–${minutes} minute`;
}

function updateLiveStatus() {
  if (!el.liveStatusLabel) return;
  el.liveStatusLabel.textContent = state.liveMode
    ? `Live ON · auto-refresh la 3 min · ${formatScanInterval(getSelectedMaxAgeMinutes())}`
    : `Live oprit · alege intervalul și apasă Refresh live`;
}

function updateFreshnessUI() {
  if (!state.lastUpdate) return;
  const minutes = Math.max(0, Math.round((Date.now() - state.lastUpdate.getTime()) / 60000));
  el.lastUpdateLabel.textContent = `${state.lastUpdate.toLocaleString('ro-RO')} (${minutes === 0 ? 'acum' : `acum ${minutes} min`})`;
  const stale = minutes > 15;
  el.freshnessDot.classList.toggle('stale', stale);
  el.freshnessAlert.hidden = !stale;
  updateLiveStatus();
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  el.themeBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function formatMinutes(value) {
  const minutes = Number(value || 0);
  if (minutes < 1) return 'acum';
  if (minutes === 1) return '1 minut';
  return `${minutes} minute`;
}

function lowerFirst(value) {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}

function buildFallbackData() {
  const topics = [
    {
      id: 'fallback-meteo',
      title: 'Demo: cod galben de vreme severă în mai multe județe',
      category: 'Actualitate',
      interest: 'Social',
      intensity: 'ridicat',
      trendStatus: 'în creștere',
      trendScore: 82,
      trendsIndexLabel: 'n/a',
      estimatedVolume: '—',
      startedMinutesAgo: 26,
      startedAt: new Date(Date.now() - 26 * 60000).toISOString(),
      sourceCount: 2,
      romaniaRelevance: 95,
      seoPotential: 86,
      impact: 90,
      risk: 'mediu',
      recommendation: 'scrie acum',
      officialConfirmed: true,
      keywords: ['meteo', 'cod galben', 'județe', 'ANM'],
      entities: ['ANM'],
      sources: [{ name: 'ANM demo', url: '#' }, { name: 'ISU demo', url: '#' }],
      summary: 'Exemplu demo de subiect util, sub 2 ore, cu impact public.',
      reason: 'Are utilitate publică și poate genera căutări locale rapide.',
      seoTitle: 'Cod galben de vreme severă: județele vizate și intervalul avertizării',
      meta: 'Află ce județe sunt vizate, când intră în vigoare avertizarea și ce recomandă autoritățile.',
      editorialAngle: 'Hartă pe județe + recomandări utile pentru cititori.',
      wpCategory: 'Actualitate',
      warnings: ['Demo: verifică sursele oficiale înainte de publicare.'],
      doNotSay: ['Nu afirma pagube sau victime fără confirmare.'],
      coverage: { status: 'neacoperit', label: 'Neacoperit', similarity: 0, matches: [] },
      eligibility: { isEligible: true, blockedReasons: [] },
      priorityScore: 86
    }
  ];
  return {
    generatedAt: new Date().toISOString(),
    topics,
    stats: { checkedFreshTopics: 1, eligibleTopics: 1, blockedTopics: 0 }
  };
}

/* === FIX FINAL: clasificare strictă, brief/SEO/draft publicabile === */
function topicTextAll(topic) {
  return normalize(`${topic.title || ''} ${topic.summary || ''} ${topic.interest || ''} ${(topic.keywords || []).join(' ')} ${(topic.entities || []).join(' ')} ${(topic.sources || []).map((s) => `${s.name || ''} ${s.title || ''} ${s.description || ''} ${s.url || ''}`).join(' ')}`);
}

function cleanTitleBase(topic) {
  return cleanupForArticle(topic.title || topic.seoTitle || 'Subiect nou')
    .replace(/^\s*(breaking|live video|video|interviu)\s*[:|\-–—]?\s*/i, '')
    .replace(/\s*\/\s*/g, '. ')
    .replace(/\s*\|\s*/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectTopicKind(topic) {
  const text = topicTextAll(topic);
  if (/atentionare.*calatorie|calatorie.*mae|greva.*franta|franta.*greva|trafic feroviar|transport feroviar|sncf|trenuri.*franta/.test(text)) return 'travel_alert';
  if (/date personale|bresa de securitate|bre[sș]a de securitate|scurgere de date|expuse din greseala|messi.*cm 2026|cm 2026.*date/.test(text)) return 'data_privacy';
  if (/ana maria branza|scrima|scrim[aă]|valori olimpice|sportivi olimpici|olimpici.*scoli|scoli.*olimpici/.test(text)) return 'edu_sport_values';
  if (/taraclia|balti|b[aă]l[tț]i|predare in rusa|predare.*rusa|limba romana.*republicii moldova|republica moldova.*limba romana/.test(text)) return 'moldova_education';
  if (/memorandum.*camera.*comert|camera de comert.*estonie|camera de comert.*bucuresti|industrie.*estonie/.test(text)) return 'business_memo';
  if (/anofm|locuri de munca|joburi|angajari|somaj|piata muncii|ocuparea fortei de munca|candidati/.test(text)) return 'jobs';
  if (/agricover|fermieri|fermier|agricol|agricultura|culturi|ciclu de cultura|credite agricole|indatorati/.test(text)) return 'agri';
  if (/jupiter|documente false|cetateni ucraineni|refugiati|gazduieste|prejudiciu|frauda|inselaciune|bani publici/.test(text)) return 'fraud_public_money';
  if (/robor|banca|banci|bnr|consiliul concurentei|concurenta|credit|rate|dobanda|dobanzi|manipulare/.test(text)) return 'banking';
  if (/notar|impozit|contributii|prejudiciu|parchet|judecat|trimis in judecata|evaziune|dosar|registrul auto|rar|fals intelectual/.test(text)) return 'legal_tax';
  if (/alimente|adaos|plafon|pret|preturi|retail|magazine|raft|cosul/.test(text)) return 'food_prices';
  if (/tomac|guvern|premier|ministr|coalitie|parlament|pnl|psd|usr|aur|presedint|nicusor|grindeanu|motiune|alegeri/.test(text)) return 'politics';
  if (/misha miller|artist|artista|concert|scena|showbiz|vedeta|vedete|festival/.test(text)) return 'entertainment';
  if (/cfr cluj|fcsb|rapid|dinamo|craiova|fotbal|cantonament|transfer|meci|superliga|club/.test(text)) return 'sport';
  if (/meteo|anm|cod galben|cod portocaliu|furtuni|ploi|canicula|vreme|vijelie/.test(text)) return 'weather';
  if (/bac|evaluare|educatie|scoala|elev|profesor|examen|admitere|subiecte|barem/.test(text)) return 'education';
  if (/sanatate|spital|medic|pacient|boala|tratament|medicament|cnas|dsp/.test(text)) return 'health';
  if (/injunghiat|crima|omor|violenta|accident|incendiu|politie|victima|suspect|retinut|arest/.test(text)) return 'incident';
  if (/ucraina|rusia|nato|patriot|marea neagra|moldova|sua|iran|bulgaria|ue|bruxelles|razboi|rachete|baloane explozive|aparare/.test(text)) return 'external';
  return 'general';
}

function cleanPublisherName(source) {
  const domain = domainFromUrlClient(source?.url || '').replace(/^www\./, '');
  const raw = cleanupForArticle(source?.name || '').trim();
  if (!raw || raw.length > 32 || raw.split(/\s+/).length > 4 || /http|operatiunea|barbat|femeie|breaking|live video|interviu/i.test(raw)) return domain || 'sursa citată';
  return raw;
}

function buildLead(topic) {
  const title = cleanTitleBase(topic);
  const source = cleanPublisherName((topic.sources || [])[0] || {});
  const kind = detectTopicKind(topic);
  const leads = {
    travel_alert: `Românii care călătoresc cu trenul în Franța pot fi afectați de greva din transportul feroviar, potrivit informațiilor atribuite MAE și relatate de ${source}. Partea utilă este unde pot apărea întârzieri, ce trebuie verificat înainte de plecare și cum se evită blocajele de traseu.`,
    data_privacy: `O breșă de securitate legată de Campionatul Mondial din 2026 ridică întrebări despre date personale, acces și protecția informațiilor sensibile, potrivit ${source}. Pentru cititori, partea importantă nu este numele implicat, ci ce tip de date au fost expuse și ce măsuri au fost luate.`,
    edu_sport_values: `Ana Maria Brânză vorbește despre întâlnirile foștilor olimpici cu elevii și despre felul în care sportul poate fi folosit ca lecție de disciplină, eșec și reluare a muncii de jos, potrivit ${source}. Subiectul merită tratat ca educație prin sport, nu ca simplu interviu.`,
    moldova_education: `Profesori din școli cu predare în limba rusă din Republica Moldova vin în România într-un program legat de predarea limbii române, potrivit ${source}. Pentru publicul din România, subiectul ține de educație, identitate lingvistică și legătura cu Republica Moldova.`,
    business_memo: `Camera de Comerț și Industrie a Municipiului București și Camera de Comerț și Industrie a Estoniei au semnat un memorandum de înțelegere, potrivit ${source}. Subiectul contează pentru firmele interesate de contacte economice, proiecte comune și acces la piețe din regiunea baltică.`,
    jobs: `Piața muncii din România este sub presiune, iar datele despre posturile disponibile trebuie privite pe județe, domenii și nivel de pregătire, potrivit ${source}. Pentru cei care caută un job, numărul total este doar începutul: contează unde sunt locurile, ce se cere și cât de repede se actualizează oferta.`,
    agri: `Datele despre datoriile fermierilor români arată presiunea financiară din agricultură, potrivit ${source}. Subiectul contează dincolo de ferme, pentru că finanțarea culturilor poate influența producția, investițiile și, indirect, prețurile alimentelor.`,
    fraud_public_money: `Un dosar privind bani publici și documente false pentru găzduirea refugiaților ucraineni ridică problema verificării plăților făcute de stat, potrivit ${source}. Pentru cititori, partea importantă este prejudiciul, mecanismul reclamat de anchetatori și recuperarea banilor.`,
    banking: `Discuția despre bănci, ROBOR și regulile de concurență are efect direct pentru oamenii cu credite, potrivit ${source}. Articolul trebuie să explice ce se anchetează, cine are competență și ce poate însemna pentru rate și încrederea în piața bancară.`,
    legal_tax: `Un dosar cu posibil prejudiciu sau documente false trebuie explicat prin faptele comunicate oficial, stadiul procedurii și efectul asupra banilor publici, potrivit ${source}. Pentru cititori contează diferența dintre acuzații, anchetă și verdict.`,
    politics: `Negocierile și declarațiile politice pot schimba calendarul unei majorități, lista de miniștri sau raportul de forțe dintre partide, potrivit ${source}. Partea relevantă pentru cititori este cine poate lua decizia și ce efect are asupra guvernării.`,
    food_prices: `Deciziile privind plafonarea adaosului comercial la alimente sunt importante pentru cumpărători și magazine, potrivit ${source}. Textul trebuie să arate ce produse sunt vizate, până când se aplică măsura și ce efect se poate vedea la raft.`,
    sport: `Programul unei echipe înaintea noului sezon contează pentru suporteri prin reunire, cantonament, lot și meciuri amicale, potrivit ${source}. Materialul trebuie să scoată datele utile, nu doar să repete anunțul clubului.`,
    weather: `Avertizările meteo schimbă programul oamenilor din zonele vizate, potrivit ${source}. Informația utilă este intervalul, județele afectate și recomandările pentru trafic, locuințe și activități în aer liber.`,
    education: `Subiectul din educație contează pentru elevi, părinți și profesori prin calendar, proceduri și documente oficiale, potrivit ${source}. Textul trebuie să arate cine este vizat și ce termen trebuie urmărit.`,
    health: `Subiectul medical trebuie explicat prin efectul asupra pacienților, accesului la servicii și procedurilor oficiale, potrivit ${source}. Cititorii au nevoie să știe ce se schimbă concret și unde verifică informația.`,
    incident: `Incidentul relatat trebuie tratat cu prudență, prin date confirmate despre persoane implicate, intervenția autorităților și măsurile luate, potrivit ${source}. Articolul trebuie să evite detaliile spectaculoase și să explice ce este confirmat.`,
    external: `Subiectul extern are relevanță pentru România atunci când atinge securitatea regională, deciziile UE/NATO, vecinătatea estică sau costurile războiului, potrivit ${source}. Textul trebuie să explice legătura românească, nu doar să preia informația de peste graniță.`,
    entertainment: `Subiectul de entertainment trebuie scris prin povestea persoanei, traseu, context local și interesul publicului, potrivit ${source}. Nu este suficientă reluarea unei declarații; contează ce spune momentul despre carieră și public.`
  };
  return leads[kind] || `${title}, potrivit ${source}. Articolul trebuie să explice informația principală, persoanele vizate și efectul concret pentru cititori.`;
}

function buildImpactReasonClient(topic) {
  const kind = detectTopicKind(topic);
  const map = {
    travel_alert: 'Contează pentru românii care sunt sau urmează să plece în Franța: pot apărea întârzieri, anulări ori schimbări de traseu. Informația utilă este ce transporturi sunt afectate și unde se verifică actualizările înainte de plecare.',
    data_privacy: 'Contează pentru că arată cât de ușor pot ajunge date personale în afara controlului, inclusiv în jurul unor evenimente mari precum CM 2026. Pentru cititori, întrebarea reală este ce date au fost expuse și ce măsuri de protecție au fost anunțate.',
    edu_sport_values: 'Contează pentru elevi și profesori pentru că aduce sportul de performanță în școală ca model de disciplină, eșec gestionat și reluare a muncii. Subiectul este despre educație prin exemple reale, nu despre securitate sau politică externă.',
    moldova_education: 'Contează pentru România și Republica Moldova prin limba română, educație și legătura dintre comunități. Programul poate influența felul în care profesorii predau limba română în zone cu predare în rusă.',
    business_memo: 'Contează pentru firmele din București și Estonia care pot folosi memorandumul pentru contacte, proiecte și colaborări. Pentru cititori, partea utilă este ce oportunități economice pot apărea și cine le poate accesa.',
    jobs: 'Contează pentru cei care caută un loc de muncă și pentru firmele care angajează. Numărul total nu spune totul: diferențele pe județe, domenii și condiții pot decide șansele reale ale candidaților.',
    agri: 'Contează pentru că datoriile fermierilor pot influența investițiile în culturi, capacitatea de producție și presiunea asupra prețurilor alimentelor. Agricultura finanțată pe credit ajunge să conteze și pentru consumatori.',
    fraud_public_money: 'Contează pentru că implică bani publici destinați sprijinului pentru refugiați și posibile documente false. Cititorii trebuie să înțeleagă mecanismul anchetat, prejudiciul și ce controale lipsesc sau urmează.',
    banking: 'Contează pentru românii cu rate și pentru încrederea în sistemul bancar. O anchetă de concurență poate ridica întrebări despre costul creditelor, regulile pieței și drepturile clienților.',
    legal_tax: 'Contează prin bani publici, documente oficiale și răspunderea celor care au atribuții legale sau fiscale. Articolul trebuie să separe clar acuzațiile de verdict și să explice prejudiciul.',
    politics: 'Contează pentru că negocierile politice pot schimba guvernarea, calendarul deciziilor și numele celor care ajung în funcții. Cititorii au nevoie să știe ce se decide concret, nu doar cine atacă pe cine.',
    food_prices: 'Contează pentru bugetul zilnic al familiilor și pentru regulile după care vând magazinele. Cititorii caută lista produselor, termenul măsurii și efectul real la raft.',
    sport: 'Contează pentru suporteri prin program, lot, cantonament și pregătirea sezonului. Cititorii vor repere clare: când se reunește echipa, unde merge și ce schimbări apar în lot.',
    weather: 'Contează imediat pentru oamenii din zonele vizate: trafic, locuințe, școli, culturi agricole și evenimente. Informația utilă este intervalul avertizării și recomandarea autorităților.',
    education: 'Contează pentru elevi, părinți și profesori prin termene, proceduri, rezultate sau metodologii. Un text util spune cine este vizat și unde se verifică documentul oficial.',
    health: 'Contează pentru pacienți și familii prin acces, costuri, programări sau reguli medicale. Articolul trebuie să explice procedura concretă și sursa oficială.',
    incident: 'Contează prin siguranța oamenilor și reacția autorităților. Textul trebuie să spună ce este confirmat, ce măsuri s-au luat și ce date nu trebuie tratate ca verdict.',
    external: 'Contează pentru România dacă subiectul schimbă securitatea regională, poziția UE/NATO, sprijinul pentru Ucraina sau riscurile din vecinătate. Legătura cu cititorul trebuie spusă clar.',
    entertainment: 'Contează prin interesul publicului pentru persoană, traseu, context local și mesajul din declarații. Articolul trebuie să spună de ce momentul e relevant, nu doar ce a spus artistul.'
  };
  return map[kind] || 'Contează dacă schimbă ceva concret pentru cititori: bani, timp, siguranță, drepturi, servicii publice sau decizii instituționale.';
}

function inferAffectedPeople(topic) {
  const kind = detectTopicKind(topic);
  const map = {
    travel_alert: 'românii care călătoresc în Franța, turiștii, navetiștii și cei care folosesc trenurile',
    data_privacy: 'persoanele ale căror date pot fi expuse, fanii și organizatorii evenimentelor sportive mari',
    edu_sport_values: 'elevii, profesorii, școlile și foștii sportivi implicați în proiecte educaționale',
    moldova_education: 'profesorii din Republica Moldova, elevii din școli cu predare în rusă și instituțiile educaționale',
    business_memo: 'firmele din București, companiile interesate de Estonia și camerele de comerț implicate',
    jobs: 'candidații, angajatorii și agențiile județene pentru ocuparea forței de muncă',
    agri: 'fermierii, finanțatorii agricoli și consumatorii afectați indirect de costurile producției',
    fraud_public_money: 'contribuabilii, autoritățile care au făcut plăți și beneficiarii reali ai sprijinului pentru refugiați',
    banking: 'românii cu credite, băncile și instituțiile care reglementează piața financiară',
    legal_tax: 'contribuabilii, instituțiile judiciare și persoanele vizate de dosar',
    politics: 'alegătorii, partidele și instituțiile care depind de următoarea decizie politică',
    food_prices: 'cumpărătorii, magazinele, procesatorii și autoritățile de control',
    sport: 'suporterii, clubul, jucătorii și stafful tehnic',
    weather: 'locuitorii din zonele vizate, șoferii și autoritățile locale',
    education: 'elevii, părinții, profesorii și inspectoratele',
    health: 'pacienții, medicii și instituțiile medicale',
    incident: 'persoanele implicate, comunitatea locală și autoritățile de anchetă',
    external: 'românii interesați de securitatea regională, deciziile UE/NATO și efectele războiului din vecinătate',
    entertainment: 'publicul artistului, organizatorii și comunitatea locală unde are loc evenimentul'
  };
  return map[kind] || 'cititorii care pot fi afectați concret de informație';
}

function inferNextStep(topic) {
  const kind = detectTopicKind(topic);
  const map = {
    travel_alert: 'actualizările MAE și ale operatorilor feroviari din Franța',
    data_privacy: 'precizările organizatorilor, măsurile de securitate și eventualele notificări privind datele expuse',
    edu_sport_values: 'școlile incluse în program și calendarul întâlnirilor cu foștii olimpici',
    moldova_education: 'calendarul programului și instituțiile care organizează perfecționarea profesorilor',
    business_memo: 'proiectele concrete care pot apărea după semnarea memorandumului',
    jobs: 'actualizarea ofertei ANOFM pe județe și domenii',
    agri: 'costul finanțării și următoarea campanie agricolă',
    fraud_public_money: 'comunicatele anchetatorilor și recuperarea prejudiciului',
    banking: 'pozițiile Consiliului Concurenței, BNR și ale băncilor vizate',
    legal_tax: 'stadiul dosarului și documentele oficiale ale Parchetului sau instanței',
    politics: 'următoarea rundă de negocieri, vot sau anunț instituțional',
    food_prices: 'publicarea actului și lista produselor vizate',
    sport: 'programul oficial al cantonamentului, lotul și meciurile amicale',
    weather: 'actualizarea avertizărilor ANM și intervențiile autorităților',
    education: 'calendarul oficial, metodologia sau rezultatele publicate',
    health: 'procedura oficială și recomandările instituțiilor medicale',
    incident: 'comunicatul autorităților și măsurile luate în anchetă',
    external: 'reacțiile oficiale și deciziile UE/NATO sau ale statelor implicate',
    entertainment: 'programul evenimentelor, declarațiile noi și reacția publicului'
  };
  return map[kind] || 'documentul oficial sau reacția instituției competente';
}

function buildOficiulAngle(topic) {
  const kind = detectTopicKind(topic);
  const title = cleanTitleBase(topic);
  const map = {
    travel_alert: 'Unghi propriu: nu relua doar avertizarea MAE; fă material util pentru românii care pleacă sau sunt deja în Franța: trenuri afectate, ce verifică înainte de drum, ce alternative au.',
    data_privacy: 'Unghi propriu: mută accentul de pe numele celebru pe datele personale expuse, riscul pentru fani și felul în care organizatorii trebuie să protejeze informațiile înainte de CM 2026.',
    edu_sport_values: 'Unghi propriu: tratează interviul ca educație prin sport: ce învață elevii de la foști olimpici despre disciplină, eșec și muncă, nu ca simplu material de lifestyle.',
    moldova_education: 'Unghi propriu: explică legătura dintre limba română, profesorii din Republica Moldova și rolul României în pregătirea cadrelor din școli cu predare în rusă.',
    business_memo: 'Unghi propriu: arată ce oportunități poate deschide memorandumul pentru firmele din București și Estonia, nu doar că a fost semnat un document protocolar.',
    jobs: 'Unghi propriu: pornește de la numărul de posturi și explică unde are sens să caute candidații, ce domenii absorb oameni și de ce oferta diferă mult între județe.',
    agri: 'Unghi propriu: arată cum datoriile fermierilor pot ajunge să influențeze culturile, investițiile și prețurile alimentelor, nu doar bilanțul Agricover.',
    fraud_public_money: 'Unghi propriu: pune accent pe banii publici, mecanismul documentelor false și controalele care ar trebui să protejeze sprijinul pentru refugiați.',
    banking: 'Unghi propriu: explică efectul pentru clienții cu rate și pentru încrederea în bănci, nu doar conflictul dintre instituții.',
    legal_tax: 'Unghi propriu: explică prejudiciul, obligațiile fiscale sau documentele false și stadiul dosarului, cu diferența clară între acuzație și verdict.',
    politics: 'Unghi propriu: arată ce schimbă declarația în negocieri: cine câștigă timp, cine pierde presiune și ce decizie instituțională poate urma.',
    food_prices: 'Unghi propriu: explică ce produse intră pe listă, cât durează plafonarea și cum se poate vedea măsura în prețul de la raft.',
    sport: 'Unghi propriu: scrie pentru suporteri: program, cantonament, lot, amicale și ce anunță pregătirea despre noul sezon.',
    weather: 'Unghi propriu: transformă avertizarea în informație practică: zone, ore, riscuri și recomandări pentru oameni.',
    education: 'Unghi propriu: arată exact ce trebuie să știe elevii, părinții și profesorii: calendar, procedură, documente și termen.',
    health: 'Unghi propriu: explică efectul pentru pacienți: acces, costuri, programări, documente sau riscul de confuzie.',
    incident: 'Unghi propriu: separă faptele confirmate de detaliile neclare și explică reacția autorităților și riscul pentru comunitate.',
    external: 'Unghi propriu: explică legătura cu România prin securitate, bugete, decizii UE/NATO sau riscurile de la granița estică.',
    entertainment: 'Unghi propriu: găsește povestea din spatele declarației: traseul artistului, scena, publicul și de ce momentul are interes acum.'
  };
  return map[kind] || `Unghi propriu: găsește ce lipsește din relatările inițiale despre „${title}”: efectul concret, persoanele vizate și documentul care poate confirma informația.`;
}

function showBrief(topic) {
  const focusKeyword = buildFocusKeyword(topic);
  const titleIdea = buildSeoTitleIdeas(topic)[0] || buildSeoHeadline(topic);
  el.dialogTitle.textContent = 'Brief + reguli șef';
  el.dialogBody.innerHTML = `
    <h3>${escapeHtml(cleanTitleBase(topic))}</h3>
    <div class="editorial-box">
      <p><strong>Unghi editorial:</strong> ${escapeHtml(buildOficiulAngle(topic).replace(/^Unghi propriu:\s*/,'').replace(/^Unghi:\s*/,''))}</p>
    </div>
    <h3>Rezumat rapid</h3>
    <ul>
      <li><strong>Ce s-a întâmplat:</strong> ${escapeHtml(cleanTitleBase(topic))}</li>
      <li><strong>De ce contează:</strong> ${escapeHtml(buildImpactReasonClient(topic))}</li>
      <li><strong>Cine este afectat:</strong> ${escapeHtml(inferAffectedPeople(topic))}</li>
      <li><strong>Ce urmărești mai departe:</strong> ${escapeHtml(inferNextStep(topic))}</li>
    </ul>
    <h3>Structură recomandată</h3>
    <ol>
      <li><strong>Titlu:</strong> ${escapeHtml(titleIdea)}</li>
      <li><strong>Șapou:</strong> ${escapeHtml(buildLead(topic))}</li>
      ${buildSeoH2Recommendations(topic).slice(0,4).map((h) => `<li><strong>H2:</strong> ${escapeHtml(h)}</li>`).join('')}
    </ol>
    <h3>SEO rapid</h3>
    <p><strong>Focus keyword:</strong> ${escapeHtml(focusKeyword)}</p>
    <p><strong>Meta description:</strong> ${escapeHtml(buildMetaClient(topic, focusKeyword))}</p>
    <p><strong>Categorie:</strong> ${escapeHtml(buildCategoryForKind(topic))}</p>
    <p><strong>Taguri:</strong> ${escapeHtml(buildTags(topic).join(', '))}</p>
    <h3>Surse externe detectate</h3>
    <ul>${(topic.sources || []).slice(0, 4).map((s) => `<li><a href="${escapeAttr(s.url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(cleanPublisherName(s))}${escapeHtml(formatAuthor(s))}</a></li>`).join('') || '<li>Nu există surse externe disponibile în card.</li>'}</ul>
    <h3>Întrebări utile pentru telefon</h3>
    <ol>${buildPhoneQuestions(topic).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>
  `;
  openDialog();
}

function buildCategoryForKind(topic) {
  const kind = detectTopicKind(topic);
  const map = { jobs:'Business', agri:'Business', food_prices:'Business', banking:'Business', business_memo:'Business', travel_alert:'Călătorii', sport:'Sport', education:'Actualitate', edu_sport_values:'Actualitate', moldova_education:'Actualitate', health:'Health & Fitness', politics:'Politică', external:'Extern', data_privacy:'Tehnologie', entertainment:'Entertainment & Showbiz', weather:'Actualitate', incident:'Actualitate', legal_tax:'Actualitate', fraud_public_money:'Actualitate' };
  return map[kind] || (topic.wpCategory || topic.category || 'Actualitate');
}

function buildFocusKeyword(topic) {
  const titles = buildSeoTitleIdeas(topic);
  const source = titles[0] || cleanTitleBase(topic);
  const stop = new Set(['si','sau','cu','de','la','in','pe','pentru','din','un','o','ce','cum','este','sunt','despre','mai','video','foto','live','interviu','care','prin','pana']);
  return removeDiacritics(normalize(source).split(/\s+/).filter((w) => w.length > 2 && !stop.has(w)).slice(0, 4).join(' ')).toLowerCase();
}

function buildMetaClient(topic, focusKeyword) {
  const kind = detectTopicKind(topic);
  const map = {
    travel_alert: 'Romanii care merg in Franta pot fi afectati de greva feroviara. Ce trebuie verificat inainte de calatorie.',
    data_privacy: 'Ce date personale au fost expuse in bresa de securitate si de ce conteaza protectia informatiilor inainte de CM 2026.',
    edu_sport_values: 'Ana Maria Branza vorbeste despre valorile olimpice in scoli si lectiile pe care elevii le primesc de la fosti sportivi.',
    moldova_education: 'Profesori din Republica Moldova vin in Romania pentru predarea limbii romane. Ce inseamna programul pentru elevi.',
    business_memo: 'Camera de Comert Bucuresti si Estonia au semnat un memorandum. Ce oportunitati poate deschide pentru firme.',
    jobs: 'Locuri de munca disponibile in Romania. Ce trebuie sa verifice cei care cauta un job prin ANOFM.',
    agri: 'Datoriile fermierilor romani si creditele agricole pot influenta investitiile, culturile si preturile alimentelor.',
    fraud_public_money: 'Dosar cu bani publici si documente false pentru gazduirea refugiatilor ucraineni. Ce ancheteaza procurorii.',
    banking: 'Ancheta privind bancile si ROBOR conteaza pentru romanii cu rate. Ce institutii trebuie urmarite.',
    food_prices: 'Adaos comercial plafonat la alimente. Ce produse, ce termen si ce efect poate avea decizia la raft.',
    politics: 'Negocierile politice pot schimba guvernarea si lista de ministri. Ce decizie trebuie urmarita.',
    external: 'Subiect extern cu efect pentru Romania, UE si NATO. Ce legatura are cu securitatea regionala.',
    sport: 'Programul echipei, cantonamentul si lotul pentru noul sezon. Ce trebuie sa stie suporterii.',
    weather: 'Avertizare meteo in Romania. Zonele vizate, intervalul anuntat si recomandarile pentru locuitori.',
    legal_tax: 'Dosar fiscal sau penal cu prejudiciu. Ce spun anchetatorii si ce trebuie inteles despre procedura.',
    incident: 'Incident anchetat de autoritati. Ce date sunt confirmate si ce masuri au fost anuntate.'
  };
  return removeDiacritics((map[kind] || `Afla ce se stie despre ${focusKeyword}, cine este vizat si ce efect concret are subiectul.`).slice(0, 158));
}

function buildSeoTitleIdeas(topic) {
  const kind = detectTopicKind(topic);
  const t = cleanTitleBase(topic);
  const e = (topic.entities || []).filter(Boolean)[0] || sentenceCase(buildFocusKeyword(topic));
  const sets = {
    travel_alert: [
      'Românii care merg cu trenul în Franța pot fi afectați de grevă. Avertizarea MAE pentru călători',
      'Grevă în transportul feroviar din Franța. Ce trebuie să verifice românii înainte de plecare',
      'Atenționare MAE pentru Franța: trenuri afectate și posibile întârzieri pentru călători',
      'Călătorii în Franța, afectați de greva feroviară. Recomandările pe care trebuie să le verifice românii',
      'Trafic feroviar perturbat în Franța. Ce riscă românii care au drumuri programate',
      'Franța, sub avertizare de călătorie pentru grevă. Unde verifică românii informațiile despre trenuri'
    ],
    data_privacy: [
      'Date personale expuse înainte de CM 2026. Ce arată cazul Messi despre securitatea informațiilor',
      'Messi și breșa de securitate de la CM 2026. Ce date au fost expuse din greșeală',
      'Breșă de securitate înainte de Cupa Mondială. De ce contează protecția datelor fanilor',
      'Cazul Messi ridică problema datelor personale la evenimente sportive mari',
      'Ce se știe despre datele expuse înainte de CM 2026 și cine trebuie să răspundă',
      'Securitatea digitală la CM 2026: lecția din cazul datelor personale expuse'
    ],
    edu_sport_values: [
      'Ana Maria Brânză duce valorile olimpice în școli. Ce mesaj primesc elevii de la foștii sportivi',
      'Foști olimpici în fața elevilor. Lecția despre muncă, eșec și reluarea de la capăt',
      'Sportul ca lecție pentru școală: ce le spune Ana Maria Brânză elevilor',
      'Valorile olimpice ajung în școli prin foști sportivi. De ce contează pentru elevi',
      'Ana Maria Brânză, despre ce învață copiii din sportul de performanță',
      'De la podium la clasă: mesajul foștilor olimpici pentru elevi'
    ],
    moldova_education: [
      'Profesori din școli cu predare în rusă vin în România pentru limba română. De ce contează programul',
      'Limba română în școlile din Taraclia și Bălți. Programul care aduce profesori în România',
      'România pregătește profesori din Republica Moldova pentru predarea limbii române',
      'Profesori din Republica Moldova, la perfecționare în România. Cine sunt elevii vizați',
      'Predarea limbii române în școli cu predare în rusă. Ce schimbă programul pentru profesori',
      'Educație și limbă română peste Prut. De ce vin profesorii din Taraclia și Bălți în România'
    ],
    business_memo: [
      'București și Estonia, legătură prin camerele de comerț. Ce poate aduce memorandumul pentru firme',
      'Memorandum între Camera de Comerț București și Estonia. Ce oportunități pot apărea pentru companii',
      'Firmele din București pot avea o nouă punte spre Estonia după memorandumul camerelor de comerț',
      'Colaborare economică București–Estonia. Ce înseamnă documentul semnat de camerele de comerț',
      'Un memorandum economic deschide discuții între București și Estonia. Cine poate profita',
      'Camera de Comerț București și partenerii din Estonia: ce urmează pentru mediul de afaceri'
    ],
    jobs: [
      'Aproape 34.000 de locuri de muncă în România. Ce verifică cei care caută un job',
      'Locuri de muncă prin ANOFM. Unde trebuie să caute românii care vor să se angajeze',
      'Piața muncii se strânge pentru candidați. Ce arată datele despre joburile disponibile',
      'Joburi disponibile în România: județul și domeniul pot conta mai mult decât numărul total',
      'Ce trebuie să știe candidații înainte să aplice la ofertele ANOFM',
      'Mai puține locuri de muncă și concurență mai mare. Cum se vede piața pentru candidați'
    ],
    agri: [
      'Fermierii români și presiunea datoriilor. Ce arată datele Agricover despre creditele agricole',
      'Cât de îndatorați sunt fermierii români și de ce contează pentru prețurile alimentelor',
      'Creditele fermierilor, între ciclul de cultură și investițiile pe termen mediu',
      'Agricultura românească depinde tot mai mult de finanțare. Ce spune Agricover despre datorii',
      'Datoriile din agricultură și riscul pentru următorul ciclu de cultură',
      'De ce creditele fermierilor pot ajunge să conteze și pentru consumatori'
    ],
    fraud_public_money: [
      'Bani pentru refugiați ucraineni, obținuți cu documente false. Ce anchetează procurorii',
      'Caz Jupiter în Maramureș: plăți pentru găzduirea refugiaților, sub lupa anchetatorilor',
      'Documente false pentru bani publici. Cum este descris dosarul privind refugiații ucraineni',
      'Anchetă penală după plăți pentru refugiați ucraineni. Ce prejudiciu este verificat',
      'Sprijinul pentru refugiați și controalele statului. Ce arată cazul din Maramureș',
      'Dosar cu bani publici și refugiați ucraineni. Ce trebuie urmărit în anchetă'
    ],
    banking: [
      'ROBOR, bănci și concurență. Ce trebuie să știe românii cu rate',
      'Ancheta privind băncile și ROBOR: unde este problema pentru clienți',
      'Ratele românilor și regulile de concurență. Ce se discută în cazul băncilor',
      'Ce pot afla clienții după acuzațiile legate de manipularea ROBOR',
      'Consiliul Concurenței și băncile. De ce contează dosarul pentru credite',
      'Costul creditelor și încrederea în piața bancară: ce întrebări ridică ancheta'
    ],
    legal_tax: [
      'Dosar cu documente false sau prejudiciu. Ce trebuie înțeles din acuzațiile anchetatorilor',
      'Bani care trebuiau să ajungă la stat. Ce arată dosarul și ce urmează în instanță',
      'Fals intelectual, impozite sau prejudiciu: ce spun anchetatorii și ce nu este încă verdict',
      'Cazul care pune presiune pe controalele instituțiilor. Ce documente sunt vizate',
      'Prejudiciu și răspundere legală. De ce contează dosarul pentru contribuabili',
      'Anchetă cu efect public: acuzațiile, instituția vizată și prezumția de nevinovăție'
    ],
    food_prices: [
      'Adaos comercial plafonat la alimente. Ce produse și ce termen contează pentru cumpărători',
      'Alimentele de bază rămân cu prețuri plafonate. Ce se schimbă la raft',
      'Plafonarea adaosului comercial, prelungită. Cine verifică magazinele și ce urmăresc cumpărătorii',
      'Coșul zilnic și plafonarea prețurilor. Ce trebuie să știe românii până la finalul anului',
      'Lista alimentelor cu adaos plafonat. Ce produse rămân în măsură',
      'Prețurile la alimente și decizia Parlamentului. Ce efect poate avea pentru familii'
    ],
    politics: [
      `${e} și negocierile politice. Ce se poate schimba după noul anunț`,
      'Schimbare de poziție în negocieri. Cine câștigă timp și cine pierde teren',
      'Numele de miniștri, între presiune politică și compromis. Ce urmează pentru partide',
      `De ce declarația lui ${e} poate schimba calculele pentru viitorul Guvern`,
      `Negocierile pentru putere intră într-o nouă etapă. Ce semnal transmite ${e}`,
      'Partidele caută nume acceptate de toți. Ce arată disputa din jurul miniștrilor'
    ],
    external: [
      'Războiul din Ucraina și costul deciziilor militare. Ce contează pentru România',
      'Apărarea Ucrainei se schimbă prin soluții ieftine. De ce urmărește România subiectul',
      'Decizii militare în regiune. Ce legătură au cu securitatea României',
      'Ucraina, Rusia și presiunea pe apărarea aeriană. Ce trebuie urmărit la granița estică',
      'Soluții de război cu cost mic și efect regional. De ce contează pentru flancul estic',
      'Cum schimbă războiul calculele de securitate din vecinătatea României'
    ],
    sport: [
      `${e}: programul de pregătire și primele semne pentru noul sezon`,
      'Reunirea echipei și cantonamentul: ce urmează pentru lot',
      `Cum se pregătește ${e} pentru sezon. Datele care contează pentru suporteri`,
      'Cantonament, lot și meciuri amicale. Ce trebuie urmărit înainte de sezon',
      'Primele decizii după reunire. Ce arată programul echipei',
      'Suporterii află primele repere ale pregătirii: lot, amicale și cantonament'
    ],
    entertainment: [
      'Misha Miller, de pe scena din Iași la povestea celor două vieți paralele',
      'Cum a ajuns Misha Miller în fața publicului din Iași și ce spune despre drumul ei',
      'Povestea Misha Miller: scena, publicul și declarația care a atras atenția',
      'Misha Miller și momentul de la Iași. De ce caută publicul povestea artistei',
      'De la declarație la carieră: ce arată apariția Misha Miller de la Iași',
      'Misha Miller, între scenă și poveste personală. Ce se știe acum'
    ]
  };
  const generic = [
    `${t}. Ce se știe acum și cine este afectat`,
    `Ce schimbă informația despre ${e} pentru public`,
    `Datele noi din surse și efectul concret pentru cititori`,
    `Contextul care lipsește din primele relatări despre ${e}`,
    `Cine este vizat de subiect și ce document trebuie urmărit`,
    `De ce informația despre ${e} nu trebuie tratată ca simplă preluare`
  ];
  return Array.from(new Set((sets[kind] || generic).map((x) => shortenTitleForSeo(x).replace(/\s+/g,' ').trim()).filter(Boolean))).slice(0,6);
}

function buildSeoH2Recommendations(topic) {
  const kind = detectTopicKind(topic);
  const sets = {
    travel_alert: ['Grevă în transportul feroviar din Franța: ce anunță MAE', 'Ce trebuie să verifice românii înainte de călătorie', 'Trenuri, întârzieri și alternative pentru călători', 'Unde apar actualizările oficiale despre traficul feroviar', 'Cum pot fi afectați turiștii și românii din Franța'],
    data_privacy: ['Ce date personale au fost expuse înainte de CM 2026', 'De ce breșa de securitate contează pentru fani și organizatori', 'Ce măsuri trebuie explicate după expunerea datelor', 'Cum ajung informațiile sensibile să devină risc public', 'Ce trebuie urmărit până la Campionatul Mondial'],
    edu_sport_values: ['Ana Maria Brânză și valorile olimpice duse în școli', 'Ce le spun foștii sportivi olimpici elevilor', 'De ce sportul poate fi lecție despre muncă și eșec', 'Cum pot folosi școlile exemplele din performanță', 'Ce urmează pentru proiectele educaționale prin sport'],
    moldova_education: ['Profesori din Taraclia și Bălți vin în România pentru limba română', 'De ce contează predarea limbii române în școli cu predare în rusă', 'Legătura dintre educație, Republica Moldova și România', 'Cine organizează programul de perfecționare', 'Ce efect poate avea pregătirea profesorilor asupra elevilor'],
    business_memo: ['Memorandum București–Estonia între camerele de comerț', 'Ce oportunități poate deschide documentul pentru firme', 'Domeniile în care pot apărea proiecte comune', 'De ce contează Estonia pentru mediul de afaceri din București', 'Pașii următori după semnarea memorandumului'],
    jobs: ['Locuri de muncă disponibile prin ANOFM: ce arată oferta națională', 'Unde trebuie să caute cei care vor să se angajeze acum', 'Ce domenii pot avea nevoie de oameni și ce verifică un candidat', 'De ce numărul posturilor libere diferă de la un județ la altul', 'Ce pași trebuie făcuți înainte de aplicare'],
    agri: ['Datoriile fermierilor români și presiunea pe următorul ciclu agricol', 'Credite pe termen mediu și finanțarea culturilor: ce spune Agricover', 'De ce costul finanțării poate influența producția agricolă', 'Cum se poate vedea presiunea din ferme în prețurile alimentelor', 'Ce urmăresc fermierii înainte de următoarea campanie agricolă'],
    external: ['Ce schimbă subiectul pentru securitatea din vecinătatea României', 'Legătura cu Ucraina, Rusia și deciziile de apărare', 'De ce soluțiile militare ieftine pot conta în războiul de uzură', 'Cum poate afecta subiectul flancul estic al NATO', 'Reacțiile oficiale care trebuie urmărite'],
    politics: ['Declarația care poate schimba negocierile politice', 'Cine câștigă timp și cine pierde presiune', 'Numele de miniștri și compromisul dintre partide', 'Calendarul deciziei politice care trebuie urmărit', 'Ce efect poate avea disputa asupra viitorului Guvern'],
    sport: ['Programul de pregătire și cantonamentul echipei', 'Ce jucători sunt așteptați la reunire', 'Meciurile amicale și datele care trebuie confirmate', 'De ce pregătirea contează pentru suporteri', 'Ce poate urma pe piața transferurilor'],
    food_prices: ['Alimentele cu adaos comercial plafonat: ce se schimbă pentru cumpărători', 'Lista produselor vizate și termenul până la care se aplică măsura', 'Cum se vede plafonarea la raft și în bugetul familiei', 'Cine controlează magazinele și ce riscă retailerii', 'Ce efect poate avea decizia asupra prețurilor']
  };
  const fallback = [`${cleanTitleBase(topic)}: informația nouă din surse`, `Cine este afectat concret de subiect`, `Ce document sau reacție poate schimba articolul`, `Contextul care lipsește din primele relatări`, `Ce trebuie urmărit în următoarele zile`];
  return Array.from(new Set((sets[kind] || fallback).map((x) => x.replace(/\s+/g,' ').trim()).filter(Boolean))).slice(0,5);
}

function showTitles(topic) {
  const focusKeyword = buildFocusKeyword(topic);
  const titles = buildSeoTitleIdeas(topic);
  el.dialogTitle.textContent = 'SEO complet';
  el.dialogBody.innerHTML = `
    <h3>Titluri propuse</h3>
    <ol>${titles.map((title) => `<li>${escapeHtml(title)}</li>`).join('')}</ol>
    <h3>Pachet SEO</h3>
    <p><strong>Focus keyword:</strong> ${escapeHtml(focusKeyword)}</p>
    <p><strong>SEO title fără diacritice:</strong> ${escapeHtml(removeDiacritics(titles[0] || cleanTitleBase(topic)))}</p>
    <p><strong>Slug:</strong> ${escapeHtml(slugify(titles[0] || cleanTitleBase(topic)))}</p>
    <p><strong>Meta description:</strong> ${escapeHtml(buildMetaClient(topic, focusKeyword))}</p>
    <p><strong>Excerpt:</strong> ${escapeHtml(buildLead(topic))}</p>
    <p><strong>Categorie principală:</strong> ${escapeHtml(buildCategoryForKind(topic))}</p>
    <p><strong>Categorii secundare:</strong> ${escapeHtml(buildSecondaryCategories(topic).join(', '))}</p>
    <p><strong>Taguri max 4:</strong> ${escapeHtml(buildTags(topic).join(', '))}</p>
    <h3>H2/H3 recomandate</h3>
    <ul>${buildSeoH2Recommendations(topic).map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>
  `;
  openDialog();
}

function buildLocalCopyPasteDraft(topic) {
  const sources = getCleanSources(topic).slice(0, 2);
  const title = buildPublishableDraftTitle(topic);
  const lead = buildLead(topic);
  const h2s = buildSeoH2Recommendations(topic).slice(0, 3);
  const source = sources[0] || {};
  const sourceName = cleanPublisherName(source);
  const detail = firstUsefulDetail(topic, sources) || cleanTitleBase(topic);
  const link = source.url ? `[${sourceName}](${source.url})` : sourceName;
  const kind = detectTopicKind(topic);
  const section1 = `Potrivit ${link}, ${lowercaseFirstForArticle(shortenForArticle(detail, 340))}.`;
  const impact = buildImpactReasonClient(topic);
  const short = buildArticleShortBox(topic, sources).replace(/Subiectul apare în.*$/,'').trim();
  const next = inferNextStep(topic);
  const endings = {
    travel_alert: `Pentru cei care au drumuri programate în Franța, următoarea informație importantă este actualizarea transmisă de MAE sau de operatorii feroviari. Până atunci, articolul trebuie să rămână util: ce linii pot fi afectate, când este greva și unde verifică oamenii înainte să plece.`,
    data_privacy: `Următorul element important este reacția organizatorilor și măsurile de protecție anunțate după expunerea datelor. Pentru public, cazul rămâne relevant atât timp cât arată cum sunt protejate informațiile personale la evenimente sportive mari.`,
    edu_sport_values: `Următorul pas ține de școlile incluse în program și de felul în care astfel de întâlniri pot fi transformate în educație reală, nu doar în evenimente punctuale.`,
    moldova_education: `În perioada următoare contează calendarul programului, numărul profesorilor implicați și efectul pe care pregătirea îl poate avea în școlile cu predare în rusă din Republica Moldova.`,
    business_memo: `După semnarea memorandumului, partea care contează este dacă apar proiecte, întâlniri de afaceri sau oportunități concrete pentru firmele din București și Estonia.`,
    jobs: `Pentru cei care caută un job, pasul practic este verificarea ofertei actualizate pe județ și domeniu. Numărul total arată direcția pieței, dar decizia se ia la nivel de post, salariu, experiență și termen de aplicare.`,
    agri: `Pentru agricultură, următoarea perioadă va arăta cât de mult pot susține fermierii următorul ciclu de cultură prin credite și investiții. Presiunea din ferme se poate vedea mai târziu în producție și prețuri.`,
    fraud_public_money: `Dosarul rămâne important prin prejudiciu și prin felul în care statul verifică plățile din bani publici. Următoarele date relevante sunt măsurile anunțate de anchetatori și recuperarea sumelor.`,
    politics: `În politică, declarația contează numai dacă schimbă o decizie: nume de miniștri, calendar de negocieri, vot sau susținere parlamentară. Următoarea reacție a partidelor va arăta dacă este compromis real sau doar presiune publică.`,
    external: `Pentru România, următoarea etapă este legătura cu deciziile regionale: securitate, UE, NATO, apărare sau costurile războiului. Fără această legătură, subiectul rămâne doar o relatare externă.`
  };
  return `# ${title}\n\n${lead}\n\n## ${h2s[0] || 'Ce se știe acum'}\n\n${section1}\n\n## ${h2s[1] || 'De ce contează'}\n\n${impact}\n\n## Pe scurt\n\n${short || detail}\n\n## ${h2s[2] || 'Ce urmează'}\n\n${endings[kind] || `Următoarea informație de urmărit este ${next}. Articolul trebuie actualizat dacă apar date noi sau reacții oficiale care schimbă efectul pentru cititori.`}`;
}

/* === FIX FINAL REAL: clasificare, brief, SEO, draft, linkuri — fără șabloane generice === */
function rdText(topic) {
  return normalize(`${topic?.title || ''} ${topic?.summary || ''} ${topic?.interest || ''} ${topic?.category || ''} ${(topic?.keywords || []).join(' ')} ${(topic?.entities || []).join(' ')} ${(topic?.sources || []).map((s) => `${s.name || ''} ${s.title || ''} ${s.description || ''} ${s.url || ''}`).join(' ')}`);
}

function rdCleanTitle(topic) {
  return cleanupForArticle(topic?.title || topic?.seoTitle || 'Subiect nou')
    .replace(/^\s*(BREAKING|LIVE VIDEO|VIDEO|INTERVIU|EXCLUSIV)\s*[:|\-–—]?\s*/i, '')
    .replace(/\s*\/\s*/g, '. ')
    .replace(/\s*\|\s*/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rdFixAcronyms(text) {
  return cleanupForArticle(text || '')
    .replace(/\baNOFM\b/g, 'ANOFM')
    .replace(/\banofm\b/gi, 'ANOFM')
    .replace(/\bmae\b/gi, 'MAE')
    .replace(/\bbnr\b/gi, 'BNR')
    .replace(/\banaf\b/gi, 'ANAF')
    .replace(/\brobor\b/gi, 'ROBOR')
    .replace(/\bcsm\b/gi, 'CSM')
    .replace(/\brar\b/gi, 'RAR')
    .replace(/\bue\b/gi, 'UE')
    .replace(/\bnato\b/gi, 'NATO')
    .replace(/\bsua\b/gi, 'SUA')
    .replace(/\bcm\s*2026\b/gi, 'CM 2026')
    .replace(/\beugen\b/g, 'Eugen')
    .replace(/\bliviu\b/g, 'Liviu')
    .replace(/\bmessi\b/g, 'Messi');
}

function detectTopicKind(topic) {
  const text = rdText(topic);
  if (/prescris|prescriere|prescriptie|prescrip[tț]ie|dosarele prescrise|procurorilor|procurori.*judecatori|judecatori.*procurori/.test(text)) return 'legal_prescription';
  if (/atentionare.*calatorie|calatorie.*mae|greva.*franta|franta.*greva|trafic feroviar|transport feroviar|sncf|trenuri.*franta/.test(text)) return 'travel_alert';
  if (/date personale|bresa de securitate|bre[sș]a de securitate|scurgere de date|expuse din greseala|messi.*cm 2026|cm 2026.*date/.test(text)) return 'data_privacy';
  if (/ana maria branza|scrima|scrim[aă]|valori olimpice|sportivi olimpici|olimpici.*scoli|scoli.*olimpici/.test(text)) return 'edu_sport_values';
  if (/taraclia|balti|b[aă]l[tț]i|predare in rusa|predare.*rusa|limba romana.*republicii moldova|republica moldova.*limba romana/.test(text)) return 'moldova_education';
  if (/memorandum.*camera.*comert|camera de comert.*estonie|camera de comert.*bucuresti|industrie.*estonie/.test(text)) return 'business_memo';
  if (/anofm|locuri de munca|joburi|angajari|somaj|piata muncii|ocuparea fortei de munca|candidati|angajatori/.test(text)) return 'jobs';
  if (/agricover|fermieri|fermier|agricol|agricultura|culturi|ciclu de cultura|credite agricole|indatorati/.test(text)) return 'agri';
  if (/jupiter|documente false|cetateni ucraineni|refugiati|gazduieste|prejudiciu|frauda|inselaciune|bani publici/.test(text)) return 'fraud_public_money';
  if (/robor|banca|banci|bnr|consiliul concurentei|concurenta|credit|rate|dobanda|dobanzi|manipulare/.test(text)) return 'banking';
  if (/notar|impozit|contributii|trimis in judecata|evaziune|registrul auto|rar|fals intelectual|carti de identitate/.test(text)) return 'legal_tax';
  if (/alimente|adaos|plafon|pret|preturi|retail|magazine|raft|cosul/.test(text)) return 'food_prices';
  if (/tomac|guvern|premier|ministr|coalitie|parlament|pnl|psd|usr|aur|presedint|nicusor|grindeanu|motiune|alegeri|partidele/.test(text)) return 'politics';
  if (/misha miller|artist|artista|concert|scena|showbiz|vedeta|vedete|festival/.test(text)) return 'entertainment';
  if (/cfr cluj|fcsb|rapid|dinamo|craiova|fotbal|cantonament|transfer|meci|superliga|club|sportiv/.test(text)) return 'sport';
  if (/meteo|anm|cod galben|cod portocaliu|furtuni|ploi|canicula|vreme|vijelie/.test(text)) return 'weather';
  if (/bac|evaluare|educatie|scoala|elev|profesor|examen|admitere|subiecte|barem/.test(text)) return 'education';
  if (/sanatate|spital|medic|pacient|boala|tratament|medicament|cnas|dsp/.test(text)) return 'health';
  if (/injunghiat|crima|omor|violenta|accident|incendiu|politie|victima|suspect|retinut|arest/.test(text)) return 'incident';
  if (/ucraina|rusia|nato|patriot|marea neagra|moldova|sua|iran|bulgaria|ue|bruxelles|razboi|rachete|baloane explozive|aparare/.test(text)) return 'external';
  return 'general';
}

function rdSource(topic, index = 0) {
  const sources = getCleanSources(topic);
  return sources[index] || {};
}

function cleanPublisherName(source) {
  const domain = domainFromUrlClient(source?.url || '').replace(/^www\./, '');
  const raw = cleanupForArticle(source?.name || '').trim();
  if (!raw || raw.length > 32 || raw.split(/\s+/).length > 4 || /http|operatiunea|barbat|femeie|breaking|live video|interviu|atentionare|dosarele|munca|messi|misha/i.test(raw)) {
    return domain || 'sursa citată';
  }
  return raw;
}

function rdDetail(topic) {
  const sources = getCleanSources(topic);
  const title = rdCleanTitle(topic);
  const items = sources.flatMap((s) => [s.description, s.title]).concat([title])
    .map(rdFixAcronyms)
    .filter((x) => x && x.length > 20)
    .filter((x) => !/subiectul trebuie|trebuie explicat|radar|verifica|monitorizat/i.test(x));
  const picked = items.find((x) => normalize(x) !== normalize(title)) || title;
  return shortenForArticle(picked, 380);
}

function rdEntity(topic) {
  const entities = (topic?.entities || []).map((x) => cleanupForArticle(x)).filter((x) => x && x.length > 2 && !/România|Ministerului|Peste|Aten/i.test(x));
  if (entities.length) return entities[0];
  const words = rdCleanTitle(topic).split(/\s+/).filter((w) => w.length > 3).slice(0, 3).join(' ');
  return words || 'subiect';
}

function buildOficiulAngle(topic) {
  const kind = detectTopicKind(topic);
  const map = {
    legal_prescription: 'Mută accentul de pe acuzația aruncată în titlu pe întrebarea reală: cine răspunde când dosarele se prescriu și ce pierd victimele, inculpații și încrederea în justiție.',
    travel_alert: 'Transformă avertizarea MAE într-un material util pentru românii care merg în Franța: ce trenuri pot fi afectate, ce verifică înainte de plecare și ce alternative au.',
    data_privacy: 'Scrie despre protecția datelor, nu despre „victimă” ca într-un caz violent: ce informații personale au fost expuse, cine avea acces și ce măsuri sunt anunțate.',
    edu_sport_values: 'Leagă interviul de educație prin sport: ce primesc elevii din întâlnirile cu olimpicii și de ce lecția despre eșec poate fi mai utilă decât povestea podiumului.',
    moldova_education: 'Pune accent pe limba română în Republica Moldova: de ce vin profesorii în România și ce poate schimba pregătirea lor pentru elevii din Taraclia și Bălți.',
    business_memo: 'Explică ce poate produce memorandumul pentru firme, nu doar ceremonia semnării: domenii vizate, contacte economice și pașii următori.',
    jobs: 'Fă material pentru omul care caută job: unde sunt posturile, ce domenii angajează, ce condiții contează și cum se verifică oferta reală.',
    agri: 'Arată cum datoriile fermierilor se pot vedea în producție, investiții și prețuri, nu doar în cifrele unei companii de finanțare.',
    fraud_public_money: 'Explică mecanismul banilor publici: cum ar fi fost obținute sumele, cine trebuia să verifice documentele și ce se poate recupera.',
    banking: 'Pleacă de la omul cu rată la bancă: ce se anchetează, ce instituție are competență și ce poate însemna pentru încrederea în ROBOR.',
    legal_tax: 'Separă acuzația de verdict și explică prejudiciul, funcția persoanei vizate și stadiul procedurii.',
    food_prices: 'Scrie pentru cumpărători: lista produselor, termenul măsurii, cine controlează magazinele și dacă plafonarea se vede la raft.',
    politics: 'Nu prelua atacul politic; arată ce decizie poate schimba declarația, cine câștigă timp și ce se blochează în negocieri.',
    entertainment: 'Scoate povestea dincolo de declarație: traseul persoanei, momentul local și de ce publicul caută acum acest nume.',
    sport: 'Dă suporterului informația utilă: reunire, cantonament, lot, amicale și ce decizii sportive urmează.',
    weather: 'Concentrează materialul pe hartă, interval și efecte imediate: trafic, locuințe, școli, culturi și evenimente.',
    education: 'Arată concret cine e vizat: elevi, părinți, profesori, calendar, metodologie și document oficial.',
    health: 'Transformă anunțul în informație pentru pacient: acces, costuri, programări, reguli și sursa oficială.',
    incident: 'Pune pe primul loc siguranța și faptele confirmate: ce s-a întâmplat, ce a făcut autoritatea și ce rămâne neclar.',
    external: 'Găsește legătura românească: securitate regională, Ucraina, UE/NATO, Marea Neagră, bani publici sau diaspora.'
  };
  return map[kind] || 'Alege un unghi care adaugă context real față de titlul sursei: cine este afectat, ce se schimbă și ce informație lipsește.';
}

function buildImpactReasonClient(topic) {
  const kind = detectTopicKind(topic);
  const map = {
    legal_prescription: 'Prescripția nu este un detaliu tehnic. Când un dosar se închide prin trecerea timpului, victimele pot rămâne fără răspuns pe fond, iar inculpații nu mai primesc un verdict clar. De aici apare problema de încredere în justiție și întrebarea cine a întârziat procedura.',
    travel_alert: 'Contează pentru românii care sunt sau urmează să plece în Franța: greva poate aduce întârzieri, anulări ori schimbări de traseu. Informația utilă este ce transporturi sunt afectate și unde se verifică actualizările înainte de plecare.',
    data_privacy: 'Contează pentru că datele personale pot fi folosite abuziv chiar și când expunerea pare accidentală. Cititorii au nevoie să știe ce tip de informații au fost vizate și ce măsuri de protecție au fost anunțate.',
    edu_sport_values: 'Contează pentru elevi și profesori pentru că aduce sportul de performanță în școală ca model de disciplină, eșec gestionat și reluare a muncii. Subiectul este despre educație prin exemple reale.',
    moldova_education: 'Contează prin limba română, educație și legătura dintre România și Republica Moldova. Pregătirea profesorilor poate influența felul în care elevii din zone cu predare în rusă învață româna.',
    business_memo: 'Contează pentru firmele care caută parteneriate externe. Un memorandum nu schimbă imediat economia, dar poate deschide întâlniri, proiecte și contacte între mediile de afaceri.',
    jobs: 'Contează pentru cei care caută un loc de muncă și pentru firmele care angajează. Numărul total nu spune totul: județul, domeniul, salariul și experiența cerută decid șansele reale ale candidatului.',
    agri: 'Datoriile fermierilor pot influența investițiile în culturi, producția agricolă și presiunea asupra prețurilor alimentelor. Agricultura finanțată pe credit ajunge să conteze și pentru consumatori.',
    fraud_public_money: 'Contează pentru că implică bani publici destinați sprijinului pentru refugiați și posibile documente false. Cititorii trebuie să înțeleagă mecanismul reclamat, prejudiciul și cine trebuia să verifice plățile.',
    banking: 'Contează pentru românii cu rate și pentru încrederea în sistemul bancar. O anchetă de concurență ridică întrebări despre costul creditelor, regulile pieței și drepturile clienților.',
    legal_tax: 'Contează prin bani publici, documente oficiale și răspunderea unei persoane sau instituții cu atribuții legale. Diferența dintre acuzație și verdict trebuie să fie clară.',
    food_prices: 'Contează pentru bugetul zilnic al familiilor și pentru regulile după care vând magazinele. Cititorii caută lista produselor, termenul măsurii și efectul real la raft.',
    politics: 'Contează dacă declarația schimbă o decizie: majoritate, vot, listă de miniștri sau calendar politic. Cititorul trebuie să înțeleagă efectul asupra guvernării, nu doar conflictul dintre lideri.',
    entertainment: 'Contează prin interesul publicului pentru persoană, carieră și contextul local. Un material bun explică de ce momentul e relevant acum, nu doar reproduce o declarație.',
    sport: 'Contează pentru suporteri prin program, lot, cantonament și pregătirea sezonului. Cititorii vor repere clare: când se reunește echipa, unde merge și ce schimbări apar.',
    weather: 'Contează imediat pentru oamenii din zonele vizate: trafic, locuințe, școli, culturi agricole și evenimente. Informația utilă este intervalul avertizării și recomandarea autorităților.',
    education: 'Contează pentru elevi, părinți și profesori prin termene, proceduri, rezultate sau metodologii. Un text util spune cine este vizat și unde se verifică documentul oficial.',
    health: 'Contează pentru pacienți și familii prin acces, costuri, programări sau reguli medicale. Articolul trebuie să explice procedura concretă și sursa oficială.',
    incident: 'Contează prin siguranța oamenilor și reacția autorităților. Textul trebuie să spună ce este confirmat, ce măsuri s-au luat și ce date nu trebuie tratate ca verdict.',
    external: 'Contează pentru România dacă subiectul schimbă securitatea regională, poziția UE/NATO, sprijinul pentru Ucraina sau riscurile din vecinătate. Legătura cu cititorul trebuie spusă clar.'
  };
  return map[kind] || 'Contează dacă schimbă ceva concret pentru cititori: bani, timp, siguranță, drepturi, servicii publice sau decizii instituționale.';
}

function inferAffectedPeople(topic) {
  const kind = detectTopicKind(topic);
  const map = {
    legal_prescription: 'victimele dosarelor, persoanele acuzate, procurorii, judecătorii și publicul care așteaptă soluții clare în justiție',
    travel_alert: 'românii care călătoresc în Franța, turiștii, navetiștii și cei care folosesc trenurile',
    data_privacy: 'persoanele ale căror date pot fi expuse, fanii și organizatorii evenimentelor sportive mari',
    jobs: 'candidații, angajatorii și agențiile județene pentru ocuparea forței de muncă',
    agri: 'fermierii, firmele din agricultură, furnizorii și consumatorii care depind de producția agricolă',
    business_memo: 'firmele din București, companiile interesate de Estonia și camerele de comerț implicate',
    edu_sport_values: 'elevii, profesorii, școlile și sportivii implicați în proiecte educaționale',
    moldova_education: 'profesorii din Republica Moldova, elevii din școli cu predare în rusă și instituțiile din România implicate',
    banking: 'clienții cu credite, băncile, autoritățile de concurență și piața financiară',
    legal_tax: 'contribuabilii, instituțiile implicate, persoanele vizate de dosar și publicul care urmărește răspunderea legală',
    food_prices: 'cumpărătorii, magazinele, producătorii și instituțiile de control',
    politics: 'partidele, instituțiile care trebuie să ia decizii și cetățenii afectați de blocajul politic',
    sport: 'suporterii, clubul, jucătorii și stafful tehnic',
    weather: 'locuitorii din zonele vizate, șoferii, fermierii și organizatorii de evenimente',
    external: 'România, românii din regiune, instituțiile de securitate și partenerii UE/NATO'
  };
  return map[kind] || 'publicul afectat direct de decizie, instituțiile implicate și cititorii care au nevoie de context practic';
}

function inferNextStep(topic) {
  const kind = detectTopicKind(topic);
  const map = {
    legal_prescription: 'datele CSM, reacția parchetelor și eventualele explicații despre faza în care dosarele s-au prescris',
    travel_alert: 'actualizările MAE și informațiile operatorilor feroviari din Franța',
    data_privacy: 'măsurile organizatorilor, notificările privind datele expuse și reacția autorității de protecție a datelor',
    jobs: 'actualizarea ofertelor pe județe și domenii, plus condițiile cerute de angajatori',
    agri: 'evoluția creditării agricole, costurile de finanțare și pregătirea următorului ciclu de cultură',
    business_memo: 'proiectele sau evenimentele economice anunțate după semnarea memorandumului',
    politics: 'votul, consultările, lista de nume sau documentul politic care transformă declarația în decizie',
    banking: 'deciziile Consiliului Concurenței, poziția BNR și impactul pentru clienții cu rate',
    legal_tax: 'comunicatul Parchetului sau al instanței, stadiul procedurii și eventualele măsuri asigurătorii',
    sport: 'programul oficial al cantonamentului, lotul și meciurile amicale confirmate',
    external: 'reacțiile oficiale, deciziile UE/NATO și efectul asupra securității regionale'
  };
  return map[kind] || 'documentul oficial, reacțiile instituțiilor implicate și datele care schimbă efectul pentru cititori';
}

function buildLead(topic) {
  const kind = detectTopicKind(topic);
  const source = cleanPublisherName(rdSource(topic));
  const detail = rdDetail(topic);
  const map = {
    legal_prescription: `Prescrierea dosarelor penale reaprinde disputa dintre magistrați, după ce judecătorii au respins ideea că instanțele ar fi principala cauză pentru dosarele închise fără verdict. Potrivit ${source}, discuția atinge direct încrederea în justiție și felul în care anchetele ajung, sau nu ajung, la o soluție pe fond.`,
    travel_alert: `Românii care călătoresc cu trenul în Franța pot fi afectați de greva din transportul feroviar, potrivit ${source}. Avertizarea este utilă mai ales pentru cei care au bilete cumpărate, legături între orașe sau drumuri planificate în perioada protestului.`,
    data_privacy: `O breșă de securitate legată de CM 2026 ridică întrebări despre date personale, acces și protecția informațiilor sensibile, potrivit ${source}. Pentru public, partea importantă este ce date au fost expuse și ce măsuri au fost luate după incident.`,
    edu_sport_values: `Ana Maria Brânză vorbește despre întâlnirile foștilor olimpici cu elevii și despre felul în care sportul poate fi folosit ca lecție de disciplină, eșec și reluare a muncii de jos, potrivit ${source}. Subiectul ține de educație prin sport, nu doar de un interviu cu o campioană olimpică.`,
    jobs: `Datele despre locurile de muncă disponibile arată o piață în care candidații trebuie să verifice rapid domeniul, județul și condițiile cerute de angajatori, potrivit ${source}. Pentru cei care caută un job, numărul total de posturi este doar punctul de plecare.`,
    agri: `Datoriile fermierilor români arată presiunea financiară din agricultură, potrivit ${source}. Subiectul contează dincolo de ferme, pentru că finanțarea culturilor poate influența investițiile, producția și prețurile alimentelor.`,
    business_memo: `Un memorandum între camere de comerț poate deschide contacte economice între firme, potrivit ${source}. Partea importantă este ce domenii sunt vizate și dacă documentul se transformă în proiecte concrete pentru companii.`,
    banking: `Discuția despre bănci, ROBOR și regulile de concurență are efect direct pentru oamenii cu credite, potrivit ${source}. Articolul trebuie să explice ce se anchetează și ce poate însemna pentru rate și încrederea în piața bancară.`,
    legal_tax: `Un dosar cu posibil prejudiciu sau documente false trebuie explicat prin faptele comunicate oficial și stadiul procedurii, potrivit ${source}. Pentru cititori contează diferența dintre acuzații, anchetă și verdict.`,
    politics: `Declarațiile politice pot schimba negocieri, liste de miniștri sau calendare de vot, potrivit ${source}. Partea importantă pentru cititori este dacă anunțul produce o decizie reală sau rămâne doar presiune publică.`,
    food_prices: `Deciziile privind plafonarea adaosului comercial la alimente contează pentru cumpărători și magazine, potrivit ${source}. Informația utilă este ce produse sunt vizate, până când se aplică măsura și ce efect se vede la raft.`,
    sport: `Programul unei echipe înaintea noului sezon contează pentru suporteri prin reunire, cantonament, lot și meciuri amicale, potrivit ${source}. Materialul trebuie să scoată datele utile, nu doar să repete anunțul clubului.`,
    external: `Subiectul extern are relevanță pentru România atunci când atinge securitatea regională, deciziile UE/NATO, vecinătatea estică sau costurile războiului, potrivit ${source}. Legătura românească trebuie explicată clar.`,
    entertainment: `Subiectul de entertainment trebuie scris prin povestea persoanei, traseu, context local și interesul publicului, potrivit ${source}. Nu este suficientă reluarea unei declarații; contează de ce momentul atrage atenția acum.`
  };
  return map[kind] || `${detail}, potrivit ${source}. Informația merită explicată prin efectul concret pentru cititori și prin datele confirmate din sursa citată.`;
}

function buildSeoTitleIdeas(topic) {
  const kind = detectTopicKind(topic);
  const entity = rdEntity(topic);
  const sets = {
    legal_prescription: [
      'Dosarele prescrise reaprind conflictul dintre judecători și procurori. Ce spun magistrații',
      'Cine răspunde când dosarele se prescriu. Replica judecătorilor pentru procurori',
      'Prescripția dosarelor penale și disputa din justiție. De ce contează pentru oameni',
      'Judecătorii resping vina pentru dosarele prescrise. Unde se blochează anchetele',
      'Peste 3.500 de judecători cer clarificări despre dosarele prescrise',
      'Dosare închise fără verdict. De ce prescripția pune presiune pe justiție'
    ],
    travel_alert: [
      'Românii care merg cu trenul în Franța pot fi afectați de grevă. Avertizarea MAE pentru călători',
      'Grevă în transportul feroviar din Franța. Ce trebuie să verifice românii înainte de plecare',
      'Atenționare MAE pentru Franța: trenuri afectate și posibile întârzieri pentru călători',
      'Călătorii în Franța, afectați de greva feroviară. Recomandările pentru români',
      'Trafic feroviar perturbat în Franța. Ce riscă românii care au drumuri programate',
      'Franța, sub avertizare de călătorie pentru grevă. Unde verifică românii trenurile'
    ],
    data_privacy: [
      'Date personale expuse înainte de CM 2026. Ce arată cazul Messi despre securitatea informațiilor',
      'Messi și breșa de securitate de la CM 2026. Ce date au fost expuse din greșeală',
      'Breșă de securitate înainte de Cupa Mondială. De ce contează protecția datelor fanilor',
      'Cazul Messi ridică problema datelor personale la evenimente sportive mari',
      'Ce se știe despre datele expuse înainte de CM 2026 și cine trebuie să răspundă',
      'Securitatea digitală la CM 2026: lecția din cazul datelor personale expuse'
    ],
    edu_sport_values: [
      'Ana Maria Brânză duce valorile olimpice în școli. Ce mesaj primesc elevii',
      'Foști olimpici în fața elevilor. Lecția despre muncă, eșec și reluarea de la capăt',
      'Sportul ca lecție pentru școală: ce le spune Ana Maria Brânză elevilor',
      'Valorile olimpice ajung în școli prin foști sportivi. De ce contează pentru elevi',
      'Ana Maria Brânză, despre ce învață copiii din sportul de performanță',
      'De la podium la clasă: mesajul foștilor olimpici pentru elevi'
    ],
    moldova_education: [
      'Profesori din școli cu predare în rusă vin în România pentru limba română',
      'Limba română în școlile din Taraclia și Bălți. Programul care aduce profesori în România',
      'România pregătește profesori din Republica Moldova pentru predarea limbii române',
      'Profesori din Republica Moldova, la perfecționare în România. Cine sunt elevii vizați',
      'Predarea limbii române în școli cu predare în rusă. Ce schimbă programul',
      'Educație și limbă română peste Prut. De ce vin profesorii în România'
    ],
    business_memo: [
      'București și Estonia, legătură prin camerele de comerț. Ce poate aduce memorandumul',
      'Memorandum între Camera de Comerț București și Estonia. Ce oportunități apar pentru firme',
      'Firmele din București pot avea o nouă punte spre Estonia după acordul camerelor de comerț',
      'Colaborare economică București–Estonia. Ce înseamnă documentul semnat',
      'Un memorandum economic deschide discuții între București și Estonia',
      'Camera de Comerț București și partenerii din Estonia: ce urmează pentru afaceri'
    ],
    jobs: [
      'Aproape 34.000 de locuri de muncă în România. Ce verifică cei care caută un job',
      'Locuri de muncă prin ANOFM. Unde trebuie să caute românii care vor să se angajeze',
      'Piața muncii se strânge pentru candidați. Ce arată datele despre joburile disponibile',
      'Joburi disponibile în România: județul și domeniul pot conta mai mult decât numărul total',
      'Ce trebuie să știe candidații înainte să aplice la ofertele ANOFM',
      'Mai puține locuri de muncă și concurență mai mare. Cum se vede piața pentru candidați'
    ],
    agri: [
      'Fermierii români și presiunea datoriilor. Ce arată datele Agricover despre creditele agricole',
      'Cât de îndatorați sunt fermierii români și de ce contează pentru prețurile alimentelor',
      'Creditele fermierilor, între ciclul de cultură și investițiile pe termen mediu',
      'Agricultura românească depinde tot mai mult de finanțare. Ce spune Agricover despre datorii',
      'Datoriile din agricultură și riscul pentru următorul ciclu de cultură',
      'De ce creditele fermierilor pot ajunge să conteze și pentru consumatori'
    ],
    fraud_public_money: [
      'Bani pentru refugiați ucraineni, obținuți cu documente false. Ce anchetează procurorii',
      'Caz Jupiter în Maramureș: plăți pentru găzduirea refugiaților, sub lupa anchetatorilor',
      'Documente false pentru bani publici. Cum este descris dosarul privind refugiații ucraineni',
      'Anchetă penală după plăți pentru refugiați ucraineni. Ce prejudiciu este verificat',
      'Sprijinul pentru refugiați și controalele statului. Ce arată cazul din Maramureș',
      'Dosar cu bani publici și refugiați ucraineni. Ce trebuie urmărit în anchetă'
    ],
    banking: [
      'ROBOR, bănci și concurență. Ce trebuie să știe românii cu rate',
      'Ancheta privind băncile și ROBOR: unde este problema pentru clienți',
      'Ratele românilor și regulile de concurență. Ce se discută în cazul băncilor',
      'Ce pot afla clienții după acuzațiile legate de manipularea ROBOR',
      'Consiliul Concurenței și băncile. De ce contează dosarul pentru credite',
      'Costul creditelor și încrederea în piața bancară: ce întrebări ridică ancheta'
    ],
    legal_tax: [
      'Dosar cu documente false sau prejudiciu. Ce spun anchetatorii și ce nu este verdict',
      'Fals intelectual sau impozite neplătite. Ce trebuie înțeles din acuzații',
      'Cazul care pune presiune pe controalele instituțiilor. Ce documente sunt vizate',
      'Prejudiciu și răspundere legală. De ce contează dosarul pentru contribuabili',
      'Anchetă cu efect public: acuzațiile, instituția vizată și prezumția de nevinovăție',
      'Ce urmează într-un dosar cu prejudiciu și documente oficiale contestate'
    ],
    politics: [
      `${entity} și negocierile politice. Ce se poate schimba după noul anunț`,
      'Schimbare de poziție în negocieri. Cine câștigă timp și cine pierde teren',
      'Numele de miniștri, între presiune politică și compromis. Ce urmează pentru partide',
      `De ce declarația lui ${entity} poate schimba calculele pentru viitorul Guvern`,
      `Negocierile pentru putere intră într-o nouă etapă. Ce semnal transmite ${entity}`,
      'Partidele caută nume acceptate de toți. Ce arată disputa din jurul miniștrilor'
    ],
    external: [
      'Războiul din Ucraina și costul deciziilor militare. Ce contează pentru România',
      'Apărarea Ucrainei se schimbă prin soluții ieftine. De ce urmărește România subiectul',
      'Decizii militare în regiune. Ce legătură au cu securitatea României',
      'Ucraina, Rusia și presiunea pe apărarea aeriană. Ce trebuie urmărit la granița estică',
      'Soluții de război cu cost mic și efect regional. De ce contează pentru flancul estic',
      'Cum schimbă războiul calculele de securitate din vecinătatea României'
    ],
    entertainment: [
      `${entity}, dincolo de scenă. De ce a atras atenția povestea artistei`,
      `Cum a ajuns ${entity} în fața publicului și ce spune despre drumul ei`,
      `Povestea ${entity}: scena, publicul și declarația care a atras atenția`,
      `${entity} și momentul care a făcut publicul să caute mai multe detalii`,
      `De la declarație la carieră: ce arată apariția lui ${entity}`,
      `${entity}, între scenă și poveste personală. Ce se știe acum`
    ]
  };
  const fallback = [
    `${rdCleanTitle(topic)}. Ce se știe acum și cine este afectat`,
    `Ce schimbă informația despre ${entity} pentru public`,
    `Datele noi din surse și efectul concret pentru cititori`,
    `Contextul care lipsește din primele relatări despre ${entity}`,
    `Cine este vizat de subiect și ce document trebuie urmărit`,
    `De ce informația despre ${entity} nu trebuie tratată ca simplă preluare`
  ];
  return Array.from(new Set((sets[kind] || fallback).map((x) => shortenTitleForSeo(rdFixAcronyms(x)).trim()).filter(Boolean))).slice(0, 6);
}

function buildSeoH2Recommendations(topic) {
  const kind = detectTopicKind(topic);
  const sets = {
    legal_prescription: ['Dosarele prescrise și disputa dintre judecători și procurori', 'De ce prescripția contează pentru victime, inculpați și încrederea în justiție', 'Unde se poate bloca un dosar penal înainte de verdict', 'Ce reacții pot veni de la CSM și parchete', 'Datele care pot clarifica răspunderea în sistemul judiciar'],
    travel_alert: ['Grevă în transportul feroviar din Franța: ce anunță MAE', 'Ce trebuie să verifice românii înainte de călătorie', 'Trenuri, întârzieri și alternative pentru călători', 'Unde apar actualizările oficiale despre traficul feroviar', 'Cum pot fi afectați turiștii și românii din Franța'],
    data_privacy: ['Ce date personale au fost expuse înainte de CM 2026', 'De ce breșa de securitate contează pentru fani și organizatori', 'Ce măsuri trebuie explicate după expunerea datelor', 'Cum ajung informațiile sensibile să devină risc public', 'Ce trebuie urmărit până la Campionatul Mondial'],
    edu_sport_values: ['Ana Maria Brânză și valorile olimpice duse în școli', 'Ce le spun foștii sportivi olimpici elevilor', 'De ce sportul poate fi lecție despre muncă și eșec', 'Cum pot folosi școlile exemplele din performanță', 'Ce urmează pentru proiectele educaționale prin sport'],
    moldova_education: ['Profesori din Taraclia și Bălți vin în România pentru limba română', 'De ce contează predarea limbii române în școli cu predare în rusă', 'Legătura dintre educație, Republica Moldova și România', 'Cine organizează programul de perfecționare', 'Ce efect poate avea pregătirea profesorilor asupra elevilor'],
    business_memo: ['Memorandum București–Estonia între camerele de comerț', 'Ce oportunități poate deschide documentul pentru firme', 'Domeniile în care pot apărea proiecte comune', 'De ce contează Estonia pentru mediul de afaceri din București', 'Pașii următori după semnarea memorandumului'],
    jobs: ['Locuri de muncă disponibile prin ANOFM: ce arată oferta națională', 'Unde trebuie să caute cei care vor să se angajeze acum', 'Ce domenii pot avea nevoie de oameni și ce verifică un candidat', 'De ce numărul posturilor libere diferă de la un județ la altul', 'Ce pași trebuie făcuți înainte de aplicare'],
    agri: ['Datoriile fermierilor români și presiunea pe următorul ciclu agricol', 'Credite pe termen mediu și finanțarea culturilor: ce spune Agricover', 'De ce costul finanțării poate influența producția agricolă', 'Cum se poate vedea presiunea din ferme în prețurile alimentelor', 'Ce urmăresc fermierii înainte de următoarea campanie agricolă'],
    fraud_public_money: ['Bani publici pentru refugiați și documentele false reclamate de anchetatori', 'Cum ar fi fost obținute sumele și cine trebuia să verifice actele', 'Ce prejudiciu este indicat și ce măsuri pot urma', 'De ce cazul contează pentru programele de sprijin', 'Prezumția de nevinovăție și limitele informațiilor publice'],
    banking: ['Ancheta privind ROBOR și băncile: ce se discută public', 'Ce poate însemna cazul pentru clienții cu rate', 'Rolul Consiliului Concurenței și limitele BNR', 'Ce documente pot schimba situația', 'De ce încrederea în piața bancară contează pentru credite'],
    legal_tax: ['Acuzațiile și stadiul dosarului comunicat public', 'Prejudiciul indicat și documentele aflate în discuție', 'Ce înseamnă trimiterea în judecată sau ancheta penală', 'Cum se aplică prezumția de nevinovăție în articol', 'Ce reacții pot veni de la instituția vizată'],
    food_prices: ['Alimentele cu adaos comercial plafonat: ce se schimbă pentru cumpărători', 'Lista produselor vizate și termenul până la care se aplică măsura', 'Cum se vede plafonarea la raft și în bugetul familiei', 'Cine controlează magazinele și ce riscă retailerii', 'Ce efect poate avea decizia asupra prețurilor'],
    politics: ['Declarația care poate schimba negocierile politice', 'Cine câștigă timp și cine pierde presiune', 'Numele de miniștri și compromisul dintre partide', 'Calendarul deciziei politice care trebuie urmărit', 'Ce efect poate avea disputa asupra viitorului Guvern'],
    sport: ['Programul de pregătire și cantonamentul echipei', 'Ce jucători sunt așteptați la reunire', 'Meciurile amicale și datele care trebuie confirmate', 'De ce pregătirea contează pentru suporteri', 'Ce poate urma pe piața transferurilor'],
    external: ['Ce schimbă subiectul pentru securitatea din vecinătatea României', 'Legătura cu Ucraina, Rusia și deciziile de apărare', 'De ce soluțiile militare ieftine pot conta în războiul de uzură', 'Cum poate afecta subiectul flancul estic al NATO', 'Reacțiile oficiale care trebuie urmărite']
  };
  const fallback = [`${rdCleanTitle(topic)}: informația nouă`, `Cine este afectat concret de subiect`, `Contextul care schimbă lectura știrii`, `Ce reacție poate schimba articolul`, `Ce trebuie urmărit în perioada următoare`];
  return Array.from(new Set((sets[kind] || fallback).map((x) => rdFixAcronyms(x).replace(/\s+/g, ' ').trim()).filter(Boolean))).slice(0, 5);
}

function buildCategoryForKind(topic) {
  const kind = detectTopicKind(topic);
  const map = { jobs:'Business', agri:'Business', food_prices:'Business', banking:'Business', business_memo:'Business', travel_alert:'Călătorii', sport:'Sport', education:'Actualitate', edu_sport_values:'Actualitate', moldova_education:'Actualitate', health:'Health & Fitness', politics:'Politică', external:'Extern', data_privacy:'Tehnologie', entertainment:'Entertainment & Showbiz', weather:'Actualitate', incident:'Actualitate', legal_tax:'Actualitate', fraud_public_money:'Actualitate', legal_prescription:'Actualitate' };
  return map[kind] || (topic.wpCategory || topic.category || 'Actualitate');
}

function buildSecondaryCategories(topic) {
  const kind = detectTopicKind(topic);
  const map = { legal_prescription:['Justiție', 'News'], legal_tax:['Justiție', 'News'], fraud_public_money:['Justiție', 'Actualitate'], jobs:['Economie', 'Utilitare'], agri:['Economie', 'Agricultură'], food_prices:['Economie', 'Utilitare'], banking:['Economie', 'Bani'], travel_alert:['Travel', 'Utilitare'], data_privacy:['Tehnologie', 'Sport'], edu_sport_values:['Educație', 'Sport'], moldova_education:['Educație', 'Republica Moldova'], external:['Extern', 'Lumea de lângă noi'], politics:['Actualitate', 'News'] };
  return map[kind] || ['News'];
}

function buildFocusKeyword(topic) {
  const title = buildSeoTitleIdeas(topic)[0] || rdCleanTitle(topic);
  const stop = new Set(['si','sau','cu','de','la','in','pe','pentru','din','un','o','ce','cum','este','sunt','despre','mai','video','foto','live','interviu','care','prin','pana','dupa','nou','noua']);
  const words = normalize(title).split(/\s+/).filter((w) => w.length > 2 && !stop.has(w)).slice(0, 4);
  return removeDiacritics(words.join(' ')).toLowerCase() || 'subiect actualitate';
}

function buildTags(topic) {
  const kind = detectTopicKind(topic);
  const theme = { legal_prescription:'Justiție', legal_tax:'Justiție', fraud_public_money:'Bani publici', jobs:'Locuri de muncă', agri:'Agricultură', food_prices:'Prețuri alimente', banking:'Bănci', travel_alert:'Atenționare călătorie', data_privacy:'Date personale', edu_sport_values:'Educație prin sport', moldova_education:'Republica Moldova', business_memo:'Business', politics:'Politică', sport:'Sport', external:'Externe' }[kind] || (topic.interest || 'Actualitate');
  const tags = [buildFocusKeyword(topic).split(' ').slice(0, 3).join(' ')];
  (topic.entities || []).map((x) => cleanupForArticle(x)).filter((x) => x && x.split(/\s+/).length <= 3 && !/Peste|Ministerului|Aten/i.test(x)).slice(0, 2).forEach((x) => tags.push(x));
  tags.push(theme);
  return Array.from(new Set(tags.filter(Boolean))).slice(0, 4);
}

function buildMetaClient(topic, focusKeyword) {
  const kind = detectTopicKind(topic);
  const map = {
    legal_prescription: 'Dosarele prescrise si disputa dintre judecatori si procurori. De ce prescriptia conteaza pentru increderea in justitie.',
    travel_alert: 'Romanii care merg in Franta pot fi afectati de greva feroviara. Ce trebuie verificat inainte de calatorie.',
    data_privacy: 'Ce date personale au fost expuse in bresa de securitate si de ce conteaza protectia informatiilor inainte de CM 2026.',
    jobs: 'Locuri de munca disponibile in Romania. Ce trebuie sa verifice cei care cauta un job prin ANOFM.',
    agri: 'Datoriile fermierilor romani si creditele agricole pot influenta investitiile, culturile si preturile alimentelor.',
    business_memo: 'Camera de Comert Bucuresti si Estonia au semnat un memorandum. Ce oportunitati poate deschide pentru firme.',
    fraud_public_money: 'Dosar cu bani publici si documente false pentru gazduirea refugiatilor ucraineni. Ce ancheteaza procurorii.',
    banking: 'Ancheta privind bancile si ROBOR conteaza pentru romanii cu rate. Ce institutii trebuie urmarite.',
    food_prices: 'Adaos comercial plafonat la alimente. Ce produse, ce termen si ce efect poate avea decizia la raft.',
    politics: 'Negocierile politice pot schimba guvernarea si lista de ministri. Ce decizie trebuie urmarita.',
    external: 'Subiect extern cu efect pentru Romania, UE si NATO. Ce legatura are cu securitatea regionala.'
  };
  return removeDiacritics((map[kind] || `Afla ce se stie despre ${focusKeyword}, cine este vizat si ce efect concret are subiectul.`).slice(0, 158));
}

function buildPhoneQuestions(topic) {
  const kind = detectTopicKind(topic);
  const q = {
    legal_prescription: ['În ce fază procedurală s-au prescris cele mai multe dosare invocate?', 'Există date publice care arată cât timp au stat dosarele în urmărire penală și cât timp în instanță?', 'Ce instituție poate confirma cifra și metodologia folosită?', 'Ce reacție există din partea parchetelor sau a CSM?', 'Ce măsuri sunt discutate pentru a evita prescripțiile în dosarele similare?'],
    travel_alert: ['Care este intervalul grevei și ce linii feroviare din Franța pot fi afectate?', 'Unde verifică românii actualizările înainte de plecare?', 'Ce recomandări are MAE pentru cei care pierd legături de transport?', 'Atenționarea se poate actualiza sau prelungi?', 'Există contacte consulare utile pentru românii aflați deja în Franța?'],
    data_privacy: ['Ce tip de date personale au fost expuse?', 'Cine a avut responsabilitatea tehnică pentru sistemul afectat?', 'Persoanele vizate au fost notificate?', 'Ce măsuri au fost luate pentru limitarea riscului?', 'Autoritatea de protecție a datelor a fost sesizată?'],
    jobs: ['Câte locuri de muncă sunt disponibile și care sunt județele cu cele mai multe oferte?', 'Care sunt domeniile cu cele mai multe posturi?', 'Ce calificări se cer cel mai des?', 'Cât de des se actualizează oferta?', 'Unde verifică oficial candidatul postul înainte de aplicare?'],
    business_memo: ['Ce document a fost semnat și cine sunt semnatarii?', 'Ce domenii economice sunt vizate?', 'Există proiecte sau evenimente programate după semnare?', 'Cum pot firmele interesate să intre în contact cu partea estoniană?', 'Există un comunicat sau document public care poate fi citat?'],
    agri: ['Ce înseamnă împărțirea datoriilor între termen mediu și termen scurt?', 'Ce categorii de ferme sunt cele mai expuse?', 'Cum poate influența creditarea următorul ciclu de cultură?', 'Există date despre restanțe sau restructurări?', 'Ce ar trebui să urmărească fermierii înainte de campania următoare?'],
    banking: ['Care este stadiul procedurii?', 'Ce instituții sau companii sunt vizate public?', 'Ce poate însemna cazul pentru clienții cu rate?', 'Ce rol are Consiliul Concurenței și ce rol are BNR?', 'Ce document public poate fi citat acum?'],
    politics: ['Este vorba despre decizie sau declarație politică?', 'Ce pas concret urmează: vot, consultare, listă de miniștri sau document?', 'Cine câștigă timp și cine pierde spațiu de negociere?', 'Ce efect are pentru calendarul guvernării?', 'Ce reacție oficială poate confirma schimbarea?']
  };
  return q[kind] || ['Ce informație nouă poate fi confirmată oficial?', 'Cine este vizat direct?', 'Ce document public poate fi citat?', 'Ce efect concret are pentru cititori?', 'Ce reacție sau actualizare poate schimba articolul?'];
}

function showBrief(topic) {
  const titleIdea = buildSeoTitleIdeas(topic)[0] || rdCleanTitle(topic);
  const h2s = buildSeoH2Recommendations(topic).slice(0, 4);
  const focusKeyword = buildFocusKeyword(topic);
  el.dialogTitle.textContent = 'Brief + reguli șef';
  el.dialogBody.innerHTML = `
    <h3>${escapeHtml(rdCleanTitle(topic))}</h3>
    <div class="editorial-box"><p><strong>Unghi editorial:</strong> ${escapeHtml(buildOficiulAngle(topic))}</p></div>
    <h3>Rezumat rapid</h3>
    <ul>
      <li><strong>Ce s-a întâmplat:</strong> ${escapeHtml(rdDetail(topic))}</li>
      <li><strong>De ce contează:</strong> ${escapeHtml(buildImpactReasonClient(topic))}</li>
      <li><strong>Cine este afectat:</strong> ${escapeHtml(inferAffectedPeople(topic))}</li>
      <li><strong>Ce urmărești mai departe:</strong> ${escapeHtml(inferNextStep(topic))}</li>
    </ul>
    <h3>Structură recomandată</h3>
    <ol>
      <li><strong>Titlu:</strong> ${escapeHtml(titleIdea)}</li>
      <li><strong>Șapou:</strong> ${escapeHtml(buildLead(topic))}</li>
      ${h2s.map((h) => `<li><strong>H2:</strong> ${escapeHtml(h)}</li>`).join('')}
    </ol>
    <h3>SEO rapid</h3>
    <p><strong>Focus keyword:</strong> ${escapeHtml(focusKeyword)}</p>
    <p><strong>Meta description:</strong> ${escapeHtml(buildMetaClient(topic, focusKeyword))}</p>
    <p><strong>Categorie:</strong> ${escapeHtml(buildCategoryForKind(topic))}</p>
    <p><strong>Taguri:</strong> ${escapeHtml(buildTags(topic).join(', '))}</p>
    <h3>Surse externe detectate</h3>
    <ul>${getCleanSources(topic).slice(0, 4).map((s) => `<li><a href="${escapeAttr(s.url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(cleanPublisherName(s))}${escapeHtml(formatAuthor(s))}</a></li>`).join('') || '<li>Nu există surse externe disponibile în card.</li>'}</ul>
    <h3>Întrebări utile pentru telefon</h3>
    <ol>${buildPhoneQuestions(topic).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>
  `;
  openDialog();
}

function showTitles(topic) {
  const focusKeyword = buildFocusKeyword(topic);
  const titles = buildSeoTitleIdeas(topic);
  el.dialogTitle.textContent = 'SEO complet';
  el.dialogBody.innerHTML = `
    <h3>Titluri propuse</h3>
    <ol>${titles.map((title) => `<li>${escapeHtml(title)}</li>`).join('')}</ol>
    <h3>Pachet SEO</h3>
    <p><strong>Focus keyword:</strong> ${escapeHtml(focusKeyword)}</p>
    <p><strong>SEO title fără diacritice:</strong> ${escapeHtml(removeDiacritics(titles[0] || rdCleanTitle(topic)))}</p>
    <p><strong>Slug:</strong> ${escapeHtml(slugify(titles[0] || rdCleanTitle(topic)))}</p>
    <p><strong>Meta description:</strong> ${escapeHtml(buildMetaClient(topic, focusKeyword))}</p>
    <p><strong>Excerpt:</strong> ${escapeHtml(buildLead(topic))}</p>
    <p><strong>Categorie principală:</strong> ${escapeHtml(buildCategoryForKind(topic))}</p>
    <p><strong>Categorii secundare:</strong> ${escapeHtml(buildSecondaryCategories(topic).join(', '))}</p>
    <p><strong>Taguri max 4:</strong> ${escapeHtml(buildTags(topic).join(', '))}</p>
    <h3>H2/H3 recomandate</h3>
    <ul>${buildSeoH2Recommendations(topic).map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>
  `;
  openDialog();
}

function rdArticleSection(topic) {
  const sources = getCleanSources(topic).slice(0, 2);
  const first = sources[0] || {};
  const second = sources[1] || null;
  const sourceName = cleanPublisherName(first);
  const link = first.url ? `[${sourceName}](${first.url})` : sourceName;
  const detail = rdDetail(topic);
  let out = `Potrivit ${link}, ${rdFixAcronyms(detail)}.`;
  if (second && second.url) {
    const s2 = cleanPublisherName(second);
    const detail2 = rdFixAcronyms(cleanupForArticle(second.description || second.title || ''));
    if (detail2 && normalize(detail2) !== normalize(detail)) out += ` Informația apare și în [${s2}](${second.url}), care notează că ${lowercaseFirstForArticle(shortenForArticle(detail2, 240))}.`;
  }
  return out;
}

function rdShort(topic) {
  const kind = detectTopicKind(topic);
  const detail = rdFixAcronyms(rdDetail(topic));
  const source = cleanPublisherName(rdSource(topic));
  const map = {
    legal_prescription: `${detail}. Disputa contează pentru felul în care sistemul judiciar explică dosarele închise fără verdict și întârzierile care duc la prescripție.`,
    travel_alert: `${detail}. Românii care au drumuri în Franța trebuie să verifice trenurile și eventualele modificări de program.`,
    jobs: `${detail}. Pentru candidați contează județul, domeniul, salariul și valabilitatea postului, nu doar numărul total anunțat.`,
    data_privacy: `${detail}. Cazul arată de ce protecția datelor personale rămâne importantă la evenimente sportive mari.`,
    agri: `${detail}. Presiunea datoriilor poate influența investițiile în culturi și costurile care ajung indirect la consumatori.`
  };
  return map[kind] || `${detail}. Informația este atribuită ${source} și trebuie explicată prin efectul concret asupra publicului.`;
}

function rdEnding(topic) {
  const kind = detectTopicKind(topic);
  const map = {
    legal_prescription: 'Disputa poate continua prin reacții ale CSM, ale parchetelor sau ale asociațiilor de magistrați. Partea importantă este dacă apar date clare despre câte dosare s-au prescris, în ce fază au stat cel mai mult și ce instituții au avut întârzieri.',
    travel_alert: 'Pentru cei care au drumuri programate, următoarea informație importantă este actualizarea transmisă de MAE sau de operatorii feroviari. În astfel de cazuri, diferența practică este între o călătorie verificată înainte și o legătură pierdută pe traseu.',
    data_privacy: 'Următorul element important este reacția organizatorilor și măsurile de protecție anunțate după expunerea datelor. Cazul rămâne relevant atât timp cât arată cum sunt protejate informațiile personale la evenimente mari.',
    jobs: 'Pentru cei care caută un job, pasul practic este verificarea ofertei actualizate pe județ și domeniu. Numărul total arată direcția pieței, dar decizia se ia la nivel de post, salariu, experiență și termen de aplicare.',
    agri: 'Pentru agricultură, următoarea perioadă va arăta cât de mult pot susține fermierii următorul ciclu de cultură prin credite și investiții. Presiunea din ferme se poate vedea mai târziu în producție și prețuri.',
    politics: 'În politică, declarația contează numai dacă schimbă o decizie: nume de miniștri, calendar de negocieri, vot sau susținere parlamentară. Următoarea reacție a partidelor va arăta dacă este compromis real sau doar presiune publică.',
    business_memo: 'După semnarea memorandumului, partea care contează este dacă apar proiecte, întâlniri de afaceri sau oportunități concrete pentru firmele din București și Estonia.'
  };
  return map[kind] || `Următoarea informație importantă este ${inferNextStep(topic)}. Articolul poate fi completat dacă apare o reacție oficială sau un document care schimbă efectul pentru cititori.`;
}

function buildPublishableDraftTitle(topic) {
  return buildSeoTitleIdeas(topic)[0] || rdCleanTitle(topic);
}

function buildLocalCopyPasteDraft(topic) {
  const title = buildPublishableDraftTitle(topic);
  const lead = buildLead(topic);
  const h2s = buildSeoH2Recommendations(topic);
  return `# ${title}\n\n${lead}\n\n## ${h2s[0] || 'Ce se știe acum'}\n\n${rdArticleSection(topic)}\n\n## ${h2s[1] || 'De ce contează'}\n\n${buildImpactReasonClient(topic)}\n\n## Pe scurt\n\n${rdShort(topic)}\n\n## ${h2s[2] || 'Ce urmează'}\n\n${rdEnding(topic)}`;
}

function showCopyPasteDraft(topic) {
  el.dialogTitle.textContent = 'Draft local';
  try {
    const draft = buildLocalCopyPasteDraft(topic);
    el.dialogBody.innerHTML = `
      <textarea class="copybox" rows="24">${escapeHtml(draft)}</textarea>
      <button class="btn btn-primary" type="button" onclick="navigator.clipboard.writeText(this.closest('.dialog-body').querySelector('textarea').value)">Copiază draftul</button>
    `;
  } catch (error) {
    console.error('Draft local error', error, topic);
    el.dialogBody.innerHTML = `<p><strong>Draftul nu s-a putut genera.</strong> ${escapeHtml(error.message || String(error))}</p>`;
  }
  openDialog();
}

function showLinksAndImages(topic) {
  const sources = getCleanSources(topic).slice(0, 6);
  el.dialogTitle.textContent = 'Linkuri + surse';
  el.dialogBody.innerHTML = `
    <h3>Linkuri externe detectate</h3>
    <ol>${sources.map((s) => `<li><a href="${escapeAttr(s.url || '#')}" target="_blank" rel="noopener noreferrer">informațiile publicate de ${escapeHtml(cleanPublisherName(s))}</a>${s.url ? ` — ${escapeHtml(s.url)}` : ''}</li>`).join('') || '<li>Nu există linkuri externe în card.</li>'}</ol>
    <h3>Surse oficiale potrivite pentru verificare</h3>
    <ul>${rdOfficialSourcesForLinks(topic).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
  `;
  openDialog();
}

function rdOfficialSourcesForLinks(topic) {
  const kind = detectTopicKind(topic);
  const map = {
    legal_prescription: ['CSM / asociații de magistrați pentru poziția judecătorilor', 'Ministerul Public sau Parchetul General pentru reacția parchetelor', 'documentul sau comunicatul citat în sursa inițială'],
    travel_alert: ['MAE – atenționări de călătorie', 'operatorii feroviari din Franța / SNCF', 'pagina companiei de transport folosite de cititor'],
    data_privacy: ['organizatorul evenimentului sau instituția care gestionează datele', 'autoritatea de protecție a datelor', 'comunicatul oficial despre breșă'],
    jobs: ['ANOFM și agențiile județene pentru ocuparea forței de muncă', 'lista oficială a posturilor disponibile', 'angajatorii care publică ofertele'],
    business_memo: ['Camera de Comerț și Industrie a Municipiului București', 'Camera de Comerț și Industrie a Estoniei', 'comunicatul oficial al instituțiilor semnatare'],
    agri: ['Agricover / sursa declarației', 'Ministerul Agriculturii pentru programe și politici publice', 'date publice despre creditare agricolă'],
    banking: ['Consiliul Concurenței', 'BNR pentru context financiar', 'documentele publice ale procedurii'],
    politics: ['comunicatul instituției sau partidului implicat', 'agenda oficială a consultărilor sau votului', 'declarația integrală, nu doar fragmentul citat']
  };
  return map[kind] || ['sursa inițială a informației', 'instituția care poate confirma oficial datele', 'documentul public sau comunicatul citat'];
}
