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
    if (button.dataset.action === 'brief') showBrief(topic);
    if (button.dataset.action === 'titles') showTitles(topic);
    if (button.dataset.action === 'contacts') showContactsAndDrafts(topic);
    if (button.dataset.action === 'draft') {
      try {
        showCopyPasteDraft(topic);
      } catch (error) {
        console.error('Eroare draft local', error);
        el.dialogTitle.textContent = 'Draft local';
        el.dialogBody.innerHTML = `<p class="error"><strong>Draftul nu s-a putut genera.</strong> ${escapeHtml(error.message || 'Eroare necunoscută')}</p>`;
        openDialog();
      }
    }
    if (button.dataset.action === 'links') showLinksAndImages(topic);
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
        <div class="data-cell"><span>Indice Google Trends</span><strong>${escapeHtml(topic.trendsIndexLabel || 'n/a')}</strong></div>
        <div class="data-cell"><span>Volum estimat căutări</span><strong>${escapeHtml(topic.estimatedVolume || '—')}</strong></div>
        <div class="data-cell"><span>Vechime subiect</span><strong>${formatMinutes(topic.startedMinutesAgo)}</strong></div>
        <div class="data-cell"><span>Surse detectate de radar</span><strong>${topic.sourceCount || (topic.sources || []).length}</strong></div>
        <div class="data-cell"><span>Articole în interval</span><strong>${getOnlineCount(topic)}</strong></div>
        
        <div class="data-cell"><span>Risc editorial</span><strong>${escapeHtml(topic.risk || 'mediu')}</strong></div>
        <div class="data-cell"><span>Acoperit de Oficiul de Știri</span><strong>${coverage.status === 'deja-acoperit' ? 'DA' : coverage.status === 'posibil-similar' ? 'POSIBIL' : 'NU'}</strong></div>
        <div class="data-cell"><span>Recomandare</span><strong>${escapeHtml(topic.recommendation || 'monitorizează')}</strong></div>
      </div>

      <p class="reason"><strong>Pe scurt:</strong> ${escapeHtml(buildShortSummary(topic))}</p>
      <p class="reason"><strong>De ce contează:</strong> ${escapeHtml(buildImpactReasonClient(topic))}</p>
      <p class="reason"><strong>Entități detectate:</strong> ${escapeHtml((topic.entities || []).join(', ') || '—')}</p>
      <p class="reason"><strong>Keywords:</strong> ${escapeHtml((topic.keywords || []).slice(0, 8).join(', ') || buildFocusKeyword(topic))}</p>

      <div class="sources-list">${sourcesHtml || '<span class="badge">Surse indisponibile</span>'}</div>

      ${renderOnlineArticleLinks(topic)}
      <div class="card-actions">
        <button class="btn btn-primary" data-action="brief" data-id="${escapeAttr(topic.id)}" type="button">Brief</button>
        <button class="btn" data-action="titles" data-id="${escapeAttr(topic.id)}" type="button">SEO complet</button>
        <button class="btn" data-action="contacts" data-id="${escapeAttr(topic.id)}" type="button">Contacte + drafturi</button>
        <button class="btn" data-action="links" data-id="${escapeAttr(topic.id)}" type="button">Linkuri + surse</button>
        <button class="btn" data-action="draft" data-id="${escapeAttr(topic.id)}" type="button">Draft</button>
      </div>
    </article>
  `;
}


function showBrief(topic) {
  const coverage = topic.coverage || {};
  const focusKeyword = buildFocusKeyword(topic);
  el.dialogTitle.textContent = 'Brief + reguli șef';
  el.dialogBody.innerHTML = `
    <h3>${escapeHtml(topic.seoTitle || topic.title)}</h3>
    <div class="editorial-box">
      <p><strong>Unghi:</strong> ${escapeHtml(buildOficiulAngle(topic))}</p>
      <p><strong>Promisiunea titlului:</strong> explică nu doar ce s-a întâmplat, ci ce înseamnă pentru cititor.</p>
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
      <li><strong>Context:</strong> ce lipsește din știrea brută și de ce subiectul contează pentru români.</li>
      <li><strong>Pe scurt:</strong> 3–4 bulleturi cu date verificate.</li>
      <li><strong>Ce înseamnă pentru cititor:</strong> bani, timp, drepturi, siguranță, politică, familie sau servicii publice.</li>
      <li><strong>Ce urmează:</strong> următorul document, vot, comunicat, reacție, termen sau update.</li>
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
  const draft = buildLocalCopyPasteDraft(topic);
  el.dialogTitle.textContent = 'Draft local';
  el.dialogBody.innerHTML = `
    <p class="muted">Draft local construit din sursele detectate de radar. Verifică datele oficiale înainte de publicare.</p>
    <textarea class="draft-textarea large" readonly>${escapeHtml(draft)}</textarea>
    <div class="dialog-actions">
      <button class="btn btn-primary" type="button" onclick="navigator.clipboard.writeText(this.closest('.dialog-body').querySelector('textarea').value)">Copiază draftul</button>
    </div>
  `;
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

    <h3>Checklist final pentru material</h3>
    <ul>
      <li>titlu clar, pe expresia pe care o caută oamenii;</li>
      <li>șapou cu cine, ce, când și efectul pentru cititor;</li>
      <li>minimum o sursă externă verificată și, unde se poate, o sursă oficială;</li>
      <li>fără afirmații care nu apar în sursă sau în documente oficiale;</li>
      <li>H2-uri concrete, pe subiect, nu intertitluri generice;</li>
      <li>focus keyword fără diacritice și slug scurt;</li>
      <li>poza se caută separat manual, doar din surse legale clare.</li>
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
    return 'Contează pentru că pune în discuție siguranța oamenilor, reacția autorităților și felul în care sunt protejate victimele. Articolul trebuie să explice ce este confirmat oficial și ce măsuri au fost luate după incident.';
  }
  if (/meteo|anm|cod galben|cod portocaliu|vreme|furtuna|ploi|canicula|inundatii|vijelie|isu|trafic/.test(text)) {
    return 'Contează imediat pentru cititori pentru că poate afecta drumuri, locuințe, școli, evenimente și programul zilnic. Informația utilă este zona vizată, intervalul avertizării și ce trebuie făcut concret.';
  }
  if (/cfr cluj|fcsb|rapid|dinamo|craiova|fotbal|meci|transfer|cantonament|superliga|sport/.test(text)) {
    return 'Contează pentru publicul de sport pentru că arată programul echipei, pregătirea sezonului și posibilele decizii care pot influența lotul sau rezultatele. Cititorii caută date concrete: reunire, cantonament, adversari și transferuri.';
  }
  if (/kovesi|eppo|pnrr|ue|bruxelles|italia|rusia|ucraina|nato|moldova|sua|iran|bulgaria|marea neagra/.test(text)) {
    return 'Contează pentru România pentru că are legătură cu instituții europene, bani publici, securitate regională sau decizii care pot afecta poziția țării în UE și NATO. Textul trebuie să explice legătura românească, nu doar să preia știrea externă.';
  }
  if (/guvern|parlament|premier|ministru|lege|ordonanta|vot|coalitie|psd|pnl|usr|aur|udmr|alegeri|grindeanu|tomac|nicusor|simion|ciolacu/.test(text)) {
    return 'Contează politic pentru că poate schimba decizii publice, negocieri de putere sau reguli care ajung să afecteze cetățenii. Cititorii trebuie să înțeleagă dacă este doar declarație, conflict politic sau pas instituțional concret.';
  }
  if (/bac|evaluare|educatie|scoala|elev|profesor|examen|admitere|student/.test(text)) {
    return 'Contează pentru elevi, părinți și profesori, pentru că poate schimba calendarul, procedura sau informațiile de care depinde pregătirea. Textul trebuie să arate clar cine este vizat și ce termen trebuie urmărit.';
  }
  if (/sanatate|spital|medic|pacient|boala|tratament|medicament|cnas|dsp/.test(text)) {
    return 'Contează pentru pacienți și familii pentru că poate influența accesul la servicii medicale, tratamente sau reguli de sănătate publică. Informația trebuie verificată din surse oficiale și explicată fără alarmism.';
  }
  return `Contează dacă informația din „${title}” schimbă ceva concret pentru cititori: bani, siguranță, servicii publice, drepturi sau decizii politice. Materialul trebuie să arate efectul practic pentru România, nu doar faptul că subiectul a apărut în fluxuri.`;
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
  const focusKeyword = buildFocusKeyword(topic);
  const title = cleanupForArticle(topic.seoTitle || buildSeoHeadline(topic) || topic.title || 'Subiect nou');
  const sources = getCleanSources(topic).slice(0, 4);
  const externalLinks = chooseExternalLinks(topic);
  const h2Main = buildArticleMainH2(topic);
  const impactH2 = buildArticleImpactH2(topic);
  const verifyH2 = buildArticleVerifyH2(topic);
  const lead = buildArticleLead(topic, sources);
  const mainSection = buildArticleMainSection(topic, sources);
  const impactSection = buildArticleImpactSection(topic, sources);
  const verifySection = buildArticleVerifySection(topic, sources);
  const shortBox = buildArticleShortBox(topic, sources);
  const nextSection = buildArticleNextSection(topic, sources);
  const linkLines = externalLinks.length
    ? externalLinks.map((link, index) => `${index + 1}. ${link.anchor}: ${link.url}`).join('\n')
    : '1. Adaugă linkul sursei principale după verificare.\n2. Adaugă link oficial dacă există comunicat sau document public.';

  return `# ${title}

${lead}

## ${h2Main}

${mainSection}

## ${impactH2}

${impactSection}

## Pe scurt

${shortBox}

## ${verifyH2}

${verifySection}

## Documente și reacții care trebuie urmărite

${nextSection}

SEO rapid:
Focus keyword: ${focusKeyword}
Meta: ${buildMetaClient(topic, focusKeyword)}
Categorie: ${topic.wpCategory || topic.category || 'Actualitate'}
Taguri: ${buildTags(topic).join(', ')}

Linkuri externe detectate:
${linkLines}

Notă redacțională: draftul este construit automat din titlurile, descrierile și linkurile găsite de radar. Verifică sursa inițială și caută confirmarea oficială înainte de publicare, mai ales când subiectul apare într-o singură sursă.`;
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
  const affected = inferAffectedPeople(topic);
  const next = inferNextStep(topic);
  return `${topic.title}. Miza: ${affected}. Următorul pas: ${next}`;
}

function buildOficiulAngle(topic) {
  const interest = topic.interest || '';
  if (interest === 'Economie/Bani') return 'Explică efectul în bani: rate, taxe, prețuri, facturi, salarii sau buget. Nu rămâne la declarație.';
  if (interest === 'Politică') return 'Găsește miza politică reală: guvernare, voturi, negocieri, instituții, cost pentru public, nu doar omul din trend.';
  if (interest === 'Sănătate') return 'Explică impactul pentru pacienți, spitale, programări, costuri și ce trebuie verificat oficial.';
  if (interest === 'Educație') return 'Explică impactul pentru elevi și părinți: calendar, pași, greșeli de evitat, documente oficiale.';
  if (interest === 'Social') return 'Transformă știrea în informație utilă: cine e afectat, ce trebuie să facă cititorul, ce se schimbă concret.';
  if (interest === 'Externe relevante pentru români') return 'Explică obligatoriu legătura cu România: securitate, bani europeni, diaspora, UE/NATO, granița de est.';
  return 'Nu face preluare seacă. Adu context, impact pentru cititor și ce urmează.';
}

function inferAffectedPeople(topic) {
  const text = normalize(`${topic.title} ${topic.interest} ${(topic.keywords || []).join(' ')}`);
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
  const base = shortenTitleForSeo((topic.seoTitle || topic.title || '').replace(/[.!?]+$/, ''));
  const text = normalize(`${topic.title || ''} ${topic.interest || ''} ${(topic.keywords || []).join(' ')} ${(topic.entities || []).join(' ')}`);
  const focus = buildFocusKeyword(topic);
  let titles;

  if (/plafon|alimente|adaos|pret|preturi|facturi|tva|taxe|impozit|anaf|pensii|salarii/.test(text)) {
    titles = [
      `${base}. Ce se schimbă pentru români`,
      `${base}: lista, termenul și efectul la raft`,
      `Prețuri plafonate la alimente: ce produse sunt vizate și până când se aplică măsura`,
      `Adaos comercial plafonat până la finalul anului. Ce trebuie să știe cumpărătorii`,
      `${base}: cine controlează măsura și ce riscă magazinele`
    ];
  } else if (/guvern|parlament|pnl|psd|usr|aur|premier|ministru|alegeri|nicusor|simion|grindeanu|tomac|kovesi|epplo|pnrr/.test(text)) {
    titles = [
      `${base}. Efectul politic și ce urmează`,
      `${base}: cine este vizat și ce schimbă declarația`,
      `${base}. Contextul din spatele conflictului politic`,
      `${base}: reacții, instituții și următorul pas`,
      `${base}. Ce trebuie verificat înainte de publicare`
    ];
  } else if (/ucraina|rusia|nato|ue|moldova|sua|iran|bulgaria|italia/.test(text)) {
    titles = [
      `${base}. De ce contează pentru România`,
      `${base}: legătura cu UE, NATO și regiunea`,
      `${base}. Ce se schimbă în relațiile externe`,
      `${base}: ce înseamnă decizia pentru flancul estic`,
      `${base}. Reacțiile și documentele care trebuie urmărite`
    ];
  } else if (/meteo|anm|cod galben|cod portocaliu|furtuni|vreme|canicula|ninsoare/.test(text)) {
    titles = [
      `${base}. Zonele vizate și intervalul anunțat`,
      `${base}: județele afectate și riscurile pentru populație`,
      `Cod meteo în România: unde sunt așteptate furtuni și până când este valabilă avertizarea`,
      `${base}. Ce trebuie să știe șoferii și locuitorii din zonele afectate`,
      `${base}: harta avertizărilor și recomandările autorităților`
    ];
  } else if (/notar|parchet|procuror|judecat|instanta|dosar|ancheta|condamn/.test(text)) {
    titles = [
      `${base}. Prejudiciul anunțat și stadiul dosarului`,
      `${base}: ce spun procurorii și ce trebuie verificat`,
      `${base}. Acuzațiile, suma și prezumția de nevinovăție`,
      `${base}: ce urmează în instanță`,
      `${base}. De ce cazul contează pentru contribuabili`
    ];
  } else if (/injunghiat|crima|omor|amenintat|violenta|politia|isu|accident|incendiu/.test(text)) {
    titles = [
      `${base}. Ce au transmis autoritățile`,
      `${base}: victima, suspectul și primele date din anchetă`,
      `${base}. Ce se știe despre incident și ce trebuie confirmat`,
      `${base}: ancheta și măsurile anunțate`,
      `${base}. Întrebările la care trebuie să răspundă autoritățile`
    ];
  } else {
    titles = [
      `${base}. Ce se știe și ce trebuie verificat`,
      `${base}: contextul și următorul pas`,
      `${base}. Cine este afectat și ce informații lipsesc`,
      `${base}: datele confirmate până acum`,
      `${base}. Ce trebuie urmărit în următoarele ore`
    ];
  }

  titles.push(`${sentenceCase(focus)}: expresia pe care se poate indexa articolul`);
  return Array.from(new Set(titles.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))).slice(0, 6);
}

function buildSeoH2Recommendations(topic) {
  const base = shortenTitleForSeo((topic.title || topic.seoTitle || '').replace(/[.!?]+$/, ''));
  const text = normalize(`${topic.title || ''} ${topic.interest || ''} ${(topic.keywords || []).join(' ')} ${(topic.entities || []).join(' ')}`);
  const h2 = [];

  if (/plafon|alimente|adaos|pret|preturi|facturi|tva|taxe|impozit|anaf|pensii|salarii/.test(text)) {
    h2.push(
      `Alimentele cu adaos comercial plafonat: ce a decis Parlamentul`,
      `Lista produselor cu prețuri plafonate și termenul până la care se aplică măsura`,
      `Cum se vede plafonarea adaosului comercial la raft și în bugetul familiei`,
      `Ce magazine sunt vizate și cine poate verifica respectarea regulilor`,
      `Ce document oficial trebuie citat înainte de publicare`
    );
  } else if (/grindeanu|tomac|pnl|psd|usr|aur|guvern|parlament|premier|ministru|alegeri|nicusor|simion|kovesi|epplo|pnrr/.test(text)) {
    h2.push(
      `${base}: declarația care a declanșat disputa politică`,
      `Negocierile pentru Guvern și presiunea pusă pe partide`,
      `Cine este vizat de mesaj și ce poate urma în coaliție`,
      `Reacțiile care trebuie urmărite în următoarele ore`,
      `Ce documente sau poziții oficiale trebuie verificate`
    );
  } else if (/ucraina|rusia|nato|ue|moldova|sua|iran|bulgaria|italia/.test(text)) {
    h2.push(
      `${base}: decizia care schimbă discuția externă`,
      `Legătura cu România, UE și securitatea din regiune`,
      `Ce spun sursele internaționale și ce rămâne de confirmat`,
      `De ce contează subiectul pentru flancul estic`,
      `Ce reacții trebuie urmărite la Bruxelles, NATO sau în capitalele implicate`
    );
  } else if (/meteo|anm|cod galben|cod portocaliu|furtuni|vreme|canicula|ninsoare/.test(text)) {
    h2.push(
      `Cod meteo în România: zonele vizate de avertizare`,
      `Intervalul în care sunt așteptate ploi, vijelii sau grindină`,
      `Ce trebuie să știe șoferii și locuitorii din județele afectate`,
      `Recomandările autorităților în timpul avertizării ANM`,
      `Când ar putea fi actualizată harta meteo`
    );
  } else if (/notar|parchet|procuror|judecat|instanta|dosar|ancheta|condamn/.test(text)) {
    h2.push(
      `${base}: acuzațiile și prejudiciul anunțat de procurori`,
      `Ce impozite ar fi trebuit plătite la bugetul de stat`,
      `Stadiul dosarului și ce înseamnă trimiterea în judecată`,
      `De ce cazul contează pentru contribuabili și tranzacții imobiliare`,
      `Ce trebuie verificat în comunicatul Parchetului sau al instanței`
    );
  } else if (/injunghiat|crima|omor|amenintat|violenta|politia|isu|accident|incendiu/.test(text)) {
    h2.push(
      `${base}: primele informații despre victimă și suspect`,
      `Ce spun autoritățile despre atac și amenințările anterioare`,
      `Ancheta Poliției și măsurile luate după incident`,
      `De ce cazul ridică întrebări despre protecția victimelor`,
      `Ce detalii trebuie confirmate înainte de publicare`
    );
  } else {
    h2.push(
      `${base}: informațiile confirmate până acum`,
      `Contextul care lipsește din primele relatări`,
      `Cine este afectat de această decizie sau situație`,
      `Ce trebuie verificat în sursele oficiale`,
      `Ce se poate întâmpla în următoarele ore`
    );
  }

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
  el.sortFilter.value = 'priority';
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
