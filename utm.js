/* ==========================================================
   UTM-метки: разбор, группировка и правка меток во всех ссылках письма.

   Отдельный модуль. Работает только через window.EmailLinksApp (см. app.js).
   Отключить: убрать в index.html подключение utm.css и utm.js — больше ничего.
   ========================================================== */
(() => {
  'use strict';

  const app = window.EmailLinksApp;
  if (!app) return;

  const IS_MARK = /^utm_/i;               // какие параметры считаем метками
  const TAB_KEY = 'elk:linksTab';
  // Шаблонные вставки рассыльщиков и трекеров: ${Recipient.Id}, @{…}, {logid}. Не кодируем и не трогаем.
  const TEMPLATE = /(\$\{[^}]*\}|@\{[^}]*\}|\{[^{}]*\})/;

  /* ---------- Разбор ссылки ----------
     Ссылку не пересобираем стандартными средствами браузера: работаем с сырой строкой,
     чтобы сохранить исходную кодировку, порядок параметров и шаблонные вставки. */

  function parseHref(href) {
    if (!href) return null;
    const q = href.indexOf('?');
    if (q < 0) return null;
    let end = href.indexOf('#', q);
    if (end < 0) end = href.length;
    const parts = href.slice(q + 1, end).split('&').map((piece) => {
      const i = piece.indexOf('=');
      return i < 0 ? { name: piece, raw: null } : { name: piece.slice(0, i), raw: piece.slice(i + 1) };
    });
    return { base: href.slice(0, q), parts, hash: href.slice(end) };
  }

  function buildHref(h) {
    return `${h.base}?${h.parts.map((p) => (p.raw == null ? p.name : `${p.name}=${p.raw}`)).join('&')}${h.hash}`;
  }

  // Читаемое значение: %7C → |. Битые последовательности оставляем как есть.
  function decode(raw) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw.replace(/(%[0-9a-f]{2})+/gi, (m) => {
        try { return decodeURIComponent(m); } catch { return m; }
      });
    }
  }

  const pct = (ch) => Array.from(new TextEncoder().encode(ch), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');

  // Записать новое значение «в стиле» исходного: символы, которые в исходнике были
  // закодированы (например | как %7C), кодируем так же; служебные для адреса — всегда.
  function encodeLike(value, originalRaw) {
    const wasEncoded = new Set();
    for (const m of originalRaw.matchAll(/%([0-9a-f]{2})/gi)) {
      const code = parseInt(m[1], 16);
      if (code < 0x80) wasEncoded.add(String.fromCharCode(code));
    }
    const keepNonAscii = /[^\x00-\x7f]/.test(originalRaw);
    return value.split(TEMPLATE).map((piece, i) => {
      if (i % 2) return piece;  // шаблонная вставка — как есть
      return Array.from(piece, (ch) => {
        if (ch.charCodeAt(0) >= 0x80) return keepNonAscii ? ch : pct(ch);
        if (/[\s&#%+=?"'<>]/.test(ch) || wasEncoded.has(ch)) return pct(ch);
        return ch;
      }).join('');
    }).join('');
  }

  /* ---------- Сбор меток ---------- */

  // Общая метка — одно значение на всех ссылках, где она есть (и таких ссылок хотя бы две).
  // Остальные — «разные»: по группам значений с перечнем ссылок. У тех и других
  // отмечаем ссылки с метками, где этого параметра нет.
  function collect() {
    const entries = [];
    for (const a of app.getLinks()) {
      const h = parseHref(a.getAttribute('href'));
      if (!h) continue;
      const marks = h.parts.filter((p) => p.raw != null && IS_MARK.test(p.name));
      if (marks.length) entries.push({ a, marks });
    }

    const names = [];
    const byName = new Map();
    for (const { a, marks } of entries) {
      for (const p of marks) {
        if (!byName.has(p.name)) { byName.set(p.name, new Map()); names.push(p.name); }
        const groups = byName.get(p.name);
        const value = decode(p.raw);
        if (!groups.has(value)) groups.set(value, []);
        const list = groups.get(value);
        if (!list.includes(a)) list.push(a);
      }
    }

    const common = [];
    const varied = [];
    for (const name of names) {
      const groups = [...byName.get(name)].map(([value, links]) => ({ value, links }));
      const holders = new Set(groups.flatMap((g) => g.links));
      // «Нет у» показываем, только если метка есть хотя бы у половины ссылок с метками:
      // тогда отсутствие похоже на пропуск, а не на другую схему меток (опрос, рефералка).
      const missing = holders.size * 2 >= entries.length
        ? entries.filter((e) => !holders.has(e.a)).map((e) => e.a) : [];
      if (groups.length === 1 && groups[0].links.length > 1) common.push({ name, ...groups[0], missing });
      else varied.push({ name, groups, missing });
    }
    return { total: entries.length, common, varied };
  }

  /* ---------- Правка ----------
     Пока поле в фокусе, правим от снимка ссылок на момент фокуса: каждая ссылка
     пересобирается из исходного href — так кодировка не «плывёт» от ввода к вводу,
     а Esc возвращает всё как было. */

  let editing = null;  // { name, from, links, snapshot: Map<a, href> }

  function beginEdit(name, value, links) {
    editing = { name, from: value, links, snapshot: new Map(links.map((a) => [a, a.getAttribute('href')])) };
  }

  function applyEdit(newValue) {
    if (!editing) return;
    const { name, from, links, snapshot } = editing;
    for (const a of links) {
      const h = parseHref(snapshot.get(a));
      if (!h) continue;
      for (const p of h.parts) {
        if (p.name === name && p.raw != null && decode(p.raw) === from && newValue !== from) {
          p.raw = encodeLike(newValue, p.raw);
        }
      }
      a.setAttribute('href', buildHref(h));
    }
    app.linksChanged(links);
  }

  function cancelEdit() {
    if (!editing) return;
    for (const [a, href] of editing.snapshot) a.setAttribute('href', href);
    app.linksChanged(editing.links);
  }

  /* ---------- Интерфейс: вкладка «UTM-метки» в панели ссылок ---------- */

  const panel = app.linksPanel;
  const list = app.linksList;

  const tabs = document.createElement('div');
  tabs.className = 'seg links-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.innerHTML = `
    <button type="button" role="tab" data-tab="list">Список</button>
    <button type="button" role="tab" data-tab="utm">UTM-метки <b class="utm-count">0</b></button>`;
  panel.querySelector('.panel-head').after(tabs);

  const pane = document.createElement('div');
  pane.className = 'utm-pane';
  pane.hidden = true;
  list.after(pane);

  function setTab(tab) {
    const utm = tab === 'utm';
    tabs.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', String(on));
    });
    list.hidden = utm;
    pane.hidden = !utm;
    panel.classList.toggle('is-wide', utm);
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* не запомнится — не страшно */ }
    if (utm) render();
  }

  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) setTab(btn.dataset.tab);
  });

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function chips(links) {
    return links.map((a) => {
      const info = app.linkInfo(a);
      return `<button type="button" class="utm-chip" data-n="${info.n}" title="Открыть: ${esc(info.label)}">`
        + `<span class="utm-chip-n">#${info.n}</span>${esc(info.label)}</button>`;
    }).join('');
  }

  const missing = (links) => (links.length
    ? `<div class="utm-missing"><span>нет у</span><div class="utm-chips">${chips(links)}</div></div>` : '');

  function field(name, value, links) {
    return `<textarea class="utm-value" rows="1" spellcheck="false" readonly
      data-name="${esc(name)}" data-value="${esc(value)}" data-links="${links.map((a) => app.linkInfo(a).n).join(',')}">${esc(value)}</textarea>`;
  }

  function render() {
    // Не перерисовываем под руками: поле в фокусе — дорисуем после ухода из него.
    if (pane.contains(document.activeElement)) { pane.dataset.stale = '1'; return; }
    delete pane.dataset.stale;

    const { total, common, varied } = collect();
    setCount(common.length + varied.length);

    if (!total) {
      pane.innerHTML = '<p class="utm-empty">В ссылках нет UTM-меток.</p>';
      return;
    }

    let html = '';
    if (common.length) {
      html += `<section class="utm-section">
        <h3 class="utm-title">Общие <span>одно значение на всех ссылках</span></h3>
        ${common.map((m) => `<div class="utm-param">
          <div class="utm-name">${esc(m.name)} <span class="utm-share">${m.links.length} из ${total}</span></div>
          ${field(m.name, m.value, m.links)}
          ${missing(m.missing)}
        </div>`).join('')}
      </section>`;
    }
    if (varied.length) {
      html += `<section class="utm-section">
        <h3 class="utm-title">Разные <span>значение — и где оно стоит</span></h3>
        ${varied.map((m) => `<div class="utm-param">
          <div class="utm-name">${esc(m.name)}</div>
          ${m.groups.map((g) => `<div class="utm-group">
            ${field(m.name, g.value, g.links)}
            <div class="utm-chips">${chips(g.links)}</div>
          </div>`).join('')}
          ${missing(m.missing)}
        </div>`).join('')}
      </section>`;
    }
    pane.innerHTML = html;
    pane.querySelectorAll('.utm-value').forEach((t) => { app.guardField(t); autosize(t); });
  }

  function autosize(t) {
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight + t.offsetHeight - t.clientHeight}px`;
  }

  const linksByNumbers = (s) => {
    const all = app.getLinks();
    return s.split(',').filter(Boolean).map((n) => all[Number(n) - 1]).filter(Boolean);
  };

  pane.addEventListener('focusin', (e) => {
    const t = e.target.closest('.utm-value');
    if (t) beginEdit(t.dataset.name, t.dataset.value, linksByNumbers(t.dataset.links));
  });

  pane.addEventListener('input', (e) => {
    const t = e.target.closest('.utm-value');
    if (!t || !editing) return;
    // Значение — одна строка: переносы из вставки вырезаем.
    if (/[\r\n]/.test(t.value)) t.value = t.value.replace(/[\r\n]+/g, '');
    autosize(t);
    applyEdit(t.value);
  });

  pane.addEventListener('keydown', (e) => {
    const t = e.target.closest('.utm-value');
    if (!t) return;
    if (e.key === 'Enter') { e.preventDefault(); t.blur(); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
      t.value = t.dataset.value;
      t.blur();
    }
  });

  pane.addEventListener('focusout', (e) => {
    if (!e.target.closest('.utm-value')) return;
    editing = null;
    // Значения могли слиться или разойтись — пересобираем группы.
    setTimeout(() => { if (!pane.contains(document.activeElement)) render(); });
  });

  pane.addEventListener('click', (e) => {
    const chip = e.target.closest('.utm-chip');
    if (!chip) return;
    const a = app.getLinks()[Number(chip.dataset.n) - 1];
    if (a) app.openLink(a);
  });

  // Счётчик на вкладке — число разных меток (параметров).
  function setCount(n) {
    tabs.querySelector('.utm-count').textContent = String(n);
  }

  app.onLinksChange(() => {
    if (!pane.hidden) render();
    else {
      const r = collect();
      setCount(r.common.length + r.varied.length);
    }
  });

  let saved = 'list';
  try { saved = localStorage.getItem(TAB_KEY) || 'list'; } catch { /* по умолчанию — список */ }
  setTab(saved === 'utm' ? 'utm' : 'list');
})();
