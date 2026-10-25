// Lerværk (fiktivt designkoncept). Filter, produktvalg, kurv og en kasse uden betaling.
// Kurven ligger kun i browserens lokale lager. Intet bliver solgt, betalt eller sendt.
(function () {
  'use strict';
  document.documentElement.classList.add('js');

  var KEY = 'lervaerk-demo-kurv';
  var memory = [];

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }
  function kr(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' kr.'; }
  function kr2(n) {
    var s = n.toFixed(2).split('.');
    return s[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + s[1] + ' kr.';
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  ready(function () {
    var DATA = window.LERVAERK;
    if (!DATA) return;
    var root = document.body.getAttribute('data-root') || '';

    function product(id) { return DATA.products.filter(function (p) { return p.id === id; })[0]; }
    function variant(p, id) { return p.variants.filter(function (v) { return v.id === id; })[0]; }

    // Kurv i localStorage. Kan den ikke gemmes, virker den kun på den aktuelle side.
    function load() {
      try {
        var raw = JSON.parse(localStorage.getItem(KEY) || '[]');
        return Array.isArray(raw) ? raw.filter(function (l) { var p = product(l.p); return p && variant(p, l.v) && l.q > 0; }) : [];
      } catch (e) { return memory.slice(); }
    }
    function save(lines) {
      memory = lines.slice();
      try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch (e) { /* privat vindue: kun i hukommelsen */ }
      updateCount();
    }
    function count(lines) { return lines.reduce(function (n, l) { return n + l.q; }, 0); }
    function subtotal(lines) { return lines.reduce(function (s, l) { return s + variant(product(l.p), l.v).price * l.q; }, 0); }
    function shipping(sub, method) {
      if (method === 'afhent' || sub === 0) return 0;
      return sub >= DATA.shipping.freeOver ? 0 : DATA.shipping.pakkeshop;
    }
    function updateCount() {
      var n = count(load());
      document.querySelectorAll('[data-cart-count]').forEach(function (c) {
        c.textContent = n;
        c.setAttribute('aria-label', n === 1 ? '1 vare' : n + ' varer');
      });
    }
    function lineName(l) {
      var p = product(l.p), v = variant(p, l.v);
      return p.variants.length > 1 ? p.name + ', ' + v.name.toLowerCase() : p.name;
    }
    function totalsInto(dl, lines, method, label) {
      var sub = subtotal(lines), ship = shipping(sub, method), total = sub + ship;
      dl.innerHTML = '';
      [['Varer (' + count(lines) + ')', kr(sub)], [label || 'Fragt', ship === 0 ? (method === 'afhent' ? '0 kr.' : 'Gratis') : kr(ship)], ['I alt', kr(total)]].forEach(function (r, i) {
        var d = el('div', i === 2 ? 'total' : '');
        d.appendChild(el('dt', '', r[0])); d.appendChild(el('dd', 'num', r[1]));
        dl.appendChild(d);
      });
      var vat = el('div');
      vat.appendChild(el('dt', 'vat', 'Heraf moms')); vat.appendChild(el('dd', 'vat num', kr2(total / 5)));
      dl.appendChild(vat);
      return total;
    }
    function imgFor(v, size) { return root + 'assets/img/' + v.img + '-' + size + '.webp'; }

    updateCount();

    // Mobilmenu
    var btn = document.querySelector('.menu-btn');
    var nav = document.getElementById('menu');
    if (btn && nav) {
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!open));
        nav.classList.toggle('is-open', !open);
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && btn.getAttribute('aria-expanded') === 'true') {
          btn.setAttribute('aria-expanded', 'false');
          nav.classList.remove('is-open');
          btn.focus();
        }
      });
    }

    // Filter på forsiden
    var filter = document.querySelector('[data-filter]');
    var grid = document.querySelector('[data-grid]');
    if (filter && grid) {
      filter.hidden = false;
      var status = document.querySelector('[data-filter-status]');
      var buttons = filter.querySelectorAll('button');
      var show = function (cat, announce) {
        var n = 0;
        grid.querySelectorAll('li').forEach(function (li) {
          var hit = cat === 'alle' || li.getAttribute('data-cat') === cat;
          li.hidden = !hit; if (hit) n++;
        });
        buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-cat') === cat)); });
        if (status && announce) status.textContent = 'Viser ' + n + (n === 1 ? ' vare' : ' varer');
      };
      buttons.forEach(function (b) {
        b.addEventListener('click', function () {
          var cat = b.getAttribute('data-cat');
          show(cat, true);
          if (history.replaceState) history.replaceState(null, '', cat === 'alle' ? location.pathname + '#sortiment' : '?kategori=' + cat + '#sortiment');
        });
      });
      var pre = new URLSearchParams(location.search).get('kategori');
      if (pre && filter.querySelector('[data-cat="' + pre.replace(/[^a-z]/g, '') + '"]')) show(pre, true);
    }

    // Produktside
    var buy = document.querySelector('[data-buy]');
    if (buy) {
      var p = product(document.querySelector('[data-product]').getAttribute('data-product'));
      var qty = buy.querySelector('#antal');
      var qtyError = buy.querySelector('[data-qty-error]');
      var addBtn = buy.querySelector('[data-add]');
      var added = buy.querySelector('[data-added]');
      var priceEl = buy.querySelector('[data-price]');
      var stockEl = buy.querySelector('[data-stock]');
      var nameEl = buy.querySelector('[data-variant-name]');
      var img = document.querySelector('[data-product-img]');

      var currentV = function () {
        var r = buy.querySelector('input[name="variant"]:checked') || buy.querySelector('input[name="variant"]');
        return variant(p, r.value);
      };
      var inCart = function (v) { var l = load().filter(function (x) { return x.p === p.id && x.v === v.id; })[0]; return l ? l.q : 0; };
      var check = function () {
        var v = currentV(), raw = qty.value.trim(), n = Number(raw), msg = '';
        if (v.stock === 0) msg = '';
        else if (!/^\d+$/.test(raw) || n < 1) msg = 'Vælg et antal på mindst 1.';
        else if (n + inCart(v) > v.stock) {
          var left = v.stock - inCart(v);
          msg = inCart(v) ? 'Du har allerede ' + inCart(v) + ' i kurven. Der er kun ' + v.stock + ' på lager, så du kan lægge ' + (left > 0 ? left + ' mere i.' : 'ikke flere i.')
            : 'Der er kun ' + v.stock + ' på lager' + (p.variants.length > 1 ? ' i ' + v.name.toLowerCase() : '') + '.';
        }
        qtyError.textContent = msg;
        qty.setAttribute('aria-invalid', msg ? 'true' : 'false');
        buy.querySelector('[data-qty="-1"]').disabled = n <= 1 || v.stock === 0;
        buy.querySelector('[data-qty="1"]').disabled = v.stock === 0 || n + inCart(v) >= v.stock;
        return !msg;
      };
      var refresh = function () {
        var v = currentV();
        priceEl.textContent = kr(v.price);
        if (nameEl) nameEl.textContent = v.name;
        stockEl.className = 'stock' + (v.stock === 0 ? ' stock--out' : v.stock <= 3 ? ' stock--low' : '');
        stockEl.textContent = v.stock === 0 ? (p.variants.length > 1 ? 'Udsolgt i ' + v.name.toLowerCase() + '. Vælg en anden ' + p.vlabel.toLowerCase() + ', eller kom igen efter næste brænding.' : 'Udsolgt. Kommer igen ved næste brænding.')
          : (v.stock > 3 ? v.stock + ' på lager' : 'Kun ' + v.stock + ' på lager');
        addBtn.disabled = v.stock === 0;
        addBtn.textContent = v.stock === 0 ? 'Udsolgt' : 'Læg i kurv';
        qty.disabled = v.stock === 0;
        if (img && img.getAttribute('src').indexOf(v.img + '-') === -1) {
          img.src = imgFor(v, 1200);
          img.srcset = imgFor(v, 800) + ' 800w, ' + imgFor(v, 1200) + ' 1200w';
          img.alt = (img.getAttribute('data-alt') || '').replace('{v}', v.name.toLowerCase());
        }
        check();
      };
      buy.addEventListener('change', function (e) { if (e.target.name === 'variant') { added.hidden = true; refresh(); } });
      qty.addEventListener('input', check);
      buy.querySelectorAll('[data-qty]').forEach(function (b) {
        b.addEventListener('click', function () {
          var n = Math.max(1, (parseInt(qty.value, 10) || 0) + Number(b.getAttribute('data-qty')));
          qty.value = n; check();
        });
      });
      buy.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = currentV();
        if (v.stock === 0 || !check()) { qty.focus(); return; }
        var n = Number(qty.value), lines = load();
        var line = lines.filter(function (x) { return x.p === p.id && x.v === v.id; })[0];
        if (line) line.q += n; else lines.push({ p: p.id, v: v.id, q: n });
        save(lines);
        added.innerHTML = '';
        added.appendChild(el('span', '', 'Lagt i kurven: ' + n + ' × ' + lineName({ p: p.id, v: v.id }) + '.'));
        var a = el('a', 'link', 'Gå til kurven'); a.href = root + 'kurv';
        added.appendChild(a);
        added.hidden = false;
        qty.value = 1;
        check();
      });
      refresh();
    }

    // Kurv
    var cartBox = document.querySelector('[data-cart]');
    if (cartBox) {
      var linesEl = cartBox.querySelector('[data-lines]');
      var totalsEl = cartBox.querySelector('[data-totals]');
      var empty = document.querySelector('[data-empty]');
      var undo = document.querySelector('[data-undo]');
      var removed = null;

      var render = function (focusKey) {
        var lines = load();
        empty.hidden = lines.length > 0;
        cartBox.hidden = lines.length === 0;
        linesEl.innerHTML = '';
        lines.forEach(function (l) {
          var p = product(l.p), v = variant(p, l.v), key = l.p + ':' + l.v;
          var li = el('li', 'line');
          var pic = el('div', 'line__img');
          var im = el('img'); im.src = imgFor(v, 400); im.alt = ''; im.width = 400; im.height = 500; im.loading = 'lazy';
          pic.appendChild(im);
          var info = el('div');
          var name = el('p', 'line__name'); var a = el('a', '', p.name); a.href = root + 'produkter/' + p.id; name.appendChild(a);
          info.appendChild(name);
          info.appendChild(el('p', 'line__meta', (p.variants.length > 1 ? p.vlabel + ': ' + v.name + ', ' : '') + kr(v.price) + ' pr. stk.'));
          var tot = el('p', 'line__total', kr(v.price * l.q));
          var ctrl = el('div', 'line__ctrl');
          var q = el('div', 'qty');
          var minus = el('button', '', '−'); minus.type = 'button'; minus.setAttribute('aria-label', 'Færre ' + lineName(l)); minus.disabled = l.q <= 1;
          var input = el('input'); input.type = 'number'; input.inputMode = 'numeric'; input.min = 1; input.max = v.stock; input.value = l.q;
          input.id = 'q-' + key.replace(':', '-'); input.setAttribute('aria-label', 'Antal ' + lineName(l));
          var plus = el('button', '', '+'); plus.type = 'button'; plus.setAttribute('aria-label', 'Flere ' + lineName(l)); plus.disabled = l.q >= v.stock;
          q.appendChild(minus); q.appendChild(input); q.appendChild(plus);
          var rm = el('button', 'textbtn', 'Fjern'); rm.type = 'button'; rm.setAttribute('aria-label', 'Fjern ' + lineName(l));
          ctrl.appendChild(q); ctrl.appendChild(rm);
          var err = el('p', 'error'); err.id = input.id + '-error'; input.setAttribute('aria-describedby', err.id);
          li.appendChild(pic); li.appendChild(info); li.appendChild(tot); li.appendChild(ctrl); li.appendChild(err);
          linesEl.appendChild(li);

          var setQty = function (n, focusEl) {
            var all = load(), line = all.filter(function (x) { return x.p === l.p && x.v === l.v; })[0];
            if (!line) return;
            line.q = n; save(all); render(focusEl);
          };
          minus.addEventListener('click', function () { setQty(Math.max(1, l.q - 1), key + ':minus'); });
          plus.addEventListener('click', function () { if (l.q < v.stock) setQty(l.q + 1, key + ':plus'); });
          input.addEventListener('change', function () {
            var raw = input.value.trim(), n = Number(raw);
            if (!/^\d+$/.test(raw) || n < 1) { err.textContent = 'Skriv et antal på mindst 1, eller fjern varen.'; input.setAttribute('aria-invalid', 'true'); return; }
            if (n > v.stock) { err.textContent = 'Der er kun ' + v.stock + ' på lager. Antallet er sat til ' + v.stock + '.'; n = v.stock; }
            else err.textContent = '';
            input.setAttribute('aria-invalid', 'false');
            var msg = err.textContent;
            setQty(n, key + ':input');
            if (msg) { var e2 = document.getElementById(input.id + '-error'); if (e2) e2.textContent = msg; }
          });
          rm.addEventListener('click', function () {
            var all = load(), idx = -1;
            all.forEach(function (x, i) { if (x.p === l.p && x.v === l.v) idx = i; });
            if (idx < 0) return;
            removed = { line: all[idx], index: idx };
            all.splice(idx, 1); save(all);
            undo.innerHTML = '';
            undo.appendChild(el('span', '', lineName(l) + ' er fjernet fra kurven.'));
            var ub = el('button', 'textbtn', 'Fortryd'); ub.type = 'button';
            ub.addEventListener('click', function () {
              if (!removed) return;
              var now = load(); now.splice(Math.min(removed.index, now.length), 0, removed.line); save(now);
              removed = null; undo.hidden = true; render(l.p + ':' + l.v + ':input');
            });
            undo.appendChild(ub);
            undo.hidden = false;
            render();
            ub.focus();
          });
          if (focusKey && focusKey.indexOf(key + ':') === 0) {
            var which = focusKey.split(':')[2];
            (which === 'minus' ? (minus.disabled ? input : minus) : which === 'plus' ? (plus.disabled ? input : plus) : input).focus();
          }
        });
        if (lines.length) totalsInto(totalsEl, lines, 'pakkeshop', 'Fragt, pakkeshop');
      };
      render();
    }

    // Kasse
    var checkout = document.querySelector('[data-checkout]');
    if (checkout) {
      var cform = checkout.querySelector('[data-checkout-form]');
      var cEmpty = document.querySelector('[data-empty]');
      var done = document.querySelector('[data-done]');
      var mini = checkout.querySelector('[data-mini]');
      var ctotals = checkout.querySelector('[data-totals]');
      var summary = cform.querySelector('[data-summary]');
      var summaryList = cform.querySelector('[data-summary-list]');

      var method = function () { return cform.querySelector('input[name="levering"]:checked').value; };
      var miniInto = function (ul, lines) {
        ul.innerHTML = '';
        lines.forEach(function (l) {
          var v = variant(product(l.p), l.v);
          var li = el('li');
          var im = el('img'); im.src = imgFor(v, 400); im.alt = ''; im.width = 400; im.height = 500; im.loading = 'lazy';
          li.appendChild(im);
          li.appendChild(el('span', '', l.q + ' × ' + lineName(l)));
          li.appendChild(el('span', 'num', kr(v.price * l.q)));
          ul.appendChild(li);
        });
      };
      var draw = function () {
        var lines = load();
        cEmpty.hidden = lines.length > 0;
        checkout.hidden = lines.length === 0;
        if (!lines.length) return;
        miniInto(mini, lines);
        totalsInto(ctotals, lines, method());
        var free = subtotal(lines) >= DATA.shipping.freeOver;
        cform.querySelector('[data-ship-price="pakkeshop"]').textContent = free ? 'Gratis' : kr(DATA.shipping.pakkeshop);
        var pickup = method() === 'afhent';
        cform.querySelectorAll('[data-address]').forEach(function (d) { d.hidden = pickup; });
      };

      var rules = {
        email: function (v) { return !v ? 'Skriv din e-mail.' : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? '' : 'Skriv en gyldig e-mail, fx navn@mail.dk.'; },
        telefon: function (v) { return /^(\+45)?\d{8}$/.test(v.replace(/\s/g, '')) ? '' : 'Skriv et telefonnummer med 8 cifre.'; },
        navn: function (v) { return v.length < 2 ? 'Skriv dit fulde navn.' : ''; },
        adresse: function (v) { return method() === 'afhent' || v.length >= 3 ? '' : 'Skriv vej og husnummer.'; },
        postnr: function (v) { return method() === 'afhent' || /^\d{4}$/.test(v) ? '' : 'Skriv et postnummer med 4 cifre.'; },
        by: function (v) { return method() === 'afhent' || v.length >= 2 ? '' : 'Skriv by.'; }
      };
      var val = function (n) { return String(cform.elements[n].value || '').trim(); };
      var checkF = function (n) {
        var m = rules[n](val(n));
        cform.querySelector('[data-error-for="' + n + '"]').textContent = m;
        cform.elements[n].setAttribute('aria-invalid', m ? 'true' : 'false');
        return m;
      };
      cform.addEventListener('change', function (e) {
        if (e.target.name === 'levering') { ['adresse', 'postnr', 'by'].forEach(function (n) { if (cform.elements[n].getAttribute('aria-invalid') === 'true') checkF(n); }); draw(); }
      });
      cform.addEventListener('input', function (e) { if (rules[e.target.name] && e.target.getAttribute('aria-invalid') === 'true') checkF(e.target.name); });
      cform.addEventListener('submit', function (e) {
        e.preventDefault();
        var errs = Object.keys(rules).map(function (n) { return { n: n, m: checkF(n) }; }).filter(function (x) { return x.m; });
        if (errs.length) {
          summaryList.innerHTML = '';
          errs.forEach(function (x) {
            var li = el('li'); var a = el('a', '', x.m); a.href = '#' + x.n;
            a.addEventListener('click', function (ev) { ev.preventDefault(); cform.elements[x.n].focus(); });
            li.appendChild(a); summaryList.appendChild(li);
          });
          summary.hidden = false; summary.focus();
          return;
        }
        summary.hidden = true;
        var lines = load();
        done.querySelector('[data-done-name]').textContent = val('navn').split(' ')[0];
        miniInto(done.querySelector('[data-done-mini]'), lines);
        totalsInto(done.querySelector('[data-done-totals]'), lines, method());
        done.querySelector('[data-done-ship]').textContent = method() === 'afhent' ? 'Valgt levering: afhentning på værkstedet (eksempel).' : 'Valgt levering: pakkeshop til ' + val('adresse') + ', ' + val('postnr') + ' ' + val('by') + ' (eksempel).';
        save([]);
        checkout.hidden = true;
        document.querySelector('.crumbs').hidden = true;
        done.hidden = false;
        done.focus();
        window.scrollTo(0, 0);
      });
      draw();
    }
  });
})();
