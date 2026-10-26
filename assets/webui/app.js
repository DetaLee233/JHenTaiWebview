(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const CATEGORY_COLORS = {
    'Doujinshi': '#fc4e4e',
    'Manga': '#fcb417',
    'Image Set': '#5050d7',
    'Game CG': '#05bf0b',
    'Artist CG': '#dde500',
    'Cosplay': '#9755f5',
    'Non-H': '#68c9de',
    'Asian Porn': '#fe93ff',
    'Western': '#14e723',
    'Misc': '#9e9e9e',
    'Private': '#000000',
  };
  const TAG_COLORS = {
    language: '#f5dff5',
    artist: '#ccd9cd',
    character: '#c8c8e7',
    female: '#dbceee',
    male: '#fdd7d7',
    parody: '#eed4c5',
    group: '#dfd6f7',
    mixed: '#d6e0f7',
    cosplayer: '#f6dcf3',
    reclass: '#f6dce9',
    temp: '#e9dbfa',
    other: '#fadcdb',
    location: '#f5dff5',
  };
  const CATEGORY_NAMES = ['Doujinshi', 'Manga', 'Artist CG', 'Game CG', 'Image Set', 'Cosplay', 'Non-H', 'Western', 'Asian Porn', 'Misc'];
  const CATEGORY_KEYS = ['doujinshi', 'manga', 'artistcg', 'gamecg', 'imageset', 'cosplay', 'nonh', 'western', 'asianporn', 'misc'];
  const LANG_ABBR = {
    chinese: 'ZH', english: 'EN', japanese: 'JP', korean: 'KR', russian: 'RU', portuguese: 'PT',
    spanish: 'ES', french: 'FR', german: 'DE', italian: 'IT', vietnamese: 'VI', thai: 'TH',
  };
  const STATUS_LABELS = {
    none: '等待中', switching: '切换中', paused: '已暂停', downloading: '下载中', downloaded: '已完成',
    downloadFailed: '下载失败', needReUnlock: '需重新解锁', unlocking: '解锁中', unlocked: '已解锁',
    parsingDownloadPageUrl: '解析下载页', parsedDownloadPageUrl: '已解析下载页', parsingDownloadUrl: '解析链接',
    parsedDownloadUrl: '已解析链接', waitingIsolate: '排队中', unpacking: '解压中', completed: '已完成', canceled: '已取消',
  };

  const state = {
    tab: 'home',
    appearance: { themeMode: 'dark', lightColor: '#6750a4', darkColor: '#d0bcff' },
    filtersMeta: null,
    settings: null,
    network: null,
    filter: {
      cats: [...CATEGORY_KEYS],
      language: '',
      minRating: 1,
      expunged: false,
      torrents: false,
      pageFrom: '',
      pageTo: '',
      favcat: null,
    },
    gallery: {
      type: 'home',
      keyword: '',
      items: [],
      nextGid: null,
      loading: false,
      page: 0,
      pageCount: 0,
      rankType: 'day',
    },
    listMode: localStorage.getItem('jh_list_mode') || 'grid',
    searchHistory: JSON.parse(localStorage.getItem('jh_search_history') || '[]'),
    detail: null,
    detailUrl: null,
    reader: null,
    downloadTab: 'gallery',
    pollTimer: null,
  };

  // ---------------- token ----------------

  const params = new URLSearchParams(location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    localStorage.setItem('jh_token', urlToken);
    params.delete('token');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : ''));
  }
  const getToken = () => localStorage.getItem('jh_token') || '';
  function withToken(url) {
    const t = getToken();
    if (!t) return url;
    return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
  }

  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (options.body) headers['Content-Type'] = 'application/json';
    if (getToken()) headers['X-Auth-Token'] = getToken();
    let response;
    try {
      response = await fetch(path, Object.assign({ signal: options.signal || AbortSignal.timeout(70000) }, options, { headers }));
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new Error('请求超时，请检查 App 的网络代理');
      }
      throw error;
    }
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('json') ? await response.json() : await response.text();
    if (response.status === 401) {
      showTokenModal();
      throw new Error('需要访问令牌');
    }
    if (!response.ok) {
      throw new Error((data && data.error) || response.statusText || '请求失败');
    }
    return data;
  }

  function showTokenModal() {
    openModal('需要访问令牌', `
      <p class="muted">请在 App 的「设置 → Web 服务器」中查看访问令牌。</p>
      <div class="form-row"><input id="token-input" type="password" placeholder="访问令牌" style="flex:1"></div>
      <div class="modal-actions"><button class="btn primary" id="token-save">连接</button></div>
    `);
    $('#token-save').onclick = () => {
      const value = $('#token-input').value.trim();
      if (!value) return;
      localStorage.setItem('jh_token', value);
      location.reload();
    };
  }

  // ---------------- helpers ----------------

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
  function icon(name, cls = '') {
    return `<span class="mi mi-${name} ${cls}"></span>`;
  }
  function proxyUrl(url) {
    if (!url) return '';
    if (url.startsWith('/')) return withToken(url);
    return withToken('/api/proxy?url=' + encodeURIComponent(url));
  }
  function categoryColor(category) {
    return CATEGORY_COLORS[category] || '#9e9e9e';
  }
  function langAbbr(lang) {
    if (!lang) return '';
    return LANG_ABBR[String(lang).toLowerCase()] || String(lang).slice(0, 2).toUpperCase();
  }
  function pageBadge(gallery) {
    const lang = langAbbr(gallery.language);
    const pages = gallery.pageCount ? gallery.pageCount + 'P' : '';
    return [lang, pages].filter(Boolean).join(' ');
  }
  function starRow(rating, cls = '') {
    const r = Number(rating) || 0;
    let html = '';
    for (let i = 1; i <= 5; i++) {
      let name = 'star_border';
      if (r >= i - 0.25) name = 'star';
      else if (r >= i - 0.75) name = 'star_half';
      html += icon(name);
    }
    return `<span class="stars ${cls}">${html}</span>`;
  }
  function flattenTags(tags) {
    const list = [];
    for (const [ns, values] of Object.entries(tags || {})) {
      for (const value of values || []) list.push({ ns, value });
    }
    return list;
  }
  function tagsPlain(gallery, limit = 8) {
    const list = flattenTags(gallery.tags);
    const shown = list.slice(0, limit);
    return `<div class="g-tags">${shown.map((t) => `<span>${escapeHtml(t.value)}</span>`).join('')}</div>`;
  }
  function sanitizeHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html || '';
    template.content.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach((node) => node.remove());
    template.content.querySelectorAll('*').forEach((node) => {
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || (name === 'href' && attr.value.trim().toLowerCase().startsWith('javascript:'))) {
          node.removeAttribute(attr.name);
        }
      }
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noreferrer');
      }
    });
    return template.innerHTML;
  }
  function fmtBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n > 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n > 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }
  function truncate(text, n) {
    const s = String(text || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function galleryUrlFromInput(input) {
    const match = String(input || '').trim().match(/https?:\/\/e[-x]hentai\.org\/g\/\d+\/[a-z0-9]{10}\/?/i);
    return match ? match[0] : null;
  }

  let toastTimer = null;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function openModal(title, body, { wide = false } = {}) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}">
      <button class="icon-btn close" data-close-modal>${icon('close')}</button>
      <h2>${escapeHtml(title)}</h2>${body}
    </div></div>`;
    return $('.modal', root);
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-modal]')) { closeModal(); return; }
    if (event.target.classList.contains('modal-backdrop')) { closeModal(); }
  });

  function openLoadingModal(title) {
    return openModal(title, '<div class="loading"><div class="spinner"></div><span>加载中...</span></div>');
  }

  // ---------------- theme ----------------

  function applyTheme(appearance) {
    state.appearance = appearance || state.appearance;
    const mode = state.appearance.themeMode;
    const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const primary = dark ? state.appearance.darkColor : state.appearance.lightColor;
    document.documentElement.style.setProperty('--primary', primary);
    document.documentElement.style.setProperty('--on-primary', dark ? '#381e72' : '#ffffff');
  }

  // ---------------- rail / tabs ----------------

  function updateRail() {
    $$('.rail-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === state.tab));
  }

  document.addEventListener('click', (event) => {
    const tabButton = event.target.closest('[data-tab]');
    if (tabButton) {
      showTab(tabButton.dataset.tab);
      return;
    }
    const galleryCard = event.target.closest('[data-gallery-url]');
    if (galleryCard) {
      openDetail(galleryCard.dataset.galleryUrl);
    }
  });

  function showTab(tab) {
    if (!tab) return;
    state.tab = tab;
    updateRail();
    closeModal();
    $('#reader-pane').hidden = true;
    $('#reader-pane').innerHTML = '';
    state.reader = null;
    document.body.classList.remove('reader-open');
    $('#right-pane').classList.remove('open');
    $('#content').scrollTop = 0;
    renderPage();
  }

  // ---------------- page rendering ----------------

  function renderPage() {
    switch (state.tab) {
      case 'home':
      case 'popular':
      case 'search':
      case 'favorite':
      case 'watched':
        renderGalleryPage();
        break;
      case 'ranklist':
        renderRanklistPage();
        break;
      case 'history':
        renderHistoryPage();
        break;
      case 'download':
        renderDownloadPage();
        break;
      case 'setting':
        renderSettingsPage();
        break;
      default:
        renderGalleryPage();
    }
  }

  function toolbarBase(title, subtitle, actions) {
    return `<div class="title">${escapeHtml(title)}${subtitle ? `<span class="sub">${escapeHtml(subtitle)}</span>` : ''}</div><div class="tools">${actions}</div>`;
  }
  function refreshButton() { return `<button class="icon-btn" data-page-action="refresh" title="刷新">${icon('refresh')}</button>`; }
  function filterButton() { return `<button class="icon-btn" data-page-action="filter" title="筛选">${icon('filter_list')}</button>`; }
  function viewToggle() {
    const other = state.listMode === 'grid' ? 'list' : 'grid_view';
    return `<button class="icon-btn" data-page-action="view" title="切换列表">${icon(other)}</button>`;
  }

  // ---------------- gallery pages ----------------

  function renderGalleryPage() {
    const isSearch = state.tab === 'search';
    const type = state.tab === 'favorite' ? 'favorite' : state.tab === 'watched' ? 'watched' : state.tab === 'popular' ? 'popular' : isSearch ? 'search' : 'home';
    state.gallery.type = type;
    state.gallery.keyword = isSearch ? state.gallery.keyword : '';

    let toolbar = '';
    if (isSearch) {
      toolbar = `
        <div class="search-box">
          ${icon('search')}
          <input id="search-input" type="search" placeholder="搜索画廊、标签，或粘贴画廊链接" value="${escapeHtml(state.gallery.keyword)}" autocomplete="off">
          <button class="clear" data-page-action="clear-search" title="清空">${icon('close')}</button>
        </div>
        ${filterButton()}${viewToggle()}
      `;
    } else {
      const titles = { home: '首页', popular: '热门', favorite: '收藏', watched: '关注' };
      const subtitle = type === 'favorite' ? '需要登录' : type === 'watched' ? '需要登录' : '';
      let favoriteSelect = '';
      if (type === 'favorite' && state.filtersMeta && state.filtersMeta.favorites) {
        favoriteSelect = `<select id="fav-cat" style="max-width:160px"><option value="">全部分组</option>${state.filtersMeta.favorites.map((name, i) => `<option value="${i}" ${state.filter.favcat === i ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select>`;
      }
      toolbar = toolbarBase(titles[type] || '首页', subtitle, `${favoriteSelect}${refreshButton()}${filterButton()}${viewToggle()}`);
    }

    $('#toolbar').innerHTML = toolbar;
    $('#content').innerHTML = `
      <div id="gallery-shell">
        <div id="gallery-meta" class="toolbar" style="border:0;min-height:0;padding:0 0 12px;background:transparent"></div>
        <div id="gallery-body"></div>
        <div id="gallery-foot" style="display:flex;justify-content:center;padding:22px 0"></div>
      </div>`;

    bindGalleryToolbar();

    if (type === 'favorite' || type === 'watched') {
      if (!state.filtersMeta || !state.filtersMeta.user || !state.filtersMeta.user.loggedIn) {
        $('#gallery-body').innerHTML = `<div class="empty">${icon('account_circle')}<div style="margin-top:10px">该页面需要先在 App 中登录 E-Hentai</div></div>`;
        return;
      }
    }

    if (isSearch && !state.gallery.keyword) {
      renderSearchLanding();
      return;
    }

    state.gallery.items = [];
    state.gallery.nextGid = null;
    state.gallery.loading = false;
    loadGalleries(true);
  }

  function bindGalleryToolbar() {
    $$('#toolbar [data-page-action]').forEach((btn) => {
      btn.addEventListener('click', () => handlePageAction(btn.dataset.pageAction));
    });
    const input = $('#search-input');
    if (input) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submitSearch(input.value);
        }
      });
    }
    const favCat = $('#fav-cat');
    if (favCat) {
      favCat.onchange = () => {
        state.filter.favcat = favCat.value === '' ? null : Number(favCat.value);
        state.gallery.items = [];
        state.gallery.nextGid = null;
        loadGalleries(true);
      };
    }
  }

  function handlePageAction(action) {
    if (action === 'refresh') {
      if (state.tab === 'history') return renderHistoryPage();
      state.gallery.items = [];
      state.gallery.nextGid = null;
      state.gallery.page = 0;
      if (state.tab === 'ranklist') return loadRanklist(0);
      return loadGalleries(true);
    }
    if (action === 'filter') {
      openFilterModal(() => {
        if (state.tab === 'ranklist') return loadRanklist(0);
        state.gallery.items = [];
        state.gallery.nextGid = null;
        loadGalleries(true);
      });
      return;
    }
    if (action === 'view') {
      state.listMode = state.listMode === 'grid' ? 'list' : 'grid';
      localStorage.setItem('jh_list_mode', state.listMode);
      const button = $('#toolbar [data-page-action="view"]');
      if (button) button.innerHTML = icon(state.listMode === 'grid' ? 'list' : 'grid_view');
      renderGalleryItems();
      return;
    }
    if (action === 'clear-search') {
      state.gallery.keyword = '';
      renderGalleryPage();
      return;
    }
    if (action === 'clear-history') {
      if (!confirm('清空全部阅读历史？')) return;
      api('/api/history', { method: 'DELETE' }).then(() => {
        toast('已清空');
        renderHistoryPage();
      });
    }
  }

  function submitSearch(value) {
    const direct = galleryUrlFromInput(value);
    if (direct) {
      openDetail(direct);
      return;
    }
    state.gallery.keyword = value.trim();
    state.searchHistory = [state.gallery.keyword, ...state.searchHistory.filter((x) => x !== state.gallery.keyword)].slice(0, 20);
    localStorage.setItem('jh_search_history', JSON.stringify(state.searchHistory));
    showTab('search');
  }

  function renderSearchLanding() {
    const history = state.searchHistory;
    $('#gallery-body').innerHTML = `
      <div class="settings-card" style="max-width:720px">
        <h3>搜索历史</h3>
        ${history.length ? `<div class="detail-tags">${history.map((h) => `<button class="tag-chip" data-history-search="${escapeHtml(h)}">${escapeHtml(h)}</button>`).join('')}</div>` : '<div class="muted">暂无搜索记录</div>'}
        <h3 style="margin-top:22px">提示</h3>
        <div class="muted" style="line-height:1.8">
          支持 E-Hentai 搜索语法，例如 <code>character:"hibiki$"</code>、<code>language:chinese</code>。<br>
          粘贴 <code>https://e-hentai.org/g/...</code> 链接可直接打开详情。
        </div>
      </div>`;
    $$('#gallery-body [data-history-search]').forEach((button) => {
      button.addEventListener('click', () => submitSearch(button.dataset.historySearch));
    });
  }

  function galleryCard(gallery) {
    const cat = gallery.category || 'Misc';
    const cover = proxyUrl(gallery.cover);
    return `<article class="g-card" data-gallery-url="${escapeHtml(gallery.url)}">
      <div class="g-cover">
        <img loading="lazy" src="${escapeHtml(cover)}" alt="">
        <div class="g-badges">
          <span class="cat-badge" style="background:${categoryColor(cat)}">${escapeHtml(cat)}</span>
          <span class="page-badge">${escapeHtml(pageBadge(gallery))}</span>
        </div>
      </div>
      <div class="g-card-stars">${starRow(gallery.rating)}</div>
      <div class="g-title">${escapeHtml(gallery.title)}</div>
      ${tagsPlain(gallery, 5)}
    </article>`;
  }

  function galleryRow(gallery) {
    const cat = gallery.category || 'Misc';
    return `<article class="g-row" data-gallery-url="${escapeHtml(gallery.url)}">
      <div class="g-row-cover">
        <img loading="lazy" src="${escapeHtml(proxyUrl(gallery.cover))}" alt="">
      </div>
      <div class="g-row-body">
        <div class="g-row-title">${escapeHtml(gallery.title)}</div>
        <div class="g-row-sub">${escapeHtml(gallery.uploader || '')}</div>
        ${tagsPlain(gallery, 8)}
        <div class="g-row-footer">
          <span class="cat-badge" style="background:${categoryColor(cat)}">${escapeHtml(cat)}</span>
          <span class="g-row-sub">${escapeHtml(pageBadge(gallery))}</span>
          ${starRow(gallery.rating)}
          <span class="date">${escapeHtml(gallery.publishTime || '')}</span>
        </div>
      </div>
    </article>`;
  }

  function renderGalleryItems() {
    const body = $('#gallery-body');
    if (!body) return;
    if (!state.gallery.items.length) {
      body.innerHTML = state.gallery.loading ? '<div class="loading"><div class="spinner"></div><span>加载中...</span></div>' : '<div class="empty">没有结果</div>';
      return;
    }
    if (state.listMode === 'list') {
      body.innerHTML = `<div class="gallery-list">${state.gallery.items.map(galleryRow).join('')}</div>`;
    } else {
      body.innerHTML = `<div class="grid">${state.gallery.items.map(galleryCard).join('')}</div>`;
    }
    const foot = $('#gallery-foot');
    if (foot) {
      foot.innerHTML = state.gallery.nextGid ? '<button class="btn" id="load-more">加载更多</button>' : '';
      const more = $('#load-more');
      if (more) more.onclick = () => loadGalleries(false);
    }
  }

  async function loadGalleries(reset) {
    if (state.gallery.loading) return;
    if (!reset && !state.gallery.nextGid) return;
    state.gallery.loading = true;
    if (reset) {
      $('#gallery-body').innerHTML = '<div class="loading"><div class="spinner"></div><span>加载中...</span></div>';
    }
    $('#gallery-foot').innerHTML = '';

    try {
      const p = new URLSearchParams();
      p.set('type', state.gallery.type);
      if (state.gallery.keyword) p.set('q', state.gallery.keyword);
      if (!reset && state.gallery.nextGid) p.set('next', state.gallery.nextGid);
      const f = state.filter;
      if (f.cats.length !== CATEGORY_KEYS.length) p.set('cats', f.cats.join(','));
      if (f.language) p.set('language', f.language);
      if (f.minRating > 1) p.set('minRating', String(f.minRating));
      if (f.expunged) p.set('expunged', '1');
      if (f.torrents) p.set('torrents', '1');
      if (f.pageFrom) p.set('pageFrom', f.pageFrom);
      if (f.pageTo) p.set('pageTo', f.pageTo);
      if (state.gallery.type === 'favorite' && f.favcat != null) p.set('favcat', String(f.favcat));

      const data = await api('/api/galleries?' + p.toString());
      if (!reset) {
        state.gallery.items.push(...(data.galleries || []));
      } else {
        state.gallery.items = data.galleries || [];
      }
      state.gallery.nextGid = data.nextGid || null;
      const meta = $('#gallery-meta');
      if (meta) {
        meta.innerHTML = `<span class="muted">${data.totalCount ? '共 ' + escapeHtml(data.totalCount) + ' 个结果' : ''}</span>`;
      }
      renderGalleryItems();
    } catch (error) {
      if (error.message !== '需要访问令牌') {
        $('#gallery-body').innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}</div>`;
      }
    } finally {
      state.gallery.loading = false;
    }
  }

  // ---------------- ranklist ----------------

  function renderRanklistPage() {
    const types = [['day', '日榜'], ['month', '月榜'], ['year', '年榜'], ['allTime', '总榜']];
    $('#toolbar').innerHTML = toolbarBase('排行', '', `
      <div class="segmented" id="rank-types">${types.map(([key, label]) => `<button data-rank="${key}" class="${state.gallery.rankType === key ? 'active' : ''}">${label}</button>`).join('')}</div>
      ${refreshButton()}${viewToggle()}
    `);
    $('#content').innerHTML = '<div id="gallery-body"></div><div id="gallery-foot" style="display:flex;justify-content:center;gap:10px;padding:22px 0"></div>';
    $$('#rank-types [data-rank]').forEach((button) => {
      button.onclick = () => { state.gallery.rankType = button.dataset.rank; renderRanklistPage(); };
    });
    $$('#toolbar [data-page-action]').forEach((btn) => btn.onclick = () => handlePageAction(btn.dataset.pageAction));
    loadRanklist(0);
  }

  async function loadRanklist(pageIndex) {
    state.gallery.page = pageIndex;
    $('#gallery-body').innerHTML = '<div class="loading"><div class="spinner"></div><span>加载中...</span></div>';
    try {
      const data = await api(`/api/ranklist?type=${encodeURIComponent(state.gallery.rankType)}&page=${pageIndex}`);
      state.gallery.items = data.galleries || [];
      state.gallery.pageCount = data.pageCount || 0;
      state.gallery.nextPage = data.nextPage;
      state.gallery.prevPage = data.prevPage;
      renderGalleryItems();
      const foot = $('#gallery-foot');
      foot.innerHTML = `
        <button class="btn" id="rank-prev" ${data.prevPage == null ? 'disabled' : ''}>上一页</button>
        <span class="muted" style="align-self:center">${pageIndex + 1} / ${data.pageCount || 1}</span>
        <button class="btn" id="rank-next" ${data.nextPage == null ? 'disabled' : ''}>下一页</button>`;
      const prev = $('#rank-prev');
      const next = $('#rank-next');
      if (prev) prev.onclick = () => data.prevPage != null && loadRanklist(data.prevPage);
      if (next) next.onclick = () => data.nextPage != null && loadRanklist(data.nextPage);
    } catch (error) {
      $('#gallery-body').innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}</div>`;
    }
  }

  // ---------------- history ----------------

  function renderHistoryPage() {
    $('#toolbar').innerHTML = toolbarBase('历史', '', `<button class="icon-btn" data-page-action="clear-history" title="清空历史">${icon('delete')}</button>${refreshButton()}${viewToggle()}`);
    $('#content').innerHTML = '<div id="gallery-body"><div class="loading"><div class="spinner"></div><span>加载中...</span></div></div>';
    $$('#toolbar [data-page-action]').forEach((btn) => btn.onclick = () => handlePageAction(btn.dataset.pageAction));
    loadHistory();
  }

  async function loadHistory() {
    try {
      const data = await api('/api/history?page=0');
      state.gallery.items = data.galleries || [];
      state.gallery.nextGid = null;
      renderGalleryItems();
    } catch (error) {
      $('#gallery-body').innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}</div>`;
    }
  }

  // ---------------- filter modal ----------------

  function openFilterModal(onApply) {
    const f = state.filter;
    const body = `
      <div class="filter-group" style="margin-bottom:12px">
        <div class="label">分类</div>
        <div class="check-row" id="filter-cats">
          ${CATEGORY_NAMES.map((name, i) => `<label class="chip-check ${f.cats.includes(CATEGORY_KEYS[i]) ? 'on' : ''}"><input type="checkbox" value="${CATEGORY_KEYS[i]}" ${f.cats.includes(CATEGORY_KEYS[i]) ? 'checked' : ''}>${name}</label>`).join('')}
        </div>
      </div>
      <div class="form-row"><label>语言</label><select id="filter-language">
        <option value="">全部</option>
        ${['chinese', 'english', 'japanese', 'korean', 'spanish', 'french', 'german', 'russian', 'portuguese'].map((l) => `<option value="${l}" ${f.language === l ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>
      <div class="form-row"><label>最低评分</label><select id="filter-rating">
        ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${f.minRating === n ? 'selected' : ''}>${n} 星及以上</option>`).join('')}
      </select></div>
      <div class="form-row"><label>页数范围</label><input id="filter-page-from" type="number" placeholder="最少" value="${f.pageFrom}"><input id="filter-page-to" type="number" placeholder="最多" value="${f.pageTo}"></div>
      <div class="form-row"><label>其他</label>
        <label class="chip-check ${f.expunged ? 'on' : ''}"><input type="checkbox" id="filter-expunged" ${f.expunged ? 'checked' : ''}>包含删除画廊</label>
        <label class="chip-check ${f.torrents ? 'on' : ''}"><input type="checkbox" id="filter-torrents" ${f.torrents ? 'checked' : ''}>仅有种子</label>
      </div>
      <div class="modal-actions">
        <button class="btn" id="filter-reset">重置</button>
        <button class="btn primary" id="filter-apply">应用</button>
      </div>`;
    openModal('筛选', body);

    $$('#filter-cats .chip-check').forEach((label) => {
      label.onclick = (event) => {
        if (event.target.tagName !== 'INPUT') label.querySelector('input').checked = !label.querySelector('input').checked;
        label.classList.toggle('on', label.querySelector('input').checked);
      };
    });
    $('#filter-expunged').onchange = (e) => e.target.closest('.chip-check').classList.toggle('on', e.target.checked);
    $('#filter-torrents').onchange = (e) => e.target.closest('.chip-check').classList.toggle('on', e.target.checked);
    $('#filter-reset').onclick = () => {
      state.filter = { cats: [...CATEGORY_KEYS], language: '', minRating: 1, expunged: false, torrents: false, pageFrom: '', pageTo: '', favcat: null };
      closeModal();
      onApply();
    };
    $('#filter-apply').onclick = () => {
      state.filter.cats = $$('#filter-cats input:checked').map((i) => i.value);
      state.filter.language = $('#filter-language').value;
      state.filter.minRating = Number($('#filter-rating').value) || 1;
      state.filter.expunged = $('#filter-expunged').checked;
      state.filter.torrents = $('#filter-torrents').checked;
      state.filter.pageFrom = $('#filter-page-from').value;
      state.filter.pageTo = $('#filter-page-to').value;
      closeModal();
      onApply();
    };
  }

  // ---------------- detail ----------------

  async function openDetail(url) {
    state.detailUrl = url;
    $('#right-pane').classList.add('open');
    $('#reader-pane').hidden = true;
    $('#detail-pane').innerHTML = '<div class="loading"><div class="spinner"></div><span>加载中...</span></div>';
    try {
      const detail = await api('/api/gallery?url=' + encodeURIComponent(url));
      state.detail = detail;
      renderDetail(detail);
      if (window.innerWidth <= 760) $('#right-pane').classList.add('open');
    } catch (error) {
      if (error.message !== '需要访问令牌') {
        $('#detail-pane').innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}</div>`;
      }
    }
  }

  function renderDetail(detail) {
    const tags = flattenTags(detail.tags).map((t) => {
      const color = TAG_COLORS[t.ns] || '#e6e1e5';
      return `<span class="detail-tag" style="background:${color}"><b>${escapeHtml(t.ns)}</b>${escapeHtml(t.value)}</span>`;
    }).join('');

    const comments = (detail.comments || []).map((comment) => `
      <div class="comment">
        <div class="comment-head">
          <span class="user">${escapeHtml(comment.username || 'Anonymous')}</span>
          ${comment.score && comment.score !== '0' ? `<span class="status-pill">${escapeHtml(comment.score)}</span>` : ''}
          <span class="time">${escapeHtml(comment.time || '')}</span>
        </div>
        <div class="comment-body">${sanitizeHtml(comment.content)}</div>
        ${comment.fromMe ? `<div class="comment-actions"><button data-detail-action="edit-comment" data-comment-id="${comment.id}">编辑</button></div>` : ''}
      </div>`).join('');

    $('#detail-pane').innerHTML = `
      <div class="detail-top">
        <button class="icon-btn detail-back" data-detail-action="close">${icon('arrow_back')}</button>
        <h2 class="detail-heading">${escapeHtml(detail.title)}</h2>
        <button class="icon-btn" data-detail-action="open-eh" title="在 E-Hentai 打开">${icon('open_in_new')}</button>
      </div>
      <div class="detail-hero">
        <img class="detail-cover" src="${escapeHtml(proxyUrl(detail.cover))}" alt="">
        <div class="detail-main">
          ${detail.rawTitle && detail.rawTitle !== detail.title ? `<div class="detail-uploader" style="margin-top:0;margin-bottom:6px">${escapeHtml(detail.rawTitle)}</div>` : ''}
          <div class="detail-uploader">${escapeHtml(detail.uploader || '')}</div>
          <div class="detail-meta">
            <span>${icon('wifi')} ${escapeHtml(detail.language || '')}</span>
            <span>${icon('favorite_border')} ${detail.favoriteCount || 0}</span>
            <span>${icon('image')} ${escapeHtml(detail.size || '')}</span>
            <span>${icon('book')} ${detail.pageCount || 0}P</span>
            <span>${icon('insert_chart')} ${detail.rating ? Number(detail.rating).toFixed(2) : '0.00'} (${detail.ratingCount || 0})</span>
            <span>${icon('history')} ${escapeHtml(detail.publishTime || '')}</span>
          </div>
          <div class="detail-stars">${starRow(detail.rating)}<span class="num">${detail.rating ? Number(detail.rating).toFixed(2) : ''}</span></div>
        </div>
      </div>
      <div class="detail-actions">
        <button class="detail-action" data-detail-action="read">${icon('visibility')}<span>阅读</span></button>
        <button class="detail-action" data-detail-action="download">${icon('download')}<span>下载</span></button>
        <button class="detail-action ${detail.isFavorite ? 'active' : ''}" data-detail-action="favorite">${icon(detail.isFavorite ? 'favorite' : 'favorite_border')}<span>收藏</span></button>
        <button class="detail-action" data-detail-action="rating">${icon('star')}<span>评分</span></button>
        <button class="detail-action" data-detail-action="archive">${icon('archive')}<span>归档</span></button>
        <button class="detail-action" data-detail-action="hh">${icon('cloud_download')}<span>H@H</span></button>
        <button class="detail-action" data-detail-action="similar">${icon('search')}<span>相似</span></button>
        <button class="detail-action" data-detail-action="torrents">${icon('link')}<span>种子</span></button>
        <button class="detail-action" data-detail-action="stats">${icon('insert_chart')}<span>统计</span></button>
      </div>
      <div class="detail-section"><h4>标签</h4><div class="detail-tags">${tags || '<span class="muted">无标签</span>'}</div></div>
      <div class="detail-section">
        <h4 style="display:flex;align-items:center;gap:8px">评论 <span class="muted" style="font-weight:400">${(detail.comments || []).length}</span>
          <span style="flex:1"></span>
          <button class="btn small tonal" data-detail-action="comment">写评论</button>
        </h4>
        <div class="comments">${comments || '<div class="muted">暂无评论</div>'}</div>
      </div>
`;

    $$('#detail-pane [data-detail-action]').forEach((button) => {
      button.onclick = () => handleDetailAction(button.dataset.detailAction, button);
    });
  }

  async function handleDetailAction(action, button) {
    const detail = state.detail;
    if (!detail) return;
    if (action === 'close') {
      $('#right-pane').classList.remove('open');
      return;
    }
    if (action === 'open-eh') {
      window.open(detail.url, '_blank', 'noreferrer');
      return;
    }
    if (action === 'read') {
      await startOnlineReader(detail);
      return;
    }
    if (action === 'download') return openDownloadDialog(detail);
    if (action === 'favorite') return openFavoriteDialog(detail);
    if (action === 'rating') return openRatingDialog(detail);
    if (action === 'archive') return openArchiveDialog(detail);
    if (action === 'hh') return openHHDialog(detail);
    if (action === 'similar') {
      const title = (detail.rawTitle || detail.title || '').replace(/\[.*?\]|\(.*?\)|\{.*?\}/g, '').trim();
      state.gallery.keyword = 'title:"' + title + '"';
      showTab('search');
      return;
    }
    if (action === 'torrents') return openTorrentsDialog(detail);
    if (action === 'stats') return openStatsDialog(detail);
    if (action === 'comment') return openCommentDialog(detail, null);
    if (action === 'edit-comment') return openCommentDialog(detail, Number(button.dataset.commentId));
  }

  // ---------------- detail actions ----------------

  function openDownloadDialog(detail) {
    const groups = (state.filtersMeta && state.filtersMeta.groups) || [];
    const loggedIn = !!(state.filtersMeta && state.filtersMeta.user && state.filtersMeta.user.loggedIn);
    const modal = openModal('下载', `
      <div class="form-row"><label>分组</label><input id="dl-group" list="dl-groups" value="${escapeHtml(detail.group || '')}" placeholder="default">
        <datalist id="dl-groups">${groups.map((g) => `<option value="${escapeHtml(g)}">`).join('')}</datalist></div>
      <div class="form-row"><label>原图</label><label class="chip-check ${loggedIn ? '' : 'disabled'}" style="cursor:${loggedIn ? 'pointer' : 'not-allowed'}"><input type="checkbox" id="dl-original" ${loggedIn ? '' : 'disabled'}>下载原图</label></div>
      <div class="form-row"><label>格式</label><label class="chip-check"><input type="checkbox" id="dl-cbz">打包为 CBZ</label></div>
      <div class="modal-actions"><button class="btn" data-close-modal>取消</button><button class="btn primary" id="dl-start">开始下载</button></div>
    `);
    $('#dl-cbz').checked = !!(state.settings && state.settings.downloadAsCbz);
    $('#dl-start').onclick = async () => {
      const button = $('#dl-start');
      button.disabled = true;
      button.textContent = '加入队列...';
      try {
        const result = await api('/api/download', {
          method: 'POST',
          body: JSON.stringify({
            url: detail.url,
            group: $('#dl-group').value || undefined,
            original: $('#dl-original').checked,
            cbz: $('#dl-cbz').checked,
          }),
        });
        closeModal();
        toast(result.alreadyExists ? '该画廊已在下载队列中' : '已加入下载队列');
      } catch (error) {
        toast('下载失败：' + error.message);
        button.disabled = false;
        button.textContent = '开始下载';
      }
    };
  }

  function openFavoriteDialog(detail) {
    const names = (state.filtersMeta && state.filtersMeta.favorites) || ['Favorite 0'];
    const colors = ['#9e9e9e', '#fc4e4e', '#fcb417', '#dde500', '#17b91b', '#36b940', '#68c9de', '#5050d7', '#9755f5', '#fe93ff'];
    const selected = detail.favoriteTagIndex == null ? 0 : detail.favoriteTagIndex;
    openModal('收藏', `
      <div class="fav-grid" id="fav-grid">
        ${names.map((name, index) => `<label class="fav-option"><input type="radio" name="fav" value="${index}" ${selected === index ? 'checked' : ''}><span class="fav-dot" style="background:${colors[index] || '#9e9e9e'}"></span>${escapeHtml(name)}</label>`).join('')}
      </div>
      <div class="form-row" style="margin-top:12px"><label>备注</label><input id="fav-note" type="text" placeholder="可选备注" style="flex:1"></div>
      <div class="modal-actions">
        ${detail.isFavorite ? '<button class="btn danger" id="fav-remove">取消收藏</button>' : ''}
        <button class="btn primary" id="fav-save">确定</button>
      </div>
    `);
    if (detail.isFavorite) {
      $('#fav-remove').onclick = async () => {
        try {
          await api('/api/favorite', { method: 'POST', body: JSON.stringify({ url: detail.url, remove: true }) });
          closeModal();
          toast('已取消收藏');
          detail.isFavorite = false;
          renderDetail(detail);
        } catch (error) { toast('操作失败：' + error.message); }
      };
    }
    $('#fav-save').onclick = async () => {
      const index = Number($('#fav-grid input:checked').value);
      try {
        await api('/api/favorite', { method: 'POST', body: JSON.stringify({ url: detail.url, favcat: index, note: $('#fav-note').value }) });
        closeModal();
        toast('已收藏');
        detail.isFavorite = true;
        detail.favoriteTagIndex = index;
        renderDetail(detail);
      } catch (error) { toast('收藏失败：' + error.message); }
    };
  }

  function openRatingDialog(detail) {
    let rating = Number(detail.userRating || detail.rating || 0);
    if (rating > 5) rating = rating / 2;
    rating = Math.round(rating);
    const modal = openModal('评分', `
      <div class="rating-stars" id="rating-stars">${[1, 2, 3, 4, 5].map((n) => `<span class="mi ${n <= rating ? 'mi-star' : 'mi-star_border'}" data-rating="${n}"></span>`).join('')}</div>
      <div class="muted" style="text-align:center" id="rating-label">${rating ? rating + ' 星' : '请选择评分'}</div>
      <div class="modal-actions"><button class="btn primary" id="rating-save">提交</button></div>
    `);
    let value = rating;
    const update = () => {
      $$('#rating-stars [data-rating]').forEach((star) => {
        const n = Number(star.dataset.rating);
        star.className = 'mi ' + (n <= value ? 'mi-star' : 'mi-star_border');
      });
      $('#rating-label').textContent = value ? value + ' 星' : '请选择评分';
    };
    $$('#rating-stars [data-rating]').forEach((star) => {
      star.onclick = () => { value = Number(star.dataset.rating); update(); };
    });
    $('#rating-save').onclick = async () => {
      if (!value) return;
      try {
        await api('/api/rating', { method: 'POST', body: JSON.stringify({ url: detail.url, rating: value, apikey: detail.apikey }) });
        closeModal();
        toast('评分成功');
        detail.userRating = value;
        detail.hasRated = true;
        openDetail(detail.url);
      } catch (error) { toast('评分失败：' + error.message); }
    };
  }

  async function openArchiveDialog(detail) {
    openLoadingModal('归档下载');
    try {
      const info = await api('/api/archive?archiveUrl=' + encodeURIComponent(detail.archivePageUrl));
      const groups = (state.filtersMeta && state.filtersMeta.archiveGroups) || [];
      openModal('归档下载', `
        <div class="modal-list">
          <div class="modal-list-item">
            <div class="grow"><div>原始归档</div><div class="small">${escapeHtml(info.originalSize || '')} · ${escapeHtml(info.originalCost || '')}</div></div>
            <button class="btn small primary" data-archive="original">下载</button>
          </div>
          ${info.resampleSize ? `<div class="modal-list-item">
            <div class="grow"><div>重采样归档</div><div class="small">${escapeHtml(info.resampleSize || '')} · ${escapeHtml(info.resampleCost || '')}</div></div>
            <button class="btn small" data-archive="resample">下载</button>
          </div>` : ''}
          <div class="form-row"><label>分组</label><input id="archive-group" list="archive-groups" style="flex:1"><datalist id="archive-groups">${groups.map((g) => `<option value="${escapeHtml(g)}">`).join('')}</datalist></div>
        </div>
        <p class="muted">下载和解压由 App 完成，可在「下载 → 归档」查看进度。</p>
      `);
      $$('[data-archive]').forEach((button) => {
        button.onclick = async () => {
          button.disabled = true;
          try {
            await api('/api/archive/download', {
              method: 'POST',
              body: JSON.stringify({ url: detail.url, original: button.dataset.archive === 'original', group: $('#archive-group').value || undefined }),
            });
            closeModal();
            toast('归档下载已开始');
          } catch (error) { toast('失败：' + error.message); button.disabled = false; }
        };
      });
    } catch (error) {
      openModal('归档下载', `<div class="empty">无法获取归档信息：${escapeHtml(error.message)}</div>`);
    }
  }

  async function openHHDialog(detail) {
    openLoadingModal('H@H 下载');
    try {
      const info = await api('/api/hh?archiveUrl=' + encodeURIComponent(detail.archivePageUrl));
      openModal('H@H 下载', `
        <div class="modal-list">
          ${(info.archives || []).map((archive) => `<div class="modal-list-item">
            <div class="grow"><div>${escapeHtml(archive.resolutionDesc)}</div><div class="small">${escapeHtml(archive.size)} · ${escapeHtml(archive.cost)}</div></div>
            <button class="btn small" data-hh="${escapeHtml(archive.resolution || '')}">下载</button>
          </div>`).join('')}
        </div>
      `);
      $$('[data-hh]').forEach((button) => {
        button.onclick = async () => {
          button.disabled = true;
          try {
            const result = await api('/api/hh', { method: 'POST', body: JSON.stringify({ archiveUrl: detail.archivePageUrl, resolution: button.dataset.hh }) });
            closeModal();
            toast(result.result || 'H@H 下载请求已发送');
          } catch (error) { toast('失败：' + error.message); button.disabled = false; }
        };
      });
    } catch (error) {
      openModal('H@H 下载', `<div class="empty">无法获取 H@H 信息：${escapeHtml(error.message)}</div>`);
    }
  }

  async function openTorrentsDialog(detail) {
    openLoadingModal('种子');
    try {
      const data = await api('/api/torrents?url=' + encodeURIComponent(detail.url));
      openModal('种子', `
        <div class="modal-list">
          ${(data.torrents || []).map((torrent) => `<div class="modal-list-item">
            <div class="grow">
              <div>${escapeHtml(torrent.title)}</div>
              <div class="small">${escapeHtml(torrent.size)} · ${torrent.seeds}↑ ${torrent.peers}↓ · ${escapeHtml(torrent.postTime)}</div>
            </div>
            <a class="btn small" href="${escapeHtml(torrent.torrentUrl)}" target="_blank" rel="noreferrer">种子</a>
            <a class="btn small" href="${escapeHtml(torrent.magnetUrl)}">磁力</a>
          </div>`).join('') || '<div class="muted">暂无种子</div>'}
        </div>`, { wide: true });
    } catch (error) {
      openModal('种子', `<div class="empty">无法获取种子：${escapeHtml(error.message)}</div>`);
    }
  }

  async function openStatsDialog(detail) {
    openLoadingModal('统计');
    try {
      const stats = await api('/api/stats?url=' + encodeURIComponent(detail.url));
      const cell = (k, v) => `<div class="stat-cell"><div class="v">${escapeHtml(v == null ? '-' : v)}</div><div class="k">${escapeHtml(k)}</div></div>`;
      const bars = (list, label) => {
        const items = (list || []).slice(0, 12);
        const max = Math.max(1, ...items.map((x) => Number(x.visits) || 0));
        return `<h3 style="margin-top:18px">${label}</h3><div class="stat-grid">${items.map((item) => `<div class="stat-cell"><div class="v">${escapeHtml(item.visits)}</div><div class="k">${escapeHtml(item.period)}</div><div class="progress"><span style="width:${Math.min(100, ((Number(item.visits) || 0) / max) * 100)}%"></span></div></div>`).join('')}</div>`;
      };
      openModal('统计', `
        <div class="stat-grid">
          ${cell('总访问', stats.totalVisits)}
          ${cell('总榜排名', stats.allTimeRanking)}
          ${cell('年榜排名', stats.yearRanking)}
          ${cell('月榜排名', stats.monthRanking)}
          ${cell('日榜排名', stats.dayRanking)}
        </div>
        ${bars(stats.daily, '日统计')}
        ${bars(stats.monthly, '月统计')}
        ${bars(stats.yearly, '年统计')}
      `, { wide: true });
    } catch (error) {
      openModal('统计', `<div class="empty">无法获取统计：${escapeHtml(error.message)}</div>`);
    }
  }

  function openCommentDialog(detail, commentId) {
    openModal(commentId == null ? '写评论' : '编辑评论', `
      <textarea id="comment-text" placeholder="输入评论内容"></textarea>
      <p class="muted">请遵守 E-Hentai 的评论规则。</p>
      <div class="modal-actions"><button class="btn primary" id="comment-save">提交</button></div>
    `);
    $('#comment-save').onclick = async () => {
      const content = $('#comment-text').value.trim();
      if (!content) return;
      try {
        const result = await api('/api/comment', { method: 'POST', body: JSON.stringify({ url: detail.url, content, commentId }) });
        if (!result.ok) { toast(result.error || '提交失败'); return; }
        closeModal();
        toast('评论已提交');
        openDetail(detail.url);
      } catch (error) { toast('提交失败：' + error.message); }
    };
  }

  // ---------------- reader ----------------

  async function startOnlineReader(detail) {
    const progress = Number(detail.readProgress || 0);
    state.reader = {
      kind: 'online',
      detail,
      gid: detail.gid,
      title: detail.title,
      pageCount: detail.pageCount,
      hrefs: [],
      loadedPages: -1,
      index: progress,
      view: localStorage.getItem('jh_reader_view') || 'vertical',
      imageUrlCache: new Map(),
    };
    document.body.classList.add('reader-open');
    $('#reader-pane').hidden = false;
    $('#detail-pane').style.visibility = 'hidden';
    $('#reader-pane').innerHTML = '<div class="loading"><div class="spinner"></div><span>加载中...</span></div>';
    await loadOnlineReaderPage(0);
    while (state.reader.hrefs.length <= state.reader.index && state.reader.loadedPages < state.reader.detail.thumbnailsPageCount - 1) {
      await loadOnlineReaderPage(state.reader.loadedPages + 1);
    }
    if (!state.reader.hrefs.length) {
      closeReader();
      toast('无法加载该画廊的图片');
      return;
    }
    renderReader();
  }

  async function startLocalReader({ gid, title, pageCount, images, cbzUrl }) {
    state.reader = {
      kind: 'local',
      gid,
      title,
      pageCount: pageCount || images.length,
      images,
      index: 0,
      view: localStorage.getItem('jh_reader_view') || 'vertical',
      cbzUrl,
    };
    document.body.classList.add('reader-open');
    $('#reader-pane').hidden = false;
    $('#detail-pane').style.visibility = 'hidden';
    try {
      const progress = await api('/api/progress?gid=' + gid);
      state.reader.index = Math.min(progress.index || 0, Math.max(0, images.length - 1));
    } catch (_) {}
    renderReader();
  }

  async function loadOnlineReaderPage(pageIndex) {
    const reader = state.reader;
    if (!reader || reader.kind !== 'online') return;
    const data = await api(`/api/read/pages?url=${encodeURIComponent(reader.detail.url)}&index=${pageIndex}`);
    reader.hrefs.push(...(data.thumbnails || []).map((t) => t.href));
    reader.loadedPages = pageIndex;
  }

  function readerImageUrl(reader, index) {
    if (reader.kind === 'local') return withToken(reader.images[index].url);
    return null;
  }

  async function resolveOnlineImage(href) {
    const reader = state.reader;
    if (reader.imageUrlCache.has(href)) return reader.imageUrlCache.get(href);
    const data = await api('/api/read/image?href=' + encodeURIComponent(href));
    const url = proxyUrl(data.url || data.originalImageUrl);
    reader.imageUrlCache.set(href, url);
    return url;
  }

  function renderReader() {
    const reader = state.reader;
    if (!reader) return;
    const total = reader.kind === 'online' ? reader.detail.pageCount : reader.images.length;
    $('#reader-pane').innerHTML = `
      <div class="reader-bar">
        <button class="icon-btn" id="reader-back">${icon('arrow_back')}</button>
        <span class="title">${escapeHtml(reader.title)}</span>
        <span class="muted" id="reader-index">${reader.index + 1} / ${total}</span>
        <span style="flex:1"></span>
        <button class="btn small" id="reader-view">${reader.view === 'vertical' ? '单页' : '滚动'}</button>
        ${reader.cbzUrl ? `<a class="btn small primary" href="${withToken(reader.cbzUrl)}" target="_blank">CBZ</a>` : ''}
        <button class="icon-btn" id="reader-close">${icon('close')}</button>
      </div>
      <div class="reader-stage" id="reader-stage"></div>`;
    $('#reader-back').onclick = closeReader;
    $('#reader-close').onclick = closeReader;
    $('#reader-view').onclick = () => {
      reader.view = reader.view === 'vertical' ? 'single' : 'vertical';
      renderReader();
    };
    renderReaderStage();
  }

  function renderReaderStage() {
    const reader = state.reader;
    const stage = $('#reader-stage');
    if (!stage) return;
    if (reader.view === 'single') {
      stage.innerHTML = `<div class="reader-single"><img id="reader-single-img" alt=""></div>`;
      loadReaderSingle();
      return;
    }
    stage.innerHTML = '<div class="reader-vertical" id="reader-vertical"></div>';
    ensureReaderItems();
    const container = $('#reader-vertical');
    const first = container.children[reader.index];
    if (first) first.scrollIntoView({ block: 'start' });
  }

  function ensureReaderItems() {
    const reader = state.reader;
    const container = $('#reader-vertical');
    if (!container) return;
    const count = reader.kind === 'online' ? reader.hrefs.length : reader.images.length;
    while (container.children.length < count) {
      const i = container.children.length;
      const wrapper = document.createElement('div');
      wrapper.className = 'reader-page-wrap';
      wrapper.dataset.index = String(i);
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.dataset.index = String(i);
      wrapper.appendChild(img);
      container.appendChild(wrapper);
    }
    lazyLoadReaderImages();
  }

  let readerImageObserver = null;
  function loadReaderImage(img) {
    const reader = state.reader;
    if (!reader || img.dataset.loaded) return;
    const index = Number(img.dataset.index);
    img.dataset.loaded = '1';
    if (reader.kind === 'local') {
      img.src = readerImageUrl(reader, index);
      return;
    }
    resolveOnlineImage(reader.hrefs[index]).then((url) => { img.src = url; }).catch(() => { img.alt = '加载失败'; });
  }

  function lazyLoadReaderImages() {
    const reader = state.reader;
    const container = $('#reader-vertical');
    if (!reader || !container) return;
    const start = Math.max(0, reader.index - 1);
    const end = Math.min(container.children.length - 1, reader.index + 4);
    for (let i = start; i <= end; i++) {
      const img = container.children[i] && container.children[i].querySelector('img');
      if (img) loadReaderImage(img);
    }
    if (!readerImageObserver) {
      readerImageObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            readerImageObserver.unobserve(entry.target);
            loadReaderImage(entry.target);
          }
        }
      }, { root: $('#reader-stage'), rootMargin: '900px 0px' });
    }
    $$('#reader-vertical img[data-index]:not([data-loaded])').forEach((img) => readerImageObserver.observe(img));
  }

  async function loadReaderSingle() {
    const reader = state.reader;
    const img = $('#reader-single-img');
    if (!img) return;
    try {
      img.src = reader.kind === 'local' ? readerImageUrl(reader, reader.index) : await resolveOnlineImage(reader.hrefs[reader.index]);
    } catch (error) {
      img.alt = '图片加载失败';
    }
    $('#reader-index').textContent = `${reader.index + 1} / ${reader.kind === 'online' ? reader.detail.pageCount : reader.images.length}`;
    saveProgress();
  }

  function readerGo(index) {
    const reader = state.reader;
    if (!reader) return;
    const total = reader.kind === 'online' ? reader.detail.pageCount : reader.images.length;
    reader.index = Math.max(0, Math.min(total - 1, index));
    if (reader.kind === 'online' && reader.index >= reader.hrefs.length && reader.loadedPages < reader.detail.thumbnailsPageCount - 1) {
      loadOnlineReaderPage(reader.loadedPages + 1).then(() => { ensureReaderItems(); readerGo(reader.index); });
      return;
    }
    if (reader.view === 'single') {
      loadReaderSingle();
    } else {
      ensureReaderItems();
      const el = $('#reader-vertical')?.children[reader.index];
      if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      $('#reader-index').textContent = `${reader.index + 1} / ${total}`;
      saveProgress();
    }
  }

  let progressTimer = null;
  function saveProgress() {
    const reader = state.reader;
    if (!reader || !reader.gid || reader.gid <= 0) return;
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      api('/api/progress?gid=' + encodeURIComponent(reader.gid), { method: 'POST', body: JSON.stringify({ index: reader.index }) }).catch(() => {});
    }, 400);
  }

  function closeReader() {
    state.reader = null;
    document.body.classList.remove('reader-open');
    $('#reader-pane').hidden = true;
    $('#reader-pane').innerHTML = '';
    $('#detail-pane').style.visibility = 'visible';
  }

  document.addEventListener('keydown', (event) => {
    if (!state.reader) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); readerGo(state.reader.index - (state.reader.view === 'single' ? 1 : 1)); }
    if (event.key === 'ArrowRight') { event.preventDefault(); readerGo(state.reader.index + 1); }
    if (event.key === 'Escape') closeReader();
  });

  // track current page while scrolling vertical reader
  document.addEventListener('scroll', (event) => {
    const reader = state.reader;
    if (!reader || reader.view !== 'vertical') return;
    if (event.target && event.target.id === 'reader-stage') {
      const items = $$('#reader-vertical .reader-page-wrap');
      let current = reader.index;
      const top = event.target.getBoundingClientRect().top;
      for (const item of items) {
        const rect = item.getBoundingClientRect();
        if (rect.bottom > top + 80) { current = Number(item.dataset.index); break; }
      }
      if (current !== reader.index) {
        reader.index = current;
        $('#reader-index').textContent = `${current + 1} / ${reader.kind === 'online' ? reader.detail.pageCount : reader.images.length}`;
        lazyLoadReaderImages();
        saveProgress();
      }
      if (event.target.scrollTop + event.target.clientHeight >= event.target.scrollHeight - 1200) {
        if (reader.kind === 'online' && reader.loadedPages < reader.detail.thumbnailsPageCount - 1) {
          loadOnlineReaderPage(reader.loadedPages + 1).then(ensureReaderItems);
        }
      }
    }
  }, true);

  // ---------------- downloads ----------------

  function renderDownloadPage() {
    const tabs = [['gallery', '下载'], ['archive', '归档'], ['local', '本地']];
    $('#toolbar').innerHTML = toolbarBase('下载', '', `
      <div class="segmented" id="download-tabs">${tabs.map(([key, label]) => `<button data-download-tab="${key}" class="${state.downloadTab === key ? 'active' : ''}">${label}</button>`).join('')}</div>
      ${refreshButton()}
    `);
    $('#content').innerHTML = '<div id="download-body"><div class="loading"><div class="spinner"></div><span>加载中...</span></div></div>';
    $$('#download-tabs [data-download-tab]').forEach((button) => {
      button.onclick = () => { state.downloadTab = button.dataset.downloadTab; renderDownloadPage(); };
    });
    $$('#toolbar [data-page-action]').forEach((btn) => btn.onclick = () => renderDownloadPage());
    if (state.downloadTab === 'gallery') loadDownloadTasks();
    else if (state.downloadTab === 'archive') loadArchiveTasks();
    else loadLocalGalleries();
  }

  function groupMap(items, keyFn) {
    const map = new Map();
    for (const item of items) {
      const key = keyFn(item) || 'default';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
    return map;
  }

  function taskRow(task) {
    const percent = task.total ? Math.min(100, Math.round((task.downloaded / task.total) * 100)) : 0;
    const status = STATUS_LABELS[task.status] || task.status;
    const actions = [];
    if (task.status === 'downloading') actions.push(`<button class="btn small" data-task-action="pause" data-gid="${task.gid}">${icon('pause')}</button>`);
    if (task.status === 'paused') actions.push(`<button class="btn small" data-task-action="resume" data-gid="${task.gid}">${icon('play_arrow')}</button>`);
    if (task.status === 'downloaded') actions.push(`<button class="btn small" data-task-action="read" data-gid="${task.gid}" data-title="${escapeHtml(task.title)}">${icon('visibility')}</button>`);
    if (task.status === 'downloaded') actions.push(`<a class="btn small" href="${withToken('/api/library/' + task.gid + '/cbz')}" target="_blank">CBZ</a>`);
    actions.push(`<button class="btn small danger" data-task-action="delete" data-gid="${task.gid}">${icon('delete')}</button>`);
    return `<div class="task-row">
      <img class="task-cover" loading="lazy" src="${withToken(task.cover)}" alt="">
      <div class="task-body">
        <div class="task-title">${escapeHtml(task.title)}</div>
        <div class="task-sub"><span class="status-pill ${escapeHtml(task.status)}">${escapeHtml(status)}</span><span>${task.downloaded}/${task.total}</span><span>${task.speed || ''}</span>${task.hasCbz ? '<span class="status-pill">CBZ</span>' : ''}</div>
        <div class="progress"><span style="width:${percent}%"></span></div>
      </div>
      <div class="task-actions">${actions.join('')}</div>
    </div>`;
  }

  async function loadDownloadTasks() {
    try {
      const data = await api('/api/tasks');
      const map = groupMap(data.tasks || [], (t) => t.group);
      const html = Array.from(map.entries()).map(([group, tasks]) => `
        <div class="download-group">
          <div class="group-head">${icon('folder')}<span>${escapeHtml(group)}</span><span class="count">${tasks.length}</span></div>
          ${tasks.map(taskRow).join('')}
        </div>`).join('') || '<div class="empty">暂无下载任务</div>';
      $('#download-body').innerHTML = html;
      bindTaskActions();
    } catch (error) {
      $('#download-body').innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}</div>`;
    }
  }

  function archiveRow(task) {
    const percent = task.size ? Math.min(100, Math.round((task.downloaded / task.size) * 100)) : 0;
    const status = STATUS_LABELS[task.status] || task.status;
    const actions = [];
    if (task.status === 'downloading' || task.status === 'unpacking') actions.push(`<button class="btn small" data-archive-action="pause" data-gid="${task.gid}">${icon('pause')}</button>`);
    if (task.status === 'paused' || task.status === 'needReUnlock') actions.push(`<button class="btn small" data-archive-action="resume" data-gid="${task.gid}">${icon('play_arrow')}</button>`);
    if (task.hasFiles && task.status === 'completed') actions.push(`<button class="btn small" data-archive-action="read" data-gid="${task.gid}" data-title="${escapeHtml(task.title)}">${icon('visibility')}</button>`);
    actions.push(`<button class="btn small danger" data-archive-action="delete" data-gid="${task.gid}">${icon('delete')}</button>`);
    return `<div class="task-row">
      <img class="task-cover" loading="lazy" src="${withToken(task.cover)}" alt="">
      <div class="task-body">
        <div class="task-title">${escapeHtml(task.title)}</div>
        <div class="task-sub"><span class="status-pill ${escapeHtml(task.status)}">${escapeHtml(status)}</span><span>${fmtBytes(task.downloaded)} / ${fmtBytes(task.size)}</span>${task.isOriginal ? '<span>原档</span>' : '<span>重采样</span>'}</div>
        <div class="progress"><span style="width:${percent}%"></span></div>
      </div>
      <div class="task-actions">${actions.join('')}</div>
    </div>`;
  }

  async function loadArchiveTasks() {
    try {
      const data = await api('/api/archive-tasks');
      const map = groupMap(data.tasks || [], (t) => t.group);
      const html = Array.from(map.entries()).map(([group, tasks]) => `
        <div class="download-group">
          <div class="group-head">${icon('archive')}<span>${escapeHtml(group)}</span><span class="count">${tasks.length}</span></div>
          ${tasks.map(archiveRow).join('')}
        </div>`).join('') || '<div class="empty">暂无归档任务</div>';
      $('#download-body').innerHTML = html;
      bindTaskActions();
    } catch (error) {
      $('#download-body').innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}</div>`;
    }
  }

  async function loadLocalGalleries() {
    try {
      const [library, local] = await Promise.all([
        api('/api/library?all=1'),
        api('/api/local-galleries').catch(() => ({ galleries: [] })),
      ]);
      const libraryItems = (library.galleries || []).filter((g) => g.status === 'downloaded');
      const localItems = local.galleries || [];
      const html = `
        <div class="download-group">
          <div class="group-head">${icon('download')}<span>App 下载</span><span class="count">${libraryItems.length}</span></div>
          ${libraryItems.map((gallery) => `<div class="g-row" data-library-gid="${gallery.gid}" data-library-title="${escapeHtml(gallery.title)}">
            <div class="g-row-cover"><img loading="lazy" src="${withToken(gallery.cover)}" alt=""></div>
            <div class="g-row-body"><div class="g-row-title">${escapeHtml(gallery.title)}</div><div class="g-row-sub">${escapeHtml(gallery.category || '')} · ${gallery.downloaded}/${gallery.total}</div><div class="g-row-footer"><span class="cat-badge" style="background:${categoryColor(gallery.category)}">${escapeHtml(gallery.category || '')}</span>${gallery.hasCbz ? '<span class="status-pill">CBZ</span>' : ''}</div></div>
          </div>`).join('') || '<div class="empty">暂无</div>'}
        </div>
        <div class="download-group">
          <div class="group-head">${icon('folder')}<span>本地目录</span><span class="count">${localItems.length}</span></div>
          ${localItems.map((gallery) => `<div class="g-row" data-local-path="${escapeHtml(gallery.path)}" data-library-title="${escapeHtml(gallery.title)}">
            <div class="g-row-cover"><img loading="lazy" src="${withToken(gallery.cover)}" alt=""></div>
            <div class="g-row-body"><div class="g-row-title">${escapeHtml(gallery.title)}</div><div class="g-row-sub">${escapeHtml(gallery.path)}</div></div>
          </div>`).join('') || '<div class="empty">暂无本地目录</div>'}
        </div>`;
      $('#download-body').innerHTML = html;
      $$('#download-body [data-library-gid]').forEach((row) => {
        row.onclick = () => openLibraryReader(Number(row.dataset.libraryGid), row.dataset.libraryTitle);
      });
      $$('#download-body [data-local-path]').forEach((row) => {
        row.onclick = () => openLocalFolderReader(row.dataset.localPath, row.dataset.libraryTitle);
      });
    } catch (error) {
      $('#download-body').innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}</div>`;
    }
  }

  function bindTaskActions() {
    $$('#download-body [data-task-action]').forEach((button) => {
      button.onclick = async () => {
        const gid = button.dataset.gid;
        const action = button.dataset.taskAction;
        if (action === 'read') { openLibraryReader(Number(gid), button.dataset.title || ''); return; }
        if (action === 'delete' && !confirm('删除任务及本地文件？')) return;
        button.disabled = true;
        try {
          await api('/api/tasks/' + gid + '/' + action, { method: 'POST' });
          loadDownloadTasks();
        } catch (error) { toast('操作失败：' + error.message); button.disabled = false; }
      };
    });
    $$('#download-body [data-archive-action]').forEach((button) => {
      button.onclick = async () => {
        const gid = button.dataset.gid;
        const action = button.dataset.archiveAction;
        if (action === 'read') { openArchiveReader(Number(gid), button.dataset.title || ''); return; }
        if (action === 'delete' && !confirm('删除归档任务及文件？')) return;
        button.disabled = true;
        try {
          await api('/api/archive-tasks/' + gid + '/' + action, { method: 'POST' });
          loadArchiveTasks();
        } catch (error) { toast('操作失败：' + error.message); button.disabled = false; }
      };
    });
  }

  async function openLibraryReader(gid, title) {
    openLoadingModal('加载画廊');
    try {
      const data = await api('/api/library/' + gid + '/images');
      closeModal();
      const images = (data.images || []).filter((image) => image.local).map((image) => ({ url: '/api/library/' + gid + '/file/' + image.serialNo }));
      if (!images.length) { toast('没有可读取的本地图片'); return; }
      await startLocalReader({ gid, title: data.title || title, pageCount: data.pageCount, images, cbzUrl: '/api/library/' + gid + '/cbz' });
    } catch (error) { closeModal(); toast('打开失败：' + error.message); }
  }

  async function openArchiveReader(gid, title) {
    openLoadingModal('加载归档');
    try {
      const data = await api('/api/archive-library/' + gid + '/images');
      closeModal();
      const images = (data.images || []).map((image) => ({ url: image.url }));
      if (!images.length) { toast('没有可读取的图片'); return; }
      await startLocalReader({ gid, title: data.title || title, pageCount: data.pageCount, images });
    } catch (error) { closeModal(); toast('打开失败：' + error.message); }
  }

  async function openLocalFolderReader(path, title) {
    openLoadingModal('加载本地画廊');
    try {
      const data = await api('/api/local-galleries/images?path=' + encodeURIComponent(path));
      closeModal();
      const images = (data.images || []).map((image) => ({ url: image.url }));
      if (!images.length) { toast('没有图片'); return; }
      await startLocalReader({ gid: 0, title: data.title || title, pageCount: images.length, images });
    } catch (error) { closeModal(); toast('打开失败：' + error.message); }
  }

  // ---------------- settings ----------------

  async function renderSettingsPage() {
    $('#toolbar').innerHTML = toolbarBase('设置', '', '');
    $('#content').innerHTML = '<div class="loading"><div class="spinner"></div><span>加载中...</span></div>';
    try {
      const [appearance, settings, filters, network] = await Promise.all([
        api('/api/appearance'),
        api('/api/settings'),
        api('/api/filters'),
        api('/api/network').catch(() => null),
      ]);
      state.appearance = appearance;
      state.settings = settings;
      state.filtersMeta = filters;
      state.network = network;
      renderSettingsNav();
    } catch (error) {
      $('#content').innerHTML = `<div class="empty">加载设置失败：${escapeHtml(error.message)}</div>`;
    }
  }

  function renderSettingsNav() {
    const user = (state.filtersMeta && state.filtersMeta.user) || {};
    const app = state.appearance || {};
    const settings = state.settings || {};
    const items = [
      ['account', 'account_circle', '账户', user.loggedIn ? (user.nickName || user.userName || '已登录') : '未登录'],
      ['eh', 'language', 'EH', `当前站点 ${app.site || 'EH'}`],
      ['style', 'palette', '样式', `主题 ${app.themeMode === 'dark' ? '深色' : app.themeMode === 'light' ? '浅色' : '跟随系统'}`],
      ['read', 'auto_stories', '阅读', '阅读进度与 App 同步'],
      ['preference', 'favorite', '偏好', `默认列表 ${state.listMode === 'grid' ? '网格' : '列表'}`],
      ['network', 'wifi', '网络', state.network ? `代理 ${state.network.proxyType}` : '读取失败'],
      ['download', 'download', '下载', settings.downloadAsCbz ? '已完成 CBZ 打包' : '下载设置'],
      ['webserver', 'dns', 'Web 服务器', settings.running ? '运行中' : '已停止'],
      ['advanced', 'settings', '高级', '日志、缓存、更新请在 App 中修改'],
      ['security', 'security', '安全', '应用锁、隐私设置请在 App 中修改'],
      ['about', 'info', '关于', 'JHenTai Web UI'],
    ];
    $('#toolbar').innerHTML = toolbarBase('设置', '', '');
    $('#content').innerHTML = `<div class="settings-list">
      ${items.map(([key, ico, title, sub]) => `<div class="setting-item" data-setting="${key}">
        ${icon(ico)}<div class="label">${escapeHtml(title)}<small>${escapeHtml(sub || '')}</small></div>${icon('chevron_right')}
      </div>`).join('')}
      <div class="muted" style="font-size:12px;padding:20px 16px">Web UI 与 App 共用同一个 E-Hentai 会话、下载队列和本地书库。</div>
    </div>`;
    $$('#content [data-setting]').forEach((item) => {
      item.onclick = () => renderSettingSection(item.dataset.setting);
    });
  }

  function settingsSubToolbar(title) {
    $('#toolbar').innerHTML = `<button class="icon-btn" data-back-settings>${icon('arrow_back')}</button><div class="title">${escapeHtml(title)}</div>`;
    const back = $('[data-back-settings]');
    if (back) back.onclick = renderSettingsNav;
  }

  function settingsSaveButton(label = '保存') {
    return `<div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn primary" id="section-save">${label}</button></div>`;
  }

  async function renderSettingSection(key) {
    const app = state.appearance || {};
    const settings = state.settings || {};
    const network = state.network || {};
    const user = (state.filtersMeta && state.filtersMeta.user) || {};
    const filters = state.filtersMeta || {};

    if (key === 'account') {
      settingsSubToolbar('账户');
      $('#content').innerHTML = `<div class="settings-card">
        <h3>账户</h3>
        <div class="form-row"><label>状态</label><span>${user.loggedIn ? escapeHtml(user.nickName || user.userName || '已登录') : '未登录'}</span></div>
        <div class="form-row"><label>用户名</label><span>${escapeHtml(user.userName || '-')}</span></div>
        <div class="form-row"><label>默认收藏夹</label><span>${user.defaultFavoriteIndex == null ? '未设置' : '收藏夹 ' + user.defaultFavoriteIndex}</span></div>
        <p class="muted" style="line-height:1.7">登录、退出和 Cookie 管理请在 App 中进行，Web UI 会直接复用 App 的登录状态。</p>
      </div>`;
      return;
    }

    if (key === 'eh') {
      settingsSubToolbar('EH');
      $('#content').innerHTML = `<div class="settings-card">
        <h3>EH 站点</h3>
        <div class="form-row"><label>站点</label><select id="eh-site">
          <option value="EH" ${app.site === 'EH' ? 'selected' : ''}>E-Hentai</option>
          <option value="EX" ${app.site === 'EX' ? 'selected' : ''}>ExHentai</option>
        </select></div>
        <p class="muted" style="line-height:1.7">ExHentai 需要已登录且拥有里站权限。标签集、图片限额等设置请在 App 中修改。</p>
      </div>${settingsSaveButton()}`;
      $('#section-save').onclick = async () => {
        try {
          await api('/api/appearance', { method: 'POST', body: JSON.stringify({ site: $('#eh-site').value }) });
          toast('站点已切换');
          state.appearance.site = $('#eh-site').value;
        } catch (error) { toast('保存失败：' + error.message); }
      };
      return;
    }

    if (key === 'style') {
      settingsSubToolbar('样式');
      $('#content').innerHTML = `<div class="settings-card">
        <h3>样式</h3>
        <div class="form-row"><label>主题</label><select id="style-theme">
          <option value="system" ${app.themeMode === 'system' ? 'selected' : ''}>跟随系统</option>
          <option value="light" ${app.themeMode === 'light' ? 'selected' : ''}>浅色</option>
          <option value="dark" ${app.themeMode === 'dark' ? 'selected' : ''}>深色</option>
        </select></div>
        <div class="form-row"><label>浅色主题色</label><input id="style-light" type="color" value="${escapeHtml(app.lightColor)}"></div>
        <div class="form-row"><label>深色主题色</label><input id="style-dark" type="color" value="${escapeHtml(app.darkColor)}"></div>
        <div class="form-row"><label>语言</label><select id="style-locale">${(app.locales || ['en_US']).map((l) => `<option value="${l}" ${app.locale === l ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>${settingsSaveButton()}`;
      $('#section-save').onclick = async () => {
        const appearance = {
          themeMode: $('#style-theme').value,
          lightColor: $('#style-light').value,
          darkColor: $('#style-dark').value,
          locale: $('#style-locale').value,
        };
        applyTheme(appearance);
        state.appearance = Object.assign({}, state.appearance, appearance);
        try {
          await api('/api/appearance', { method: 'POST', body: JSON.stringify(appearance) });
          toast('样式已保存');
        } catch (error) { toast('保存失败：' + error.message); }
      };
      return;
    }

    if (key === 'read') {
      settingsSubToolbar('阅读');
      const view = localStorage.getItem('jh_reader_view') || 'vertical';
      $('#content').innerHTML = `<div class="settings-card">
        <h3>阅读</h3>
        <div class="form-row"><label>阅读模式</label><select id="read-view">
          <option value="vertical" ${view === 'vertical' ? 'selected' : ''}>连续滚动</option>
          <option value="single" ${view === 'single' ? 'selected' : ''}>单页</option>
        </select></div>
        <div class="form-row"><label>阅读进度</label><span class="muted">与 App 的阅读进度同步</span></div>
        <p class="muted">阅读页支持左右方向键翻页，Esc 退出。</p>
      </div>${settingsSaveButton()}`;
      $('#section-save').onclick = () => {
        localStorage.setItem('jh_reader_view', $('#read-view').value);
        toast('已保存');
      };
      return;
    }

    if (key === 'preference') {
      settingsSubToolbar('偏好');
      $('#content').innerHTML = `<div class="settings-card">
        <h3>偏好</h3>
        <div class="form-row"><label>默认列表样式</label><select id="pref-list">
          <option value="grid" ${state.listMode === 'grid' ? 'selected' : ''}>网格</option>
          <option value="list" ${state.listMode === 'list' ? 'selected' : ''}>列表</option>
        </select></div>
        <p class="muted">其他偏好（标签翻译、屏蔽规则、鼠标手势等）请在 App 中修改。</p>
      </div>${settingsSaveButton()}`;
      $('#section-save').onclick = () => {
        state.listMode = $('#pref-list').value;
        localStorage.setItem('jh_list_mode', state.listMode);
        toast('已保存');
      };
      return;
    }

    if (key === 'network') {
      settingsSubToolbar('网络');
      $('#content').innerHTML = `<div class="settings-card">
        <h3>网络</h3>
        <div class="form-row"><label>代理类型</label><select id="net-type">
          ${['system', 'http', 'socks5', 'socks4', 'direct'].map((t) => `<option value="${t}" ${network.proxyType === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
        <div class="form-row"><label>代理地址</label><input id="net-address" type="text" value="${escapeHtml(network.proxyAddress || '')}" placeholder="host:port" style="flex:1"></div>
        <div class="form-row"><label>代理用户名</label><input id="net-user" type="text" value="${escapeHtml(network.proxyUsername || '')}" style="flex:1"></div>
        <div class="form-row"><label>代理密码</label><input id="net-pass" type="password" value="${escapeHtml(network.proxyPassword || '')}" style="flex:1"></div>
        <div class="form-row"><label>连接超时(ms)</label><input id="net-connect" type="number" value="${network.connectTimeout || 6000}" style="flex:1"></div>
        <div class="form-row"><label>读取超时(ms)</label><input id="net-receive" type="number" value="${network.receiveTimeout || 6000}" style="flex:1"></div>
        <div class="form-row"><label>域名前置</label><label class="switch"><input id="net-fronting" type="checkbox" ${network.enableDomainFronting ? 'checked' : ''}><span></span></label></div>
        <p class="muted">system 会读取系统代理；修改后立即生效。</p>
      </div>${settingsSaveButton()}`;
      $('#section-save').onclick = async () => {
        try {
          const body = {
            proxyType: $('#net-type').value,
            proxyAddress: $('#net-address').value,
            proxyUsername: $('#net-user').value,
            proxyPassword: $('#net-pass').value,
            connectTimeout: Number($('#net-connect').value),
            receiveTimeout: Number($('#net-receive').value),
            enableDomainFronting: $('#net-fronting').checked,
          };
          await api('/api/network', { method: 'POST', body: JSON.stringify(body) });
          state.network = Object.assign({}, network, body);
          toast('网络设置已保存');
        } catch (error) { toast('保存失败：' + error.message); }
      };
      return;
    }

    if (key === 'download') {
      settingsSubToolbar('下载');
      $('#content').innerHTML = `<div class="settings-card">
        <h3>下载</h3>
        <div class="form-row"><label>完成后打包 CBZ</label><label class="switch"><input id="dl-cbz-setting" type="checkbox" ${settings.downloadAsCbz ? 'checked' : ''}><span></span></label></div>
        <div class="form-row"><label>打包后删除图片</label><label class="switch"><input id="dl-delete-setting" type="checkbox" ${settings.deleteImagesAfterCbz ? 'checked' : ''}><span></span></label></div>
        <div class="form-row"><label>画廊分组</label><span class="muted">${(filters.groups || []).join(' / ') || 'default'}</span></div>
        <div class="form-row"><label>归档分组</label><span class="muted">${(filters.archiveGroups || []).join(' / ') || 'default'}</span></div>
      </div>${settingsSaveButton()}`;
      $('#section-save').onclick = async () => {
        try {
          await api('/api/settings', { method: 'POST', body: JSON.stringify({
            downloadAsCbz: $('#dl-cbz-setting').checked,
            deleteImagesAfterCbz: $('#dl-delete-setting').checked,
          }) });
          state.settings.downloadAsCbz = $('#dl-cbz-setting').checked;
          state.settings.deleteImagesAfterCbz = $('#dl-delete-setting').checked;
          toast('下载设置已保存');
        } catch (error) { toast('保存失败：' + error.message); }
      };
      return;
    }

    if (key === 'webserver') {
      settingsSubToolbar('Web 服务器');
      $('#content').innerHTML = `<div class="settings-card">
        <h3>Web 服务器</h3>
        <div class="form-row"><label>状态</label><span>${settings.running ? '运行中' : '已停止'} · ${escapeHtml(settings.address || '')}</span></div>
        <div class="form-row"><label>端口</label><input id="web-port" type="number" min="1" max="65535" value="${settings.port}" style="flex:1"></div>
        <div class="form-row"><label>局域网访问</label><label class="switch"><input id="web-remote" type="checkbox" ${settings.allowRemote ? 'checked' : ''}><span></span></label></div>
        <div class="form-row"><label>访问令牌</label><input id="web-token" type="password" value="${escapeHtml(settings.token || '')}" placeholder="留空则不校验" style="flex:1"></div>
        <p class="muted">修改端口或局域网访问后服务器会自动重启，当前页面可能需要重新连接。</p>
      </div>${settingsSaveButton()}`;
      $('#section-save').onclick = async () => {
        try {
          await api('/api/settings', { method: 'POST', body: JSON.stringify({
            port: Number($('#web-port').value),
            allowRemote: $('#web-remote').checked,
            token: $('#web-token').value,
          }) });
          toast('设置已保存，服务器可能正在重启');
        } catch (error) { toast('保存失败：' + error.message); }
      };
      return;
    }

    if (key === 'advanced') {
      settingsSubToolbar('高级');
      $('#content').innerHTML = `<div class="settings-card">
        <h3>高级</h3>
        <div class="form-row"><label>Web 地址</label><span>${escapeHtml((state.settings && state.settings.address) || location.origin)}</span></div>
        <div class="form-row"><label>下载任务</label><span>${galleryTaskCount()} 个</span></div>
        <div class="form-row"><label>本地画廊</label><span>${(state.library && state.library.length) || 0} 个</span></div>
        <p class="muted">日志、缓存清理、应用更新等高级功能请在 App 中操作。</p>
      </div>`;
      return;
    }

    if (key === 'security') {
      settingsSubToolbar('安全');
      $('#content').innerHTML = `<div class="settings-card">
        <h3>安全</h3>
        <p class="muted" style="line-height:1.8">当前 Web 服务器仅在局域网使用，未启用额外认证。应用锁、指纹解锁和隐私设置请在 App 中修改。</p>
      </div>`;
      return;
    }

    if (key === 'about') {
      settingsSubToolbar('关于');
      let status = {};
      try { status = await api('/api/status'); } catch (_) {}
      $('#content').innerHTML = `<div class="settings-card">
        <h3>JHenTai Web UI</h3>
        <div class="form-row"><label>服务地址</label><span>${escapeHtml((state.settings && state.settings.address) || location.origin)}</span></div>
        <div class="form-row"><label>登录状态</label><span>${status.loggedIn ? '已登录' : '未登录'}</span></div>
        <div class="form-row"><label>下载任务</label><span>${status.taskCount || 0} 个</span></div>
        <div class="form-row"><label>CBZ 打包</label><span>${status.downloadAsCbz ? '开启' : '关闭'}</span></div>
        <p class="muted">JHenTai Web UI 复用桌面 App 的服务、会话与下载队列。</p>
      </div>`;
      return;
    }
  }

  function galleryTaskCount() {
    return (state.filtersMeta && state.filtersMeta.taskCount) || 0;
  }

  // ---------------- polling ----------------

  function startPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (state.tab === 'download' && state.downloadTab === 'gallery') loadDownloadTasks();
      if (state.tab === 'download' && state.downloadTab === 'archive') loadArchiveTasks();
    }, 3000);
  }

  // ---------------- init ----------------

  async function init() {
    try {
      const [appearance, filters, settings] = await Promise.all([
        api('/api/appearance'),
        api('/api/filters'),
        api('/api/settings'),
      ]);
      state.appearance = appearance;
      state.filtersMeta = filters;
      state.settings = settings;
      if (filters.defaultGroup) state.gallery.group = filters.defaultGroup;
      applyTheme(appearance);
    } catch (_) {}

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.appearance.themeMode === 'system') applyTheme(state.appearance);
    });

    // splitter
    const splitter = $('#splitter');
    const rightPane = $('#right-pane');
    let dragging = false;
    splitter.addEventListener('mousedown', (event) => {
      if (window.innerWidth <= 760) return;
      dragging = true;
      event.preventDefault();
      document.body.style.cursor = 'col-resize';
    });
    window.addEventListener('mousemove', (event) => {
      if (!dragging) return;
      const width = Math.max(320, Math.min(window.innerWidth * 0.65, window.innerWidth - event.clientX));
      rightPane.style.width = width + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
    });

    // infinite scroll
    $('#content').addEventListener('scroll', () => {
      const el = $('#content');
      if (state.tab === 'ranklist' || state.tab === 'history' || state.tab === 'download' || state.tab === 'setting') return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 500) {
        if (state.gallery.nextGid && !state.gallery.loading) loadGalleries(false);
      }
    });

    startPolling();
    showTab('home');
  }

  init();
})();
