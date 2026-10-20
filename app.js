(() => {
  'use strict';

  // Всё служебное начинается с data-elk- и вырезается при экспорте.
  const ID_ATTR = 'data-elk-id';            // метка ссылки для списка
  const HOVER_ATTR = 'data-elk-hover';      // на <html>: курсор-pointer над редактируемым
  const HIDDEN_PREFIX = 'data-elk-attr-';   // «спрятанные» атрибуты исходника (onclick, type у script…)
  const DISABLED_SCRIPT = 'text/x-elk-disabled';
  const STYLE_ID = 'elk-style';
  const HOVER_PAD = 9;  // воздух вокруг элемента у подсветки и «прожектора»

  // Схлопываемые HTML-пробелы. Неразрывные и прочие спецпробелы сюда не входят.
  const WS = '[ \\t\\n\\r\\f]';
  const IS_WS = new RegExp(`^${WS}$`);
  const HAS_TEXT = new RegExp(`[^ \\t\\n\\r\\f]`);
  const BR_MARK = '';

  // Невидимые символы, которые подсвечиваются в поле правки: [вид, метка].
  const HIDDEN_CHARS = {
    ' ': ['nbsp', '_'],
    ' ': ['nbsp', '_'],
    ' ': ['sp', '·'],
    ' ': ['sp', '·'],
    ' ': ['sp', '·'],
    ' ': ['sp', '·'],
    ' ': ['sp', '·'],
    ' ': ['sp', '·'],
    ' ': ['sp', '·'],
    ' ': ['sp', '·'],
    ' ': ['sp', '·'],
    '​': ['zw', ''],
    '‌': ['zw', ''],
    '‍': ['zw', ''],
    '⁠': ['zw', ''],
    '﻿': ['zw', ''],
    '­': ['shy', ''],
  };
  const LEGEND = {
    nbsp: ['_', 'неразрывный пробел'],
    sp: ['·', 'спецпробел'],
    zw: ['|', 'нулевой ширины'],
    shy: ['|', 'мягкий перенос'],
    nl: ['↵', 'перенос строки'],
  };

  const $ = (sel) => document.querySelector(sel);
  const ui = {
    source: $('#source'),
    sourceBackdrop: $('#sourceBackdrop'),
    frame: $('#preview'),
    stage: $('#stage'),
    stageScroll: $('#stageScroll'),
    empty: $('#emptyState'),
    hoverBox: $('#hoverBox'),
    spotlight: $('#spotlight'),
    list: $('#linkList'),
    count: $('#linkCount'),
    linksPanel: $('#linksPanel'),
    linksToggle: $('#linksToggle'),
    linksClose: $('#linksClose'),
    countBtn: $('#linkCountBtn'),
    warnBtn: $('#linkWarnBtn'),
    pop: $('#popover'),
    popTitle: $('#popTitle'),
    popTextField: $('#popTextField'),
    popEditor: $('#popEditor'),
    popLegend: $('#popLegend'),
    popStyle: $('#popStyle'),
    popStyleBubble: $('#popStyleBubble'),
    popNbsp: $('#popNbsp'),
    popSrcField: $('#popSrcField'),
    popSrc: $('#popSrc'),
    popAltField: $('#popAltField'),
    popAltToggle: $('#popAltToggle'),
    popAltPreview: $('#popAltPreview'),
    popAlt: $('#popAlt'),
    popUrlField: $('#popUrlField'),
    popUrlLabel: $('#popUrlLabel'),
    popUrl: $('#popUrl'),
    popUnlink: $('#popUnlink'),
    popUrlNote: $('#popUrlNote'),
    popOpen: $('#popOpen'),
    popHint: $('#popHint'),
    popDone: $('#popDone'),
    popCancel: $('#popCancel'),
    popClose: $('#popClose'),
    device: $('#deviceSwitch'),
    toast: $('#toast'),
  };

  // Источник правды — живой документ в iframe. Правки вносятся прямо в него,
  // а результат получается сериализацией его копии без служебных меток.
  const state = {
    doc: null,
    isFragment: false,  // исходник без <html> — отдаём обратно только содержимое body
    links: [],          // <a> в порядке документа
    nextId: 0,
    hover: null,        // цель под курсором
    edit: null,         // открытое окно правки
  };

  /*
   * «Цель» правки:
   *   { run, link } — текстовый блок: подряд идущие текст, <br> и жирные теги одного родителя
   *                   (run = { parent, nodes }); link — <a>, если текст внутри ссылки;
   *   { img, link } — картинка; link — <a> вокруг неё или null;
   *   { run: null, link } — ссылка без текста и без картинки (svg и т.п.).
   *
   * Текст блока в редакторе — массив символов { c, b }: c — символ ('\n' = <br>), b — жирный.
   */

  /* ================= Загрузка ================= */

  function loadSource(html) {
    closeEditor();
    hideHover();
    state.doc = null;
    state.links = [];
    state.nextId = 0;

    if (!html.trim()) {
      ui.frame.srcdoc = '';
      setEmpty(true);
      renderList();
      return;
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    neutralize(doc);
    state.isFragment = !/<html[\s>]/i.test(html);

    setEmpty(false);
    ui.frame.onload = attachView;
    ui.frame.srcdoc = serializeDocument(doc);
    renderList();
  }

  // Отключаем в превью всё исполняемое, но без потерь: атрибуты переименовываются
  // и при экспорте возвращаются на место.
  function neutralize(doc) {
    doc.querySelectorAll('*').forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        if (/^on/i.test(attr.name)) hideAttr(el, attr.name);
      }
    });
    doc.querySelectorAll('script').forEach((s) => {
      if (s.hasAttribute('type')) hideAttr(s, 'type');
      s.setAttribute('type', DISABLED_SCRIPT);
    });
    doc.querySelectorAll('meta[http-equiv="refresh" i]').forEach((m) => hideAttr(m, 'http-equiv'));
  }

  function hideAttr(el, name) {
    el.setAttribute(HIDDEN_PREFIX + name, el.getAttribute(name));
    el.removeAttribute(name);
  }

  function restore(doc) {
    const style = doc.getElementById(STYLE_ID);
    if (style) style.remove();
    doc.querySelectorAll(`script[type="${DISABLED_SCRIPT}"]`).forEach((s) => s.removeAttribute('type'));
    doc.querySelectorAll('*').forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        if (!attr.name.startsWith('data-elk-')) continue;
        if (attr.name.startsWith(HIDDEN_PREFIX)) el.setAttribute(attr.name.slice(HIDDEN_PREFIX.length), attr.value);
        el.removeAttribute(attr.name);
      }
    });
  }

  function attachView() {
    const doc = ui.frame.contentDocument;
    if (!doc || !doc.body) return;
    state.doc = doc;

    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html[${HOVER_ATTR}], html[${HOVER_ATTR}] * { cursor: pointer !important; }
    `;
    (doc.head || doc.documentElement).appendChild(style);

    doc.addEventListener('mousemove', onViewMouseMove);
    doc.documentElement.addEventListener('mouseleave', hideHover);
    doc.addEventListener('click', onViewClick, true);
    doc.addEventListener('submit', (e) => e.preventDefault(), true);
    doc.addEventListener('dragstart', (e) => e.preventDefault(), true);
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelEditor(); });
    // Картинки догружаются — пересчитываем высоту.
    doc.addEventListener('load', fitFrame, true);

    scanLinks();
    fitFrame();
    setTimeout(fitFrame, 300);
  }

  // iframe растягивается по высоте контента, скроллится внешний контейнер.
  function fitFrame() {
    const doc = state.doc;
    if (!doc || !doc.documentElement) return;
    // Для замера iframe на миг схлопывается — без сохранения прокрутки
    // сцена прыгнула бы вверх. Всё происходит до отрисовки кадра.
    const scroll = ui.stageScroll.scrollTop;
    ui.frame.style.height = '0px';
    const h = Math.max(doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0);
    ui.frame.style.height = h + 'px';
    ui.stageScroll.scrollTop = scroll;
    positionPopover();
  }

  // Прожектор вокруг редактируемого элемента; остальное превью приглушено.
  function placeSpotlight() {
    const edit = state.edit;
    if (!edit) return;
    if (edit.run && !edit.run.nodes[0].isConnected) return;
    const r = hoverRect(edit);
    const pad = HOVER_PAD;
    Object.assign(ui.spotlight.style, {
      left: ui.frame.offsetLeft + r.left - pad + 'px',
      top: ui.frame.offsetTop + r.top - pad + 'px',
      width: r.width + pad * 2 + 'px',
      height: r.height + pad * 2 + 'px',
    });
    ui.spotlight.classList.add('is-on');
  }

  function setEmpty(isEmpty) {
    ui.empty.hidden = !isEmpty;
    ui.stage.classList.toggle('is-empty', isEmpty);
  }

  /* ================= Текстовые блоки ================= */

  // Начертания: b — жирный, i — курсив, s — зачёркнутый.
  // Порядок задаёт вложенность при записи: <b><i><s>…</s></i></b>.
  const STYLES = ['b', 'i', 's'];

  // Какие начертания задаёт элемент: <b>/<strong>, <i>/<em>, <s>/<strike>/<del>
  // или <span> со стилем font-weight / font-style / text-decoration.
  function styleKinds(n) {
    if (!n || n.nodeType !== 1) return '';
    const tag = n.nodeName;
    const st = n.style;
    const span = tag === 'SPAN';
    let k = '';
    if (tag === 'B' || tag === 'STRONG' || (span && /^(bold|bolder|[6-9]00)$/.test(st.fontWeight))) k += 'b';
    if (tag === 'I' || tag === 'EM' || (span && st.fontStyle === 'italic')) k += 'i';
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || (span && /line-through/.test(st.textDecorationLine || st.textDecoration))) k += 's';
    return k;
  }

  const withKinds = (base, kinds) => {
    const x = { ...base };
    for (const k of kinds) x[k] = true;
    return x;
  };
  const styleKey = (x) => STYLES.filter((k) => x[k]).join('');

  // Часть блока: текст, <br> или тег начертания, внутри которого тоже только части блока.
  function isRunPart(n) {
    if (n.nodeType === 3 || n.nodeName === 'BR') return true;
    return !!styleKinds(n) && Array.from(n.childNodes).every(isRunPart);
  }

  const hasText = (n) => HAS_TEXT.test(n.textContent);
  const isBlank = (n) => n.nodeName === 'BR' || (n.nodeType !== 1 || !n.querySelector('br')) && !hasText(n);

  // Текстовый блок вокруг текстового узла: поднимаемся из тегов начертания,
  // затем собираем соседей-частей блока. Пустые края в блок не входят.
  function runFromNode(t) {
    let start = t;
    while (start.parentElement && isRunPart(start.parentElement)) start = start.parentElement;
    const parent = start.parentElement;
    if (!parent || parent.closest('head, script, style, textarea, title, noscript')) return null;

    let first = start;
    while (first.previousSibling && isRunPart(first.previousSibling)) first = first.previousSibling;
    let last = start;
    while (last.nextSibling && isRunPart(last.nextSibling)) last = last.nextSibling;

    const nodes = [];
    for (let n = first; ; n = n.nextSibling) { nodes.push(n); if (n === last) break; }
    while (nodes.length && isBlank(nodes[0])) nodes.shift();
    while (nodes.length && isBlank(nodes[nodes.length - 1])) nodes.pop();
    return nodes.length ? { parent, nodes } : null;
  }

  function runRange(run) {
    const range = state.doc.createRange();
    range.setStartBefore(run.nodes[0]);
    range.setEndAfter(run.nodes[run.nodes.length - 1]);
    return range;
  }

  function runRects(run) {
    return Array.from(runRange(run).getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  }

  // Текст блока как его видит читатель: пробелы из исходника схлопнуты, <br> — перенос строки.
  // Отступы по краям блока запоминаются и возвращаются при записи, чтобы не портить исходник.
  function runToChars(run) {
    const raw = [];
    const walk = (n, st) => {
      if (n.nodeType === 3) for (const c of n.data) raw.push({ ...st, c });
      else if (n.nodeName === 'BR') raw.push({ ...st, c: BR_MARK });
      else for (const ch of n.childNodes) walk(ch, withKinds(st, styleKinds(ch)));
    };
    for (const n of run.nodes) walk(n, withKinds({}, styleKinds(n)));

    const first = run.nodes[0];
    const last = run.nodes[run.nodes.length - 1];
    const lead = first.nodeType === 3 ? first.data.match(new RegExp(`^${WS}*`))[0] : '';
    const trail = last.nodeType === 3 ? last.data.match(new RegExp(`${WS}*$`))[0] : '';

    const chars = [];
    let line = [];
    const flush = () => {
      while (line.length && line[0].c === ' ') line.shift();
      while (line.length && line[line.length - 1].c === ' ') line.pop();
      chars.push(...line);
      line = [];
    };
    for (const x of raw) {
      if (x.c === BR_MARK) { flush(); chars.push({ ...x, c: '\n' }); continue; }
      if (IS_WS.test(x.c)) {
        if (line.length && line[line.length - 1].c === ' ') continue;
        line.push({ ...x, c: ' ' });
      } else {
        line.push(x);
      }
    }
    flush();
    return { chars, lead, trail };
  }

  // Обратно в узлы документа. Куски с начертанием оборачиваются в копии исходных тегов
  // этого начертания (по порядку) — так сохраняются их атрибуты и стили.
  function charsToNodes(chars, lead, trail, templates) {
    const doc = state.doc;
    const nodes = [];
    const inline = (text) => {
      const out = [];
      text.split('\n').forEach((s, i) => {
        if (i) out.push(doc.createElement('br'));
        if (s) out.push(doc.createTextNode(s));
      });
      return out;
    };
    const used = { b: 0, i: 0, s: 0 };
    const wrapper = (k) => {
      const list = templates[k] || [];
      const tpl = list[Math.min(used[k]++, list.length - 1)];
      return tpl ? tpl.cloneNode(false) : doc.createElement(k);
    };
    for (const g of groupByStyle(chars)) {
      let parts = inline(g.text);
      // Изнутри наружу: <s> внутри <i> внутри <b>.
      for (const k of [...STYLES].reverse()) {
        if (!g.key.includes(k)) continue;
        const el = wrapper(k);
        el.append(...parts);
        parts = [el];
      }
      nodes.push(...parts);
    }
    if (lead) {
      if (nodes[0] && nodes[0].nodeType === 3) nodes[0].data = lead + nodes[0].data;
      else nodes.unshift(doc.createTextNode(lead));
    }
    if (trail) {
      const end = nodes[nodes.length - 1];
      if (end && end.nodeType === 3) end.data += trail;
      else nodes.push(doc.createTextNode(trail));
    }
    // Узел-якорь нужен всегда: по нему блок находится при следующей записи.
    if (!nodes.length) nodes.push(doc.createTextNode(''));
    return nodes;
  }

  function groupByStyle(chars) {
    const groups = [];
    for (const x of chars) {
      const key = styleKey(x);
      const g = groups[groups.length - 1];
      if (g && g.key === key) g.text += x.c;
      else groups.push({ key, text: x.c });
    }
    return groups;
  }

  // Исходные теги начертаний блока — образцы для записи: { b: [...], i: [...], s: [...] }.
  function styleTemplates(run) {
    const out = { b: [], i: [], s: [] };
    const walk = (n) => {
      for (const k of styleKinds(n)) out[k].push(n.cloneNode(false));
      if (n.nodeType === 1) for (const ch of n.children) walk(ch);
    };
    run.nodes.forEach(walk);
    return out;
  }

  const charsKey = (chars) => chars.map((x) => styleKey(x) + '\u0000' + x.c).join('\u0001');

  function replaceRun(run, nodes) {
    const ref = run.nodes[0];
    for (const n of nodes) run.parent.insertBefore(n, ref);
    for (const n of run.nodes) n.remove();
    return { parent: run.parent, nodes };
  }

  /* ================= Поиск цели под курсором ================= */

  function hitTest(x, y) {
    const doc = state.doc;
    const textNode = textNodeAtPoint(doc, x, y);
    if (textNode) {
      const run = runFromNode(textNode);
      if (run && pointInRect(runRects(run), x, y)) return { run, link: run.parent.closest('a') };
    }
    const el = doc.elementFromPoint(x, y);
    const img = el && el.closest('img');
    if (img) return { img, link: img.closest('a') };
    const a = el && (el.closest('a') || buttonLinkAt(el));
    if (a) {
      // Клик по полю кнопки-ссылки вокруг текста — правим её текст и адрес.
      if (HAS_TEXT.test(a.textContent)) {
        const t = linkTarget(a);
        if (t.run || t.img) return t;
      }
      return { run: null, link: a };
    }
    return null;
  }

  function textNodeAtPoint(doc, x, y) {
    let node = null;
    if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(x, y);
      node = pos && pos.offsetNode;
    } else if (doc.caretRangeFromPoint) {
      const range = doc.caretRangeFromPoint(x, y);
      node = range && range.startContainer;
    }
    return node && node.nodeType === 3 ? node : null;
  }

  function unionRect(rects) {
    if (!rects.length) return null;
    const r = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const x of rects) {
      r.left = Math.min(r.left, x.left);
      r.top = Math.min(r.top, x.top);
      r.right = Math.max(r.right, x.right);
      r.bottom = Math.max(r.bottom, x.bottom);
    }
    r.width = r.right - r.left;
    r.height = r.bottom - r.top;
    return r;
  }

  function pointInRect(rects, x, y) {
    return rects.some((r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1);
  }

  function targetRect(target) {
    if (target.img) return target.img.getBoundingClientRect();
    if (target.run) {
      const r = unionRect(runRects(target.run));
      if (r) return r;
    }
    const el = target.link || target.run.parent;
    const img = el.querySelector && el.querySelector('img');
    return (img || el).getBoundingClientRect();
  }

  // Область подсветки. Если текст занимает всю ссылку (кнопка, блочная ссылка) —
  // подсвечиваем всю кликабельную площадь ссылки, а не только буквы.
  function hoverRect(target) {
    const a = target.run && target.link;
    if (a && runCoversLink(target.run, a)) {
      const box = buttonBox(a);
      if (box !== a) return box.getBoundingClientRect();
      const inlineWrapped = getComputedStyle(a).display === 'inline' && a.getClientRects().length > 1;
      if (!inlineWrapped) {
        const boxes = [a, ...a.querySelectorAll('*')].map((el) => el.getBoundingClientRect());
        const r = unionRect(boxes.filter((b) => b.width > 0 && b.height > 0));
        if (r) return r;
      }
    }
    return targetRect(target);
  }

  // «Кнопка» в письмах часто устроена так: цветной фон и отступы — у ячейки или блока,
  // а ссылка внутри — просто текст. Визуально кнопка — весь контейнер.
  // Возвращает такой контейнер (до 4 уровней вверх) или саму ссылку.
  function buttonBox(a) {
    const strip = (s) => s.replace(/\s+/g, '');
    const text = strip(a.textContent);
    let el = a.parentElement;
    for (let i = 0; el && i < 4 && el !== el.ownerDocument.body; i++, el = el.parentElement) {
      if (strip(el.textContent) !== text || el.querySelectorAll('a, img').length > 1) break;
      if (hasOwnBackground(el)) return el;
    }
    return a;
  }

  function hasOwnBackground(el) {
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    const bg = cs.backgroundColor;
    const filled = bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg);
    return filled || el.hasAttribute('bgcolor') || cs.backgroundImage !== 'none' || parseFloat(cs.borderTopWidth) > 0;
  }

  // Клик мимо ссылки, но внутри контейнера-кнопки: находим её ссылку.
  function buttonLinkAt(el) {
    for (let n = el, i = 0; n && i < 5; n = n.parentElement, i++) {
      const links = n.querySelectorAll('a');
      if (links.length > 1) return null;
      if (links.length === 1 && buttonBox(links[0]) === n) return links[0];
    }
    return null;
  }

  function runCoversLink(run, a) {
    const strip = (s) => s.replace(/\s+/g, '');
    return strip(run.nodes.map((n) => n.textContent).join('')) === strip(a.textContent);
  }

  function sameTarget(a, b) {
    if (!a || !b) return false;
    if (a.img || b.img) return a.img === b.img;
    if (a.run || b.run) return !!(a.run && b.run && a.run.nodes[0] === b.run.nodes[0]);
    return a.link === b.link;
  }

  /* ================= Наведение и клик ================= */

  let moveFrame = 0;
  function onViewMouseMove(e) {
    const { clientX: x, clientY: y } = e;
    cancelAnimationFrame(moveFrame);
    moveFrame = requestAnimationFrame(() => setHover(state.doc ? hitTest(x, y) : null));
  }

  // Курсор, переходя между блоками, почти всегда проскакивает пустую щель между ними
  // (отступ абзаца, поле ячейки). Чтобы подсветка в этот миг не гасла и не возникала
  // заново «скачком», гасим её с задержкой, а недавно погасшую — ведём перетеканием.
  const HOVER_HIDE_DELAY = 120;  // столько ждём следующий блок, прежде чем погасить
  const HOVER_GLIDE_AFTER = 300; // погасла раньше — следующий блок появляется на месте
  let hoverHideTimer = 0;
  let hoverOffAt = 0;

  function setHover(target) {
    state.hover = target;
    const html = state.doc && state.doc.documentElement;
    const box = ui.hoverBox;
    if (!target || (state.edit && sameTarget(target, state.edit))) {
      if (html) html.toggleAttribute(HOVER_ATTR, !!target);
      if (box.classList.contains('is-on') && !hoverHideTimer) {
        hoverHideTimer = setTimeout(hideHoverBox, HOVER_HIDE_DELAY);
      }
      return;
    }
    clearTimeout(hoverHideTimer);
    hoverHideTimer = 0;
    html.setAttribute(HOVER_ATTR, '');
    const r = hoverRect(target);
    const pad = HOVER_PAD;
    // Перетекаем, если подсветка видна или погасла только что; иначе — появляемся на месте.
    const glide = box.classList.contains('is-on') || performance.now() - hoverOffAt < HOVER_GLIDE_AFTER;
    if (!glide) box.style.transition = 'opacity .18s ease';
    Object.assign(box.style, {
      left: ui.frame.offsetLeft + r.left - pad + 'px',
      top: ui.frame.offsetTop + r.top - pad + 'px',
      width: r.width + pad * 2 + 'px',
      height: r.height + pad * 2 + 'px',
    });
    if (!glide) {
      void box.offsetWidth;
      box.style.transition = '';
    }
    box.classList.add('is-on');
  }

  function hideHoverBox() {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = 0;
    if (ui.hoverBox.classList.contains('is-on')) hoverOffAt = performance.now();
    ui.hoverBox.classList.remove('is-on');
  }

  function hideHover() {
    cancelAnimationFrame(moveFrame);
    state.hover = null;
    hideHoverBox();
    if (state.doc) state.doc.documentElement.removeAttribute(HOVER_ATTR);
  }

  function onViewClick(e) {
    // Никаких переходов и отправок форм внутри превью.
    if (e.target.closest && e.target.closest('a, button, input[type="submit"]')) e.preventDefault();
    const target = hitTest(e.clientX, e.clientY);
    if (target) {
      if (!sameTarget(target, state.edit)) openEditor(target);
    } else {
      closeEditor();
    }
  }

  /* ================= Окно правки ================= */

  function openEditor(target, { scroll = false } = {}) {
    closeEditor();
    if (target.img) { openImageEditor(target, { scroll }); return; }
    const { run, link } = target;
    const edit = { run, link, origHref: link ? link.getAttribute('href') : null };

    if (run) {
      const t = runToChars(run);
      Object.assign(edit, t, {
        key: charsKey(t.chars),
        origNodes: run.nodes.map((n) => n.cloneNode(true)),
        templates: styleTemplates(run),
        history: [{ chars: t.chars, sel: [t.chars.length, t.chars.length] }],
        historyAt: 0,
      });
    }
    state.edit = edit;

    const n = link ? state.links.indexOf(link) + 1 : 0;
    ui.popTitle.textContent = link ? (n ? `Ссылка #${n}` : 'Ссылка') : 'Текст';
    ui.popTextField.hidden = !run;
    ui.popSrcField.hidden = true;
    ui.popAltField.hidden = true;
    ui.popAltToggle.hidden = true;
    ui.popUrlField.hidden = !link;
    ui.popUrlLabel.textContent = 'URL';
    ui.popUrl.placeholder = '';
    ui.popUnlink.hidden = true;
    ui.popUrlNote.hidden = true;
    ui.popHint.style.visibility = run ? '' : 'hidden';
    if (link) ui.popUrl.value = edit.origHref || '';
    updateOpenButton();

    ui.pop.hidden = false;
    if (run) renderEditor(edit.chars);
    if (scroll) scrollToView(targetRect(target));
    positionPopover();
    if (!scroll) revealPopover();
    hideHoverBox();
    markListActive();
    revealInSource(target);

    if (run) {
      ui.popEditor.focus({ preventScroll: true });
      setSelection([edit.chars.length, edit.chars.length]);
      updateStyleButtons();
    } else {
      ui.popUrl.focus({ preventScroll: true });
      ui.popUrl.setSelectionRange(ui.popUrl.value.length, ui.popUrl.value.length);
    }
  }

  // Применить и закрыть. Правки уже внесены по ходу ввода.
  function closeEditor() {
    if (!state.edit) return;
    state.edit = null;
    setStyleBubble(false);
    ui.pop.hidden = true;
    ui.spotlight.classList.remove('is-on');
    markListActive();
  }

  // Откатить правки и закрыть.
  function cancelEditor() {
    const edit = state.edit;
    if (!edit) return;
    if (edit.img) { cancelImageEdit(edit); return; }
    if (edit.run && charsKey(edit.chars) !== edit.key) {
      edit.run = replaceRun(edit.run, edit.origNodes.map((n) => n.cloneNode(true)));
    }
    if (edit.link) {
      if (edit.origHref == null) edit.link.removeAttribute('href');
      else edit.link.setAttribute('href', edit.origHref);
    }
    fitFrame();
    scheduleSync();
    closeEditor();
  }

  // Окно встаёт так, чтобы поле правки легло поверх редактируемого текста.
  // Для картинки — под ней.
  // Колонка, в которой лежит текст: ближайший блочный родитель без внутренних отступов.
  // Многострочный текст с неровными переносами уже своей колонки — окно равняем по колонке.
  function textColumnRect(run) {
    const rects = runRects(run);
    const lines = new Set(rects.map((x) => Math.round(x.top)));
    if (lines.size < 2) return null;
    const view = run.parent.ownerDocument.defaultView;
    let el = run.parent;
    while (el.parentElement && view.getComputedStyle(el).display.startsWith('inline')) el = el.parentElement;
    const cs = view.getComputedStyle(el);
    const b = el.getBoundingClientRect();
    const left = b.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
    const right = b.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
    const text = unionRect(rects);
    // Защита от странных раскладок: колонка должна охватывать сам текст.
    if (right - left < text.width || left > text.left + 1) return null;
    return { left, right, width: right - left, top: text.top, bottom: text.bottom, height: text.height };
  }

  // Окно встаёт рядом с редактируемым элементом и не накрывает его:
  // по горизонтали — по центру элемента (многострочный текст — по центру его колонки),
  // по вертикали — под ним, а если снизу не помещается в видимую часть — над ним.
  // Сторону выбираем при открытии и держим, пока окно открыто, чтобы оно не прыгало.
  const POP_GAP = HOVER_PAD + 7;  // зазор до элемента: подсветка/«прожектор» плюс воздух

  const URL_MAX_WIDTH = 720;  // шире окно не растягиваем — адрес переносится
  let measureCtx = null;

  // Ширина окна, при которой адрес помещается в поле одной строкой.
  function urlFitWidth() {
    const field = ui.popUrl;
    const cs = getComputedStyle(field);
    measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
    measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const text = measureCtx.measureText(field.value || field.placeholder).width;
    const fieldChrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
      + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth) + 4;
    // Остальное в строке: кнопки справа от поля и промежутки между ними.
    const row = field.parentElement;
    const rowGap = parseFloat(getComputedStyle(row).columnGap) || 0;
    let rest = 0;
    for (const el of row.children) if (el !== field && !el.hidden) rest += el.offsetWidth + rowGap;
    const ps = getComputedStyle(ui.pop);
    const popChrome = (ui.pop.clientLeft + parseFloat(ps.paddingLeft)) * 2;
    return Math.ceil(text + fieldChrome + rest + popChrome);
  }

  function autosizeUrl() {
    const field = ui.popUrl;
    field.style.height = 'auto';
    field.style.height = field.scrollHeight + field.offsetHeight - field.clientHeight + 'px';
  }

  function positionPopover() {
    const edit = state.edit;
    if (!edit) return;
    if (edit.run && !edit.run.nodes[0].isConnected) return;
    const column = edit.run && textColumnRect(edit.run);
    const r = column || hoverRect(edit);
    // Правая граница доступного места: край сцены или, если открыта, панель ссылок.
    const stageW = popoverLimitRight();

    // Внутренние поля окна (и поля ввода, если оно видно) — чтобы для текста
    // ширина поля ввода совпала с колонкой.
    const ps = getComputedStyle(ui.pop);
    let side = ui.pop.clientLeft + parseFloat(ps.paddingLeft);
    if (edit.run) {
      const es = getComputedStyle(ui.popEditor);
      side += parseFloat(es.paddingLeft) + parseFloat(es.borderLeftWidth);
    }
    let width = column
      ? Math.min(r.width + side * 2, stageW - 16)
      : Math.min(Math.max(r.width + side * 2, 360), 640, stageW - 16);
    // Ссылка видна целиком: сначала расширяем окно под адрес, дальше — перенос строк.
    if (!ui.popUrlField.hidden) width = Math.max(width, Math.min(urlFitWidth(), URL_MAX_WIDTH, stageW - 16));
    ui.pop.style.width = width + 'px';
    autosizeUrl();

    const left = ui.frame.offsetLeft + r.left + r.width / 2 - width / 2;
    const popH = ui.pop.offsetHeight;
    const below = ui.frame.offsetTop + r.bottom + POP_GAP;
    const above = ui.frame.offsetTop + r.top - POP_GAP - popH;
    if (!edit.side) {
      const visTop = ui.stageScroll.scrollTop;
      const visBottom = visTop + ui.stageScroll.clientHeight;
      edit.side = below + popH > visBottom - 8 && above >= visTop + 8 ? 'above' : 'below';
    }
    const top = edit.side === 'above' && above >= 8 ? above : below;

    ui.pop.style.left = Math.max(8, Math.min(left, stageW - width - 8)) + 'px';
    ui.pop.style.top = top + 'px';
    placeSpotlight();
  }

  // Правая граница для окна правки в координатах сцены. Открытая панель ссылок
  // лежит поверх превью — окно правки должно умещаться левее неё.
  // offsetLeft не зависит от transform, поэтому граница верна и во время анимации панели.
  function popoverLimitRight() {
    let limit = ui.stage.clientWidth;
    if (ui.linksPanel.classList.contains('is-open')) {
      const layoutLeft = ui.linksPanel.offsetParent.getBoundingClientRect().left;
      const panelLeft = layoutLeft + ui.linksPanel.offsetLeft;
      limit = Math.min(limit, panelLeft - ui.stage.getBoundingClientRect().left - 8);
    }
    return Math.max(limit, 320);
  }

  // Окно правки должно быть видно целиком сразу при открытии. Иначе браузер
  // сам рывком прокрутит сцену, как только начнёшь печатать в поле за краем.
  function revealPopover() {
    const sc = ui.stageScroll;
    const top = ui.pop.offsetTop;
    const bottom = top + ui.pop.offsetHeight;
    let to = sc.scrollTop;
    if (bottom > sc.scrollTop + sc.clientHeight - 12) to = bottom - sc.clientHeight + 12;
    if (top < to + 12) to = top - 12;
    if (Math.abs(to - sc.scrollTop) > 1) sc.scrollTo({ top: Math.max(0, to), behavior: 'smooth' });
  }

  function scrollToView(r) {
    const target = ui.frame.offsetTop + r.top - ui.stageScroll.clientHeight / 3;
    ui.stageScroll.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }

  /* ---------- Редактор в окне ----------
     Содержимое редактора после каждого ввода разбирается обратно в массив символов
     и перерисовывается в каноническом виде: начертания — <b>/<i>/<s>, невидимые символы — в метках.
     Курсор сохраняется по позиции в тексте. */

  const escapeHtml = (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c);

  function editorHtml(chars) {
    let html = '';
    for (const g of groupByStyle(chars)) {
      let inner = '';
      for (const c of g.text) {
        if (c === '\n') { inner += '<span class="hc hc-nl"></span><br>'; continue; }
        const info = HIDDEN_CHARS[c];
        // Метка невидимого символа неделимая (contenteditable=false): курсор встаёт только
        // до или после неё, а не внутрь плашки, где его не видно.
        inner += info ? `<span class="hc hc-${info[0]}" data-m="${info[1]}" contenteditable="false">${c}</span>` : escapeHtml(c);
      }
      const tags = STYLES.filter((k) => g.key.includes(k));
      html += tags.map((t) => `<${t}>`).join('') + inner + tags.reverse().map((t) => `</${t}>`).join('');
    }
    // Хвостовой <br> нужен, чтобы пустая последняя строка была видна и доступна курсору.
    if (!chars.length || chars[chars.length - 1].c === '\n') html += '<br class="hc-end">';
    return html;
  }

  function renderEditor(chars) {
    const html = editorHtml(chars);
    if (ui.popEditor.innerHTML !== html) ui.popEditor.innerHTML = html;
    renderLegend(chars);
  }

  function parseEditor() {
    const out = [];
    // Перенос строки браузер может вставить и как <br>, и как символ \n
    // (поле с white-space: pre-wrap) — оба считаем переносом.
    const walk = (node, st) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) {
          for (const c of n.data) out.push({ ...st, c });
        } else if (n.nodeName === 'BR') {
          if (!n.classList.contains('hc-end')) out.push({ ...st, c: '\n' });
        } else if (n.nodeType === 1) {
          const block = /^(DIV|P|LI)$/.test(n.nodeName);
          if (block && out.length && out[out.length - 1].c !== '\n') out.push({ ...st, c: '\n' });
          walk(n, withKinds(st, styleKinds(n)));
        }
      }
    };
    walk(ui.popEditor, {});
    return out;
  }

  // Позиция в тексте <-> точка в DOM редактора.
  function textOffset(node, offset) {
    const range = document.createRange();
    range.setStart(ui.popEditor, 0);
    range.setEnd(node, offset);
    let n = 0;
    const walk = (x) => {
      for (const c of x.childNodes) {
        if (c.nodeType === 3) n += c.length;
        else if (c.nodeName === 'BR') { if (!c.classList.contains('hc-end')) n += 1; }
        else walk(c);
      }
    };
    walk(range.cloneContents());
    return n;
  }

  function getSelectionOffsets() {
    const sel = document.getSelection();
    if (!sel.rangeCount || !ui.popEditor.contains(sel.anchorNode)) return null;
    const r = sel.getRangeAt(0);
    return [textOffset(r.startContainer, r.startOffset), textOffset(r.endContainer, r.endOffset)];
  }

  function domPoint(target) {
    let rest = target;
    let found = null;
    const walk = (node) => {
      for (let i = 0; i < node.childNodes.length && !found; i++) {
        const c = node.childNodes[i];
        if (c.nodeType === 3) {
          if (rest <= c.length) { found = [c, rest]; return; }
          rest -= c.length;
        } else if (c.nodeName === 'BR' || isAtomicMark(c)) {
          // Перенос строки и метка невидимого символа — один символ, внутрь не заходим.
          if (c.nodeName === 'BR' && c.classList.contains('hc-end')) continue;
          if (rest === 0) { found = [node, i]; return; }
          rest -= 1;
          if (rest === 0) { found = [node, i + 1]; return; }
        } else {
          walk(c);
        }
      }
    };
    walk(ui.popEditor);
    return found || [ui.popEditor, ui.popEditor.childNodes.length];
  }

  function isAtomicMark(el) {
    return el.nodeType === 1 && el.classList.contains('hc') && el.textContent.length === 1;
  }

  function setSelection([start, end]) {
    const range = document.createRange();
    range.setStart(...domPoint(start));
    range.setEnd(...domPoint(end));
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Новое состояние текста: в редактор, в документ и в историю правок.
  function applyChars(chars, sel, { record = true } = {}) {
    const edit = state.edit;
    edit.chars = chars;
    renderEditor(chars);
    if (sel) setSelection(sel);
    writeBack();
    if (record) pushHistory(chars, sel);
    updateStyleButtons();
  }

  function writeBack() {
    const edit = state.edit;
    // Вернули как было — восстанавливаем исходные узлы, чтобы не трогать форматирование исходника.
    const nodes = charsKey(edit.chars) === edit.key
      ? edit.origNodes.map((n) => n.cloneNode(true))
      : charsToNodes(edit.chars, edit.lead, edit.trail, edit.templates);
    edit.run = replaceRun(edit.run, nodes);
    fitFrame();
    if (edit.link) updateListItem(edit.link);
    scheduleSync();
  }

  /* ---------- История (своя: перерисовка редактора сбрасывает встроенную) ---------- */

  let historyTimer = null;
  function pushHistory(chars, sel) {
    const edit = state.edit;
    const entry = { chars, sel: sel || [chars.length, chars.length] };
    edit.history.length = edit.historyAt + 1;
    // Набор подряд склеивается в один шаг отмены.
    if (historyTimer && edit.historyAt > 0) edit.history[edit.historyAt] = entry;
    else { edit.history.push(entry); edit.historyAt++; }
    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => { historyTimer = null; }, 500);
  }

  function stepHistory(dir) {
    const edit = state.edit;
    const at = edit.historyAt + dir;
    if (at < 0 || at >= edit.history.length) return;
    edit.historyAt = at;
    clearTimeout(historyTimer);
    historyTimer = null;
    const h = edit.history[at];
    applyChars(h.chars.map((x) => ({ ...x })), h.sel, { record: false });
  }

  /* ---------- Начертания: жирный, курсив, зачёркнутый ---------- */

  function toggleStyle(kind) {
    const edit = state.edit;
    const sel = getSelectionOffsets() || [edit.chars.length, edit.chars.length];
    let [s, e] = sel;
    const chars = edit.chars.map((x) => ({ ...x }));
    // Без выделения — слово под курсором.
    if (s === e) {
      const isWord = (i) => chars[i] && !/\s/.test(chars[i].c) && !HIDDEN_CHARS[chars[i].c];
      while (s > 0 && isWord(s - 1)) s--;
      while (e < chars.length && isWord(e)) e++;
      if (s === e) return;
    }
    const slice = chars.slice(s, e).filter((x) => x.c !== '\n');
    const turnOn = !slice.every((x) => x[kind]);
    for (let i = s; i < e; i++) chars[i][kind] = turnOn;
    // Смена начертания — отдельный шаг отмены, не склеивается с набором до и после.
    clearTimeout(historyTimer);
    historyTimer = null;
    applyChars(chars, [s, e]);
    clearTimeout(historyTimer);
    historyTimer = null;
  }

  // Кнопки начертаний подсвечены, если выделение (или символ у курсора) целиком в этом начертании.
  function updateStyleButtons() {
    const edit = state.edit;
    if (!edit || !edit.run) return;
    const sel = getSelectionOffsets();
    let slice = [];
    if (sel) {
      const [s, e] = sel;
      slice = (s === e ? [edit.chars[s - 1] || edit.chars[s]] : edit.chars.slice(s, e)).filter(Boolean);
    }
    let any = false;
    for (const btn of ui.popStyleBubble.querySelectorAll('[data-style]')) {
      const k = btn.dataset.style;
      const on = slice.length > 0 && slice.every((x) => x[k]);
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));
      any = any || on;
    }
    ui.popStyle.classList.toggle('is-on', any);
  }

  // Вставка текста на место выделения — через модель, без капризов браузера
  // с переносами строк в поле с white-space: pre-wrap.
  function insertAtSelection(text) {
    const edit = state.edit;
    const [s, e] = getSelectionOffsets() || [edit.chars.length, edit.chars.length];
    const style = edit.chars[s - 1] && edit.chars[s - 1].c !== '\n' ? edit.chars[s - 1] : edit.chars[s] || {};
    const base = {};
    for (const k of STYLES) if (style[k]) base[k] = true;
    const chars = edit.chars.map((x) => ({ ...x }));
    chars.splice(s, e - s, ...Array.from(text, (c) => ({ ...base, c })));
    applyChars(chars, [s + text.length, s + text.length]);
  }

  /* ---------- События редактора ---------- */

  ui.popEditor.addEventListener('beforeinput', (e) => {
    const t = e.inputType;
    const formats = { formatBold: 'b', formatItalic: 'i', formatStrikeThrough: 's' };
    if (formats[t]) { e.preventDefault(); toggleStyle(formats[t]); }
    else if (t.startsWith('format') || t === 'insertFromDrop' || t === 'deleteByDrag') e.preventDefault();
    else if (t === 'historyUndo') { e.preventDefault(); stepHistory(-1); }
    else if (t === 'historyRedo') { e.preventDefault(); stepHistory(1); }
    else if (t === 'insertLineBreak' || t === 'insertParagraph') { e.preventDefault(); insertAtSelection('\n'); }
  });

  ui.popEditor.addEventListener('input', (e) => {
    if (e.isComposing || !state.edit) return;
    syncFromEditor();
  });
  ui.popEditor.addEventListener('compositionend', syncFromEditor);

  function syncFromEditor() {
    const sel = getSelectionOffsets();
    applyChars(parseEditor(), sel);
  }

  ui.popEditor.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeEditor(); }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); insertAtSelection('\n'); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      // Сначала закрывается облачко начертаний, вторым Esc — окно правки.
      if (!ui.popStyleBubble.hidden) setStyleBubble(false);
      else cancelEditor();
    }
    else if (mod && e.code === 'KeyB') { e.preventDefault(); toggleStyle('b'); }
    else if (mod && e.code === 'KeyI') { e.preventDefault(); toggleStyle('i'); }
    else if (mod && e.shiftKey && e.code === 'KeyX') { e.preventDefault(); toggleStyle('s'); }
    else if (mod && e.code === 'KeyZ') { e.preventDefault(); stepHistory(e.shiftKey ? 1 : -1); }
    else if (mod && e.code === 'KeyY') { e.preventDefault(); stepHistory(1); }
    else if (mod && e.code === 'KeyU') e.preventDefault();
  });

  // Вставка — только чистый текст.
  ui.popEditor.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
    if (text) insertAtSelection(text);
  });

  document.addEventListener('selectionchange', () => {
    if (state.edit && document.activeElement === ui.popEditor) updateStyleButtons();
  });

  // Кнопки не забирают фокус у редактора, чтобы не терять выделение.
  [ui.popStyle, ui.popNbsp, ...ui.popStyleBubble.querySelectorAll('button')]
    .forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));

  // Облачко начертаний: открывается кнопкой «Aa», не закрывается после выбора —
  // можно включить несколько начертаний подряд. Закрывается кликом мимо или Esc.
  function setStyleBubble(open) {
    ui.popStyleBubble.hidden = !open;
    ui.popStyle.setAttribute('aria-expanded', String(open));
    if (open) updateStyleButtons();
  }

  ui.popStyle.addEventListener('click', () => setStyleBubble(ui.popStyleBubble.hidden));
  ui.popStyleBubble.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-style]');
    if (btn) toggleStyle(btn.dataset.style);
  });
  document.addEventListener('mousedown', (e) => {
    if (!ui.popStyleBubble.hidden && !e.target.closest('#popStyleMenu')) setStyleBubble(false);
  });

  ui.popNbsp.addEventListener('click', () => {
    ui.popEditor.focus();
    document.execCommand('insertText', false, ' ');
  });

  function renderLegend(chars) {
    const counts = {};
    for (const { c } of chars) {
      const kind = c === '\n' ? 'nl' : HIDDEN_CHARS[c] && HIDDEN_CHARS[c][0];
      if (kind) counts[kind] = (counts[kind] || 0) + 1;
    }
    const parts = Object.keys(LEGEND)
      .filter((k) => counts[k])
      .map((k) => `<span class="k-${k}"><b>${LEGEND[k][0]}</b> ${LEGEND[k][1]} ×${counts[k]}</span>`);
    ui.popLegend.innerHTML = parts.length ? parts.join(' · ') : 'Скрытых символов нет';
  }

  /* ---------- URL ---------- */

  ui.popUrl.addEventListener('input', () => {
    const edit = state.edit;
    stripNewlines(ui.popUrl);
    if (edit && edit.img) { setImageLink(ui.popUrl.value.trim()); return; }
    if (!edit || !edit.link) return;
    edit.link.setAttribute('href', ui.popUrl.value.trim());
    updateListItem(edit.link);
    scheduleSync();
  });

  ui.popUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); closeEditor(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEditor(); }
  });

  // Глаз активен, только когда в поле адрес, который можно открыть в браузере.
  function updateOpenButton() {
    const ok = /^https?:\/\/\S/i.test(ui.popUrl.value.trim());
    ui.popOpen.disabled = !ok;
    ui.popOpen.title = ok ? 'Открыть ссылку в новой вкладке' : 'Нет ссылки, которую можно открыть';
  }

  ui.popUrl.addEventListener('input', updateOpenButton);
  ui.popUrl.addEventListener('input', () => positionPopover());

  ui.popOpen.addEventListener('click', () => {
    const href = ui.popUrl.value.trim();
    if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener');
    else toast('Это не http(s)-ссылка');
  });

  ui.popDone.addEventListener('click', closeEditor);
  ui.popCancel.addEventListener('click', cancelEditor);
  ui.popClose.addEventListener('click', cancelEditor);

  // Клик по пустому месту сцены — применить и закрыть.
  ui.stage.addEventListener('mousedown', (e) => {
    if (!ui.pop.contains(e.target)) closeEditor();
  });

  document.addEventListener('keydown', (e) => {
    // Esc уже обработан полем окна правки (например, закрыло облачко) — второй раз не отменяем.
    if (e.key === 'Escape' && !e.defaultPrevented) cancelEditor();
  });

  /* ---------- Картинка: src, alt и ссылка ---------- */

  // Ссылка, которая охватывает только эту картинку: её можно снять, не задев текст.
  function ownLink(img) {
    const a = img.closest('a');
    if (!a || HAS_TEXT.test(a.textContent)) return null;
    return a.querySelectorAll('img, svg, picture, video').length === 1 ? a : null;
  }

  function unwrap(a) {
    a.replaceWith(...a.childNodes);
  }

  function stripNewlines(field) {
    if (/[\r\n]/.test(field.value)) field.value = field.value.replace(/[\r\n]+/g, '');
  }

  function openImageEditor(target, { scroll = false } = {}) {
    const { img } = target;
    const link = img.closest('a');
    // Для отмены запоминаем «узел картинки»: её собственную ссылку целиком или сам <img>.
    const unit = ownLink(img) || img;
    state.edit = {
      img,
      link,
      created: null,  // ссылка, добавленная в этом окне
      origUnit: unit.cloneNode(true),
      sharedLink: link && !ownLink(img) ? link : null,
      origHref: link ? link.getAttribute('href') : null,
    };

    ui.popTextField.hidden = true;
    ui.popSrcField.hidden = false;
    ui.popAltField.hidden = true;
    ui.popAltToggle.hidden = false;
    ui.popUrlField.hidden = false;
    ui.popHint.style.visibility = 'hidden';
    ui.popUrlLabel.textContent = 'Ссылка';
    ui.popUrl.placeholder = 'https://… — картинка станет ссылкой';
    ui.popSrc.value = img.getAttribute('src') || '';
    ui.popAlt.value = img.getAttribute('alt') || '';
    updateAltPreview();
    ui.popUrl.value = link ? link.getAttribute('href') || '' : '';
    updateOpenButton();
    updateImageLinkUi();

    ui.pop.hidden = false;
    if (scroll) scrollToView(targetRect(target));
    positionPopover();
    if (!scroll) revealPopover();
    hideHoverBox();
    markListActive();
    revealInSource(target);

    ui.popUrl.focus({ preventScroll: true });
    ui.popUrl.setSelectionRange(ui.popUrl.value.length, ui.popUrl.value.length);
  }

  function updateImageLinkUi() {
    const edit = state.edit;
    const link = edit.link;
    const n = link ? state.links.indexOf(link) + 1 : 0;
    ui.popTitle.textContent = link ? (n ? `Картинка · ссылка #${n}` : 'Картинка · ссылка') : 'Картинка';
    ui.popUnlink.hidden = !link;
    const own = link && ownLink(edit.img) === link;
    ui.popUnlink.disabled = !own;
    ui.popUrlNote.hidden = !link || own;
    ui.popUrlNote.textContent = 'Ссылка охватывает не только картинку — её адрес поменяется у всего блока.';
  }

  // Ввод в поле ссылки: нет ссылки — оборачиваем один <img>; есть — меняем адрес.
  function setImageLink(href) {
    const edit = state.edit;
    const { img } = edit;
    let a = img.closest('a');
    if (!a && href) {
      a = state.doc.createElement('a');
      a.setAttribute('href', href);
      a.setAttribute('target', '_blank');
      img.replaceWith(a);
      a.append(img);
      edit.created = a;
    } else if (a && !href && a === edit.created) {
      // Стёрли адрес у только что добавленной ссылки — убираем и её.
      unwrap(a);
      edit.created = null;
      a = null;
    } else if (a) {
      a.setAttribute('href', href);
    }
    edit.link = a;
    afterImageChange();
  }

  function removeImageLink() {
    const edit = state.edit;
    const a = edit && ownLink(edit.img);
    if (!a) return;
    unwrap(a);
    if (a === edit.created) edit.created = null;
    edit.link = null;
    ui.popUrl.value = '';
    updateOpenButton();
    afterImageChange();
  }

  function afterImageChange() {
    updateImageLinkUi();
    fitFrame();
    scheduleSync();
    markListActive();
  }

  function cancelImageEdit(edit) {
    const { img } = edit;
    const current = ownLink(img) || img;
    current.replaceWith(edit.origUnit.cloneNode(true));
    if (edit.sharedLink) {
      if (edit.origHref == null) edit.sharedLink.removeAttribute('href');
      else edit.sharedLink.setAttribute('href', edit.origHref);
    }
    fitFrame();
    scheduleSync();
    closeEditor();
  }

  ui.popSrc.addEventListener('input', () => {
    const edit = state.edit;
    if (!edit || !edit.img) return;
    stripNewlines(ui.popSrc);
    edit.img.setAttribute('src', ui.popSrc.value.trim());
    scheduleSync();
  });

  ui.popAlt.addEventListener('input', () => {
    const edit = state.edit;
    if (!edit || !edit.img) return;
    stripNewlines(ui.popAlt);
    edit.img.setAttribute('alt', ui.popAlt.value);
    if (edit.link) updateListItem(edit.link);
    scheduleSync();
  });

  [ui.popSrc, ui.popAlt].forEach((field) => field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); closeEditor(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEditor(); }
  }));

  ui.popUnlink.addEventListener('click', removeImageLink);

  // Альт-текст свёрнут до ссылки с текущим значением; поле — по клику.
  function updateAltPreview() {
    const alt = ui.popAlt.value.trim();
    ui.popAltPreview.textContent = alt ? `· «${alt}»` : '· не задан';
  }

  ui.popAltToggle.addEventListener('click', () => {
    ui.popAltToggle.hidden = true;
    ui.popAltField.hidden = false;
    positionPopover();
    ui.popAlt.focus({ preventScroll: true });
    ui.popAlt.setSelectionRange(ui.popAlt.value.length, ui.popAlt.value.length);
  });

  /* ================= Подсветка в исходном коде ================= */

  const SRC_MARK_A = 'elk-src-start';
  const SRC_MARK_B = 'elk-src-end';
  let flashTimer = null;

  // Находим фрагмент цели в коде слева: временно оборачиваем её комментариями-метками,
  // сериализуем документ и ищем метки в строке.
  function revealInSource(target) {
    if (!state.doc || document.activeElement === ui.source) return;
    const single = target.img ? (ownLink(target.img) || target.img) : target.link;
    const first = target.run ? target.run.nodes[0] : single;
    const last = target.run ? target.run.nodes[target.run.nodes.length - 1] : single;
    const a = state.doc.createComment(SRC_MARK_A);
    const b = state.doc.createComment(SRC_MARK_B);
    first.parentNode.insertBefore(a, first);
    last.parentNode.insertBefore(b, last.nextSibling);
    let html;
    try { html = exportHtml(); } finally { a.remove(); b.remove(); }

    const ma = `<!--${SRC_MARK_A}-->`;
    const mb = `<!--${SRC_MARK_B}-->`;
    const ia = html.indexOf(ma);
    const ib = html.indexOf(mb);
    if (ia < 0 || ib < 0) return;
    const code = html.slice(0, ia) + html.slice(ia + ma.length, ib) + html.slice(ib + mb.length);
    let start = ia;
    let end = ib - ma.length;
    // Отступы и переносы по краям текстового блока не подсвечиваем.
    while (start < end && /\s/.test(code[start])) start++;
    while (end > start && /\s/.test(code[end - 1])) end--;

    // Код слева приводим к сериализованному виду, иначе позиции не совпадут.
    if (ui.source.value !== code) ui.source.value = code;  // подложку перерисует flashSource
    flashSource(start, end);
  }

  /* ---------- Раскраска кода ----------
     textarea прозрачная, цветной код рисуется на подложке под ней:
     разметка — серым, текст письма — основным цветом, адреса ссылок — синим. */

  const SOURCE_TOKEN = /<!--[\s\S]*?-->|<(script|style|title)\b[\s\S]*?<\/\1\s*>|<[^>]*>/gi;
  const HREF_ATTR = /(\shref\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/i;

  // Участки кода: [{ start, end, cls }], cls — '' (разметка), 'c-text' или 'c-link'.
  function sourceSegments(code) {
    const segs = [];
    const push = (start, end, cls) => { if (end > start) segs.push({ start, end, cls }); };
    const body = code.search(/<body\b/i);
    const bodyStart = body < 0 ? 0 : body;
    let pos = 0;
    SOURCE_TOKEN.lastIndex = 0;
    for (let m; (m = SOURCE_TOKEN.exec(code)); ) {
      // Текст между тегами — внутри body он редактируемый.
      push(pos, m.index, m.index > bodyStart && HAS_TEXT.test(code.slice(pos, m.index)) ? 'c-text' : '');
      const tag = m[0];
      const href = /^<a\s/i.test(tag) && HREF_ATTR.exec(tag);
      if (href) {
        const vStart = m.index + href.index + href[1].length;
        const vEnd = vStart + href[2].length;
        push(m.index, vStart, '');
        push(vStart, vEnd, 'c-link');
        push(vEnd, m.index + tag.length, '');
      } else {
        push(m.index, m.index + tag.length, '');
      }
      pos = m.index + tag.length;
    }
    push(pos, code.length, pos > bodyStart && HAS_TEXT.test(code.slice(pos)) ? 'c-text' : '');
    return segs;
  }

  // Перерисовать подложку. markRange — [start, end] для вспышки; вернёт её <mark>.
  function paintSource(markRange) {
    const code = ui.source.value;
    const bd = ui.sourceBackdrop;
    const [ms, me] = markRange || [-1, -1];
    const cuts = markRange ? [ms, me] : [];
    let html = '';
    for (const seg of sourceSegments(code)) {
      // Режем участки по границам вспышки, чтобы <mark> вложился без пересечений.
      const points = [seg.start, ...cuts.filter((c) => c > seg.start && c < seg.end), seg.end];
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        if (a === ms) html += '<mark>';
        const text = escapeText(code.slice(a, points[i + 1]));
        html += seg.cls ? `<span class="${seg.cls}">${text}</span>` : text;
        if (points[i + 1] === me) html += '</mark>';
      }
    }
    if (markRange && ms === me) html += '<mark> </mark>';
    // Код переносится по ширине, поэтому ширина строки у подложки должна совпадать
    // с textarea до пикселя — учитываем её полосу прокрутки.
    const scrollbar = ui.source.offsetWidth - ui.source.clientWidth;
    bd.style.paddingRight = `calc(var(--space-4) + ${scrollbar}px)`;
    bd.innerHTML = html + '\n';
    syncSourceScroll();
    return markRange ? bd.querySelector('mark') : null;
  }

  const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function setSource(value) {
    ui.source.value = value;
    paintSource();
  }

  function flashSource(start, end) {
    const mark = paintSource([start, end]);
    clearTimeout(flashTimer);

    const ta = ui.source;
    const markTop = mark.offsetTop;
    const markBottom = markTop + mark.offsetHeight;
    const visible = markTop >= ta.scrollTop && markBottom <= ta.scrollTop + ta.clientHeight;
    const top = visible ? ta.scrollTop : Math.max(0, markTop - ta.clientHeight / 3);

    // Подсветка загорается по прибытии, а не во время перехода.
    moveSourceTo(top, () => {
      mark.classList.add('is-lit');
      flashTimer = setTimeout(() => paintSource(), 2800);
    });
  }

  /* ---------- Переход по коду ----------
     Время перехода не зависит от расстояния:
     рядом — короткая прокрутка фиксированной длительности,
     далеко — «телепорт»: код гаснет, перескакивает и проявляется на месте. */

  const TELEPORT_OUT = 150;
  const TELEPORT_IN = 260;
  const TWEEN = 320;
  let sourceAnims = [];
  let tweenFrame = 0;

  function setSourceScroll(top) {
    ui.source.scrollTop = top;
    syncSourceScroll();
  }

  function stopSourceMotion() {
    cancelAnimationFrame(tweenFrame);
    sourceAnims.forEach((a) => a.cancel());
    sourceAnims = [];
  }

  function moveSourceTo(top, onArrive) {
    stopSourceMotion();
    const from = ui.source.scrollTop;
    const dist = top - from;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (Math.abs(dist) < 2 || reduce) {
      setSourceScroll(top);
      onArrive();
    } else if (Math.abs(dist) <= ui.source.clientHeight * 0.75) {
      tweenSource(from, top, onArrive);
    } else {
      teleportSource(top, Math.sign(dist), onArrive);
    }
  }

  function tweenSource(from, to, onArrive) {
    const t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / TWEEN);
      setSourceScroll(from + (to - from) * ease(t));
      if (t < 1) tweenFrame = requestAnimationFrame(step);
      else onArrive();
    };
    tweenFrame = requestAnimationFrame(step);
  }

  // dir > 0 — едем вниз по коду: старое уходит вверх, новое приходит снизу.
  function teleportSource(top, dir, onArrive) {
    const layers = [ui.source, ui.sourceBackdrop];
    const still = { opacity: 1, transform: 'none', filter: 'blur(0)' };
    const away = (y) => ({ opacity: 0, transform: `translateY(${y}px)`, filter: 'blur(3px)' });

    const out = layers.map((el) => el.animate([still, away(-dir * 10)], {
      duration: TELEPORT_OUT, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards',
    }));
    sourceAnims = out;

    out[0].finished.then(() => {
      setSourceScroll(top);
      const inn = layers.map((el) => el.animate([away(dir * 14), still], {
        duration: TELEPORT_IN, easing: 'cubic-bezier(.2,.8,.3,1)',
      }));
      out.forEach((a) => a.cancel());
      sourceAnims = inn;
      onArrive();
    }).catch(() => { /* переход прерван новым выбором */ });
  }

  function syncSourceScroll() {
    ui.sourceBackdrop.scrollTop = ui.source.scrollTop;
  }

  ui.source.addEventListener('scroll', syncSourceScroll);

  /* ================= Синхронизация ================= */

  let syncTimer = null;

  // После правок: пересобираем список ссылок и код слева (с задержкой, чтобы не тормозить ввод).
  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      scanLinks();
      const html = exportHtml();
      if (ui.source.value !== html) setSource(html);
    }, 250);
  }

  function scanLinks() {
    if (!state.doc) return;
    state.links = Array.from(state.doc.querySelectorAll('a'));
    for (const a of state.links) {
      if (!a.hasAttribute(ID_ATTR)) a.setAttribute(ID_ATTR, String(state.nextId++));
    }
    renderList();
  }

  function exportHtml() {
    if (!state.doc) return ui.source.value;
    const out = state.doc.cloneNode(true);
    restore(out);
    return state.isFragment ? out.body.innerHTML : serializeDocument(out);
  }

  function serializeDocument(doc) {
    const dt = doc.doctype;
    let head = '';
    if (dt) {
      head = `<!DOCTYPE ${dt.name}`;
      if (dt.publicId) head += ` PUBLIC "${dt.publicId}"`;
      if (dt.systemId) head += `${dt.publicId ? '' : ' SYSTEM'} "${dt.systemId}"`;
      head += '>\n';
    }
    return head + doc.documentElement.outerHTML;
  }

  /* ================= Список ссылок ================= */

  function describe(a) {
    const text = a.textContent.replace(/\s+/g, ' ').trim();
    const img = a.querySelector('img');
    const href = a.getAttribute('href');
    let label = text;
    let dim = false;
    if (!text) {
      dim = true;
      label = img ? `картинка${img.getAttribute('alt') ? ': ' + img.getAttribute('alt') : ''}` : 'без текста';
    }
    const h = href == null ? null : href.trim();
    const warn = h == null || h === '' || h === '#' || /^javascript:/i.test(h);
    return { label, dim, href: h == null ? '— нет href —' : (h || '— пусто —'), warn };
  }

  // Цель для ссылки из списка: первый текстовый блок внутри неё, иначе — ссылка-картинка.
  function linkTarget(a) {
    const walker = state.doc.createTreeWalker(a, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (hasText(t)) {
        const run = runFromNode(t);
        if (run) return { run, link: a };
      }
    }
    const img = a.querySelector('img');
    return img ? { img, link: a } : { run: null, link: a };
  }

  function renderList() {
    ui.list.innerHTML = '';
    ui.count.textContent = String(state.links.length);
    ui.countBtn.textContent = String(state.links.length);
    // Нет ссылок — вкладка неактивна.
    ui.linksToggle.disabled = !state.links.length;
    ui.linksToggle.title = state.links.length ? 'Список ссылок' : 'В письме нет ссылок';
    const warns = state.links.filter((a) => describe(a).warn).length;
    ui.warnBtn.hidden = !warns;
    ui.warnBtn.title = warns ? `Проблемных ссылок: ${warns}` : '';

    if (!state.links.length) {
      const li = document.createElement('li');
      li.className = 'link-empty';
      li.textContent = state.doc ? 'В документе нет ссылок.' : 'Здесь появятся ссылки из документа.';
      ui.list.appendChild(li);
      notifyLinksChange();
      return;
    }

    state.links.forEach((a, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link-item';
      btn.dataset.id = a.getAttribute(ID_ATTR);
      btn.innerHTML = '<span class="link-num"></span><span class="link-text"></span><span class="link-href"></span>';
      btn.querySelector('.link-num').textContent = i + 1;
      btn.addEventListener('click', () => openEditor(linkTarget(a), { scroll: true }));
      li.appendChild(btn);
      ui.list.appendChild(li);
      updateListItem(a, btn);
    });
    markListActive();
    notifyLinksChange();
  }

  function updateListItem(a, btn) {
    btn = btn || ui.list.querySelector(`.link-item[data-id="${a.getAttribute(ID_ATTR)}"]`);
    if (!btn) return;
    const d = describe(a);
    const text = btn.querySelector('.link-text');
    text.textContent = d.label;
    text.classList.toggle('is-dim', d.dim);
    btn.querySelector('.link-href').textContent = d.href;
    btn.title = d.href;
    btn.classList.toggle('is-warn', d.warn);
  }

  function markListActive() {
    const link = state.edit && state.edit.link;
    const activeId = link ? link.getAttribute(ID_ATTR) : null;
    ui.list.querySelectorAll('.link-item').forEach((b) => {
      const on = b.dataset.id === activeId;
      b.classList.toggle('is-active', on);
      // Прокручиваем только сам список: scrollIntoView потянул бы за собой
      // и раскладку к спрятанной за краем панели.
      if (on) {
        const list = ui.list;
        const top = b.offsetTop - list.offsetTop;
        if (top < list.scrollTop) list.scrollTop = top - 8;
        else if (top + b.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + b.offsetHeight - list.clientHeight + 8;
      }
    });
  }

  /* ================= Интерфейс для модулей =================
     Модули (например, utm.js) подключаются отдельным <script> после app.js и работают
     только через этот интерфейс. Если модуль не подключён, интерфейс просто никто не использует. */

  const linksListeners = [];
  function notifyLinksChange() {
    for (const fn of linksListeners) {
      try { fn(); } catch (err) { console.error(err); }
    }
  }

  window.EmailLinksApp = {
    // Ссылки письма (<a> из превью) в порядке документа.
    getLinks: () => state.links.slice(),
    // Номер в списке и подпись ссылки: текст или «картинка: alt».
    linkInfo: (a) => ({ n: state.links.indexOf(a) + 1, ...describe(a) }),
    // Список ссылок пересобран (загрузка письма, правка, вставка нового кода).
    onLinksChange: (fn) => { linksListeners.push(fn); },
    // Модуль поменял href у ссылок — обновить список и код слева.
    linksChanged: (links) => {
      links.forEach((a) => updateListItem(a));
      scheduleSync();
    },
    // Открыть ссылку на правку, как по клику в превью.
    openLink: (a) => {
      if (state.doc && a.isConnected) openEditor(linkTarget(a), { scroll: true });
    },
    // Защита поля от подсказок менеджеров паролей (см. guardFromAutofill).
    guardField: (el) => guardFromAutofill(el),
    linksPanel: ui.linksPanel,
    linksList: ui.list,
  };

  /* ================= Выезжающая панель ссылок ================= */

  const LINKS_OPEN_KEY = 'elk:linksOpen';

  function setLinksOpen(open) {
    ui.linksPanel.classList.toggle('is-open', open);
    ui.linksPanel.setAttribute('aria-hidden', String(!open));
    ui.linksToggle.setAttribute('aria-expanded', String(open));
    try { localStorage.setItem(LINKS_OPEN_KEY, open ? '1' : ''); } catch { /* хранилище недоступно — не страшно */ }
    // Окно правки перестраивается под новое свободное место.
    positionPopover();
  }

  ui.linksToggle.addEventListener('click', () => setLinksOpen(!ui.linksPanel.classList.contains('is-open')));
  ui.linksClose.addEventListener('click', () => setLinksOpen(false));

  try { if (localStorage.getItem(LINKS_OPEN_KEY)) setLinksOpen(true); } catch { /* по умолчанию свёрнута */ }

  /* ================= Защита от подсказок менеджеров паролей =================
     Расширение «Пароли iCloud» предлагает логины при фокусе в любое текстовое поле.
     Поле «только для чтения» оно пропускает, поэтому пометку держим до фокуса
     и снимаем сразу после него; при уходе из поля — возвращаем. */

  function guardFromAutofill(el) {
    el.addEventListener('focus', () => setTimeout(() => el.removeAttribute('readonly'), 50));
    el.addEventListener('blur', () => el.setAttribute('readonly', ''));
  }

  guardFromAutofill(ui.source);
  guardFromAutofill(ui.popUrl);
  guardFromAutofill(ui.popSrc);
  guardFromAutofill(ui.popAlt);

  /* ================= Сворачивание панели кода ================= */

  const SOURCE_COLLAPSED_KEY = 'elk:sourceCollapsed';
  const sourcePanel = $('#sourcePanel');
  const sourceToggle = $('#sourceToggle');
  const layout = $('.layout');

  // Ширина свёрнутой панели — ровно заголовок и кнопка с внутренними отступами шапки.
  function collapsedSourceWidth() {
    const head = sourcePanel.querySelector('.panel-head');
    const cs = getComputedStyle(head);
    let w = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const items = Array.from(head.children);
    for (const el of items) w += el.getBoundingClientRect().width;
    w += (parseFloat(cs.columnGap) || 0) * (items.length - 1) + 16;  // воздух между заголовком и кнопкой
    const ps = getComputedStyle(sourcePanel);
    return Math.ceil(w + parseFloat(ps.borderLeftWidth) + parseFloat(ps.borderRightWidth));
  }

  // Колонки анимируются только между явными значениями в px, поэтому на время перехода
  // фиксируем текущую ширину, а в развёрнутом виде потом возвращаем гибкую раскладку из CSS.
  function setSourceCollapsed(collapsed, { animate = true } = {}) {
    const from = sourcePanel.getBoundingClientRect().width;
    sourcePanel.classList.toggle('is-collapsed', collapsed);
    sourceToggle.setAttribute('aria-expanded', String(!collapsed));
    sourceToggle.title = collapsed ? 'Развернуть код' : 'Свернуть код';
    sourceToggle.setAttribute('aria-label', sourceToggle.title);
    try { localStorage.setItem(SOURCE_COLLAPSED_KEY, collapsed ? '1' : ''); } catch { /* не запомнится — не страшно */ }

    const target = collapsed ? collapsedSourceWidth() : null;
    // На узком экране панели стоят друг под другом — ширину колонки не трогаем, только размытие.
    if (window.matchMedia('(max-width: 720px)').matches) {
      layout.style.gridTemplateColumns = '';
      afterSourceResize();
      return;
    }
    if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      layout.style.gridTemplateColumns = collapsed ? `${target}px 1fr` : '';
      afterSourceResize();
      return;
    }
    let to = target;
    if (!collapsed) {
      // Ширина, которую даст гибкая раскладка, — замеряем без анимации.
      layout.style.transition = 'none';
      layout.style.gridTemplateColumns = '';
      to = sourcePanel.getBoundingClientRect().width;
      layout.style.gridTemplateColumns = `${from}px 1fr`;
      void layout.offsetWidth;
      layout.style.transition = '';
    } else {
      layout.style.transition = 'none';
      layout.style.gridTemplateColumns = `${from}px 1fr`;
      void layout.offsetWidth;
      layout.style.transition = '';
    }
    layout.style.gridTemplateColumns = `${to}px 1fr`;
    const done = (e) => {
      if (e && e.target !== layout) return;
      layout.removeEventListener('transitionend', done);
      if (!sourcePanel.classList.contains('is-collapsed')) layout.style.gridTemplateColumns = '';
      afterSourceResize();
    };
    layout.addEventListener('transitionend', done);
  }

  // Превью и код поменяли ширину — пересчитываем высоту письма, окно правки и раскраску.
  function afterSourceResize() {
    fitFrame();
    positionPopover();
    paintSource();
  }

  sourceToggle.addEventListener('click', () => setSourceCollapsed(!sourcePanel.classList.contains('is-collapsed')));
  $('#sourceWrap').addEventListener('click', () => {
    if (sourcePanel.classList.contains('is-collapsed')) setSourceCollapsed(false);
  });

  try { if (localStorage.getItem(SOURCE_COLLAPSED_KEY)) setSourceCollapsed(true, { animate: false }); } catch { /* по умолчанию развёрнута */ }

  /* ================= Тема оформления ================= */

  const THEME_KEY = 'elk:theme';
  const themeSwitch = $('#themeSwitch');

  // 'auto' — как в системе (атрибута нет), 'light' / 'dark' — принудительно.
  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
    const current = document.documentElement.getAttribute('data-theme') || 'auto';
    themeSwitch.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.themeValue === current;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  themeSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const theme = btn.dataset.themeValue;
    applyTheme(theme);
    try { localStorage.setItem(THEME_KEY, theme === 'auto' ? '' : theme); } catch { /* хранилище недоступно — тема просто не запомнится */ }
    paintSource();
  });

  applyTheme(document.documentElement.getAttribute('data-theme') || 'auto');

  /* ================= Панель и экспорт ================= */

  let sourceTimer = null;
  ui.source.addEventListener('input', () => {
    // Код поменялся — подсветка больше не на своём месте.
    stopSourceMotion();
    clearTimeout(flashTimer);
    paintSource();
    clearTimeout(sourceTimer);
    sourceTimer = setTimeout(() => loadSource(ui.source.value), 400);
  });

  ui.device.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    ui.device.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b === btn));
    ui.frame.style.width = btn.dataset.width ? btn.dataset.width + 'px' : '';
    hideHover();
    setTimeout(() => { fitFrame(); positionPopover(); }, 220); // после CSS-перехода ширины
  });

  window.addEventListener('resize', () => { fitFrame(); positionPopover(); hideHover(); paintSource(); });

  $('#btnSample').addEventListener('click', () => {
    setSource(window.SAMPLE_HTML || '');
    loadSource(ui.source.value);
  });

  $('#btnClear').addEventListener('click', () => {
    setSource('');
    loadSource('');
    ui.source.focus();
  });

  $('#btnCopy').addEventListener('click', async () => {
    const html = exportHtml();
    if (!html.trim()) return toast('Нечего копировать');
    try {
      await navigator.clipboard.writeText(html);
    } catch {
      setSource(html);
      ui.source.select();
      document.execCommand('copy');
    }
    toast('HTML скопирован');
  });

  $('#btnDownload').addEventListener('click', () => {
    const html = exportHtml();
    if (!html.trim()) return toast('Нечего скачивать');
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'email.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  let toastTimer = null;
  function toast(msg) {
    ui.toast.textContent = msg;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 1800);
  }

  loadSource('');
})();
