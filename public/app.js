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
  includeBlocked: document.getElementById('includeBlocked'),
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

  [el.searchInput, el.interestFilter, el.intensityFilter, el.coverageFilter, el.sortFilter, el.includeBlocked]
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
    if (button.dataset.action === 'prompt') showGptArticlePrompt(topic);
    if (button.dataset.action === 'draft') showCopyPasteDraft(topic);
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
    const response = await fetch(`/api/radar?${params.toString()}`, { cache: 'no-store' });
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
    state.sourceErrors = [{ source: 'API local', error: 'Nu s-a putut apela backendul. Rulează node server.js.' }];
    el.sourceNotice.innerHTML = `<strong>Mod demo:</strong> backendul nu răspunde. Rulează <code>node server.js</code> ca să scanezi live surse publice.`;
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

  el.resultsSummary.textContent = `${topics.length} subiect(e) afișate din ${state.topics.length} păstrate în intervalul ${formatScanInterval(getSelectedMaxAgeMinutes())}. Default: doar subiecte neacoperite.`;
  el.emptyState.hidden = topics.length > 0;
  el.topicsGrid.innerHTML = topics.map(renderTopicCard).join('');
}

function getFilteredTopics(sourceList = state.topics) {
  const search = normalize(el.searchInput.value);
  const includeBlocked = el.includeBlocked.checked;
  let list = sourceList.map(withCurrentAge).filter((topic) => isTopicWithinSelectedInterval(topic, getSelectedMaxAgeMinutes()));

  if (!includeBlocked) list = list.filter((topic) => topic.eligibility?.isEligible);
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
  const blockedHtml = isBlocked ? `<div class="blocked-reasons"><strong>Blocat:</strong> ${escapeHtml((topic.eligibility?.blockedReasons || []).join(' '))}</div>` : '';
  const sourcesHtml = (topic.sources || []).slice(0, 5).map((source) => {
    const href = source.url && source.url !== '#' ? source.url : '#';
    const age = typeof source.sourceAgeMinutes === 'number' ? ` · ${formatMinutes(source.sourceAgeMinutes)}` : '';
    return `<a class="source-link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.name || 'Sursă')}${escapeHtml(formatAuthor(source))}${escapeHtml(age)}</a>`;
  }).join('');

  return `
    <article class="topic-card ${escapeAttr(coverage.status)} ${isBlocked ? 'blocked' : ''}">
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
        <div class="data-cell"><span>Articole găsite online</span><strong>${topic.onlineCount ?? "—"}</strong></div>
        <div class="data-cell"><span>Risc editorial</span><strong>${escapeHtml(topic.risk || 'mediu')}</strong></div>
        <div class="data-cell"><span>Acoperit de Oficiul de Știri</span><strong>${coverage.status === 'deja-acoperit' ? 'DA' : coverage.status === 'posibil-similar' ? 'POSIBIL' : 'NU'}</strong></div>
        <div class="data-cell"><span>Recomandare</span><strong>${escapeHtml(topic.recommendation || 'monitorizează')}</strong></div>
      </div>

      <p class="reason"><strong>Pe scurt:</strong> ${escapeHtml(buildShortSummary(topic))}</p>
      <p class="reason"><strong>De ce contează:</strong> ${escapeHtml(topic.reason || '')}</p>
      <p class="reason"><strong>Entități detectate:</strong> ${escapeHtml((topic.entities || []).join(', ') || '—')}</p>
      <p class="reason"><strong>Keywords:</strong> ${escapeHtml((topic.keywords || []).slice(0, 8).join(', ') || buildFocusKeyword(topic))}</p>

      <div class="sources-list">${sourcesHtml || '<span class="badge">Surse indisponibile</span>'}</div>

      <div class="card-actions">
        <button class="btn btn-primary" data-action="brief" data-id="${escapeAttr(topic.id)}" type="button">Brief</button>
        <button class="btn" data-action="titles" data-id="${escapeAttr(topic.id)}" type="button">SEO complet</button>
        <button class="btn" data-action="contacts" data-id="${escapeAttr(topic.id)}" type="button">Contacte + drafturi</button>
        <button class="btn" data-action="links" data-id="${escapeAttr(topic.id)}" type="button">Linkuri + poze</button>
        <button class="btn" data-action="draft" data-id="${escapeAttr(topic.id)}" type="button">Draft</button>
        <button class="btn btn-primary" data-action="prompt" data-id="${escapeAttr(topic.id)}" type="button">Prompt articol</button>
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
      <li><strong>De ce contează:</strong> ${escapeHtml(topic.reason || 'Subiectul are potențial de interes public și trebuie verificat din surse primare.')}</li>
      <li><strong>Cine este afectat:</strong> ${escapeHtml(inferAffectedPeople(topic))}</li>
      <li><strong>Ce urmează:</strong> ${escapeHtml(inferNextStep(topic))}</li>
    </ul>

    <h3>Structură articol, maximum 700 de cuvinte</h3>
    <ol>
      <li><strong>Titlu cu miză:</strong> ${escapeHtml(topic.seoTitle || buildSeoHeadline(topic))}</li>
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
    <p><strong>Linkuri interne Oficiul de Știri:</strong> folosește articolele similare de mai jos doar dacă nu dublează unghiul.</p>
    ${renderMatches(coverage.matches || [])}

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
  const titles = [
    topic.seoTitle || buildSeoHeadline(topic),
    `${base}: ce se știe și ce urmează`,
    `${base}. De ce contează pentru România`,
    `Ce se schimbă după ${lowerFirst(base)}`,
    `${base}: cine este afectat și ce trebuie verificat`,
    `Miza din spatele subiectului ${focusKeyword}`
  ];

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
    <ul>
      <li>Ce s-a întâmplat în cazul ${escapeHtml(focusKeyword)}</li>
      <li>De ce contează pentru români</li>
      <li>Pe scurt: datele care trebuie verificate</li>
      <li>Ce urmează</li>
    </ul>

    <h3>Imagini</h3>
    <p>Caută imagine legală pe sursă oficială / instituție / Wikimedia. Nu folosi imagine cu licență neclară fără aprobare.</p>
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
    <p class="muted">Draft local rapid, fără AI. Pentru articol final de calitate, folosește butonul „Prompt articol”.</p>
    <textarea class="draft-textarea large" readonly>${escapeHtml(draft)}</textarea>
    <div class="dialog-actions">
      <button class="btn btn-primary" type="button" onclick="navigator.clipboard.writeText(this.closest('.dialog-body').querySelector('textarea').value)">Copiază draftul</button>
    </div>
  `;
  openDialog();
}

function showLinksAndImages(topic) {
  const externals = chooseExternalLinks(topic);
  const internal = chooseInternalLinks(topic);
  const imageQuery = encodeURIComponent(`${topic.title} ${topic.category || ''} Wikimedia Commons site:commons.wikimedia.org OR site:gov.ro OR site:europa.eu`);
  el.dialogTitle.textContent = 'Linkuri + poze legale';
  el.dialogBody.innerHTML = `
    <h3>2 linkuri externe recomandate</h3>
    <ol>${externals.map((l) => `<li><a href="${escapeAttr(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.anchor)}</a> — ${escapeHtml(l.url)}</li>`).join('') || '<li>Nu sunt suficiente surse externe în card. Verifică manual surse oficiale.</li>'}</ol>
    <h3>2 linkuri interne Oficiul de Știri recomandate</h3>
    <ol>${internal.map((l) => `<li><a href="${escapeAttr(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.anchor)}</a> — ${escapeHtml(l.url)}</li>`).join('') || '<li>Nu am găsit două linkuri interne clare. Caută manual pe Oficiul de Știri.</li>'}</ol>
    <h3>Poze legale</h3>
    <p>Caută două imagini: main + după șapou. Preferă Wikimedia Commons, instituții oficiale, Guvern, Parlament, UE, NATO, ministere, cluburi, comunicate oficiale.</p>
    <p><a class="btn" href="https://www.google.com/search?q=${imageQuery}" target="_blank" rel="noopener noreferrer">Caută poze legale</a></p>
    <h4>Checklist imagine</h4>
    <ul>
      <li>pagina exactă;</li>
      <li>link direct download dacă există;</li>
      <li>credit;</li>
      <li>licență / drepturi;</li>
      <li>nume fișier;</li>
      <li>alt text, title, caption, descriere.</li>
    </ul>
  `;
  openDialog();
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
Nu scrie doar „s-a întâmplat X”. Scrie ce înseamnă pentru cititor. Materialul trebuie să răspundă la: ce s-a întâmplat, de ce contează, ce urmează, cine este afectat, ce înseamnă pentru cititor. Paragrafe scurte, H2-uri dese, ton clar, explicativ, jurnalistic. Fără clickbait. Nu face preluare seacă. Găsește miza reală.

STRUCTURĂ OBLIGATORIE:
- maximum 700 de cuvinte, ideal 550–700;
- titlu cu miză clară;
- lead/șapou de 2–4 rânduri cu cine, ce, când, esența știrii, de ce contează, cine e afectat;
- context;
- secțiune explicativă: de ce contează / ce înseamnă / cine câștigă și cine pierde;
- element scanabil: „Pe scurt”, tabel, listă sau timeline;
- secțiune „Ce urmează”;
- final cu miză, nu final sec.

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
  return `${topic.seoTitle || buildSeoHeadline(topic)}

${buildLead(topic)}

## Pe scurt

- Subiect detectat în intervalul ales: ${formatMinutes(topic.startedMinutesAgo)}.
- Surse detectate de radar: ${formatSourceCount(topic.sourceCount || (topic.sources || []).length)}.
- Acoperire Oficiul de Știri: ${(topic.coverage || {}).label || 'Neacoperit'}.
- Risc editorial: ${topic.risk || 'mediu'}.

## De ce contează

${topic.reason || 'Subiectul poate avea miză pentru publicul din România, dar trebuie verificat din surse oficiale și completat cu un unghi editorial propriu.'}

## Ce înseamnă pentru cititor

Aici trebuie explicat efectul practic: bani, timp, drepturi, siguranță, servicii publice, educație, sănătate sau consecințe politice, în funcție de subiect.

## Ce urmează

Următorul pas este confirmarea informației din surse oficiale și, dacă este cazul, solicitarea unui punct de vedere.

SEO:
Focus keyword: ${focusKeyword}
Meta: ${buildMetaClient(topic, focusKeyword)}
Categorie: ${topic.wpCategory || topic.category || 'Actualitate'}
Taguri: ${buildTags(topic).join(', ')}

Notă: acesta este draft local. Pentru articol final în stil Oficiul de Știri, folosește „Prompt articol”.`;
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
  const base = (topic.title || '').replace(/[.!?]+$/, '');
  if ((topic.interest || '') === 'Economie/Bani') return `${base}. Ce se schimbă în bani pentru români`;
  if ((topic.interest || '') === 'Politică') return `${base}. Miza politică și ce urmează`;
  return `${base}. De ce contează pentru români`;
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
    'Care este miza pentru publicul din România?',
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
  el.includeBlocked.checked = false;
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
