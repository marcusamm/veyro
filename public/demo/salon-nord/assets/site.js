// Salon Nord (fiktivt designkoncept). Menu og et bookingforløb i fem trin, der kun kører i browseren.
// Ledige tider er beregnet ud fra datoen, så de ser ens ud hver gang. Intet bliver booket, gemt eller sendt.
(function () {
  'use strict';
  document.documentElement.classList.add('js');

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  var DAYS = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
  var MONTHS = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];
  var DOW = ['Ma', 'Ti', 'On', 'To', 'Fr', 'Lø', 'Sø'];
  // Åbningstider i minutter efter midnat. Søndag (0) og mandag (1) er lukket.
  var OPEN = { 2: [540, 1080], 3: [540, 1080], 4: [540, 1080], 5: [540, 1080], 6: [540, 840] };
  var STAFF = ['ida', 'sofie', 'jonas'];

  function kr(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' kr.'; }
  function hm(min) { var h = Math.floor(min / 60), m = min % 60; return (h < 10 ? '0' : '') + h + '.' + (m < 10 ? '0' : '') + m; }
  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function fromIso(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function longDate(d) { return DAYS[d.getDay()] + ' ' + d.getDate() + '. ' + MONTHS[d.getMonth()]; }
  // Lille, fast hash, så de optagne tider er de samme ved hver visning.
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function busy(day, staff, slot) { return hash(day + '|' + staff + '|' + slot) % 100 < 48; }

  ready(function () {
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

    var form = document.querySelector('[data-booking]');
    if (!form) return;

    var panels = form.querySelectorAll('[data-step]');
    var progress = form.querySelectorAll('[data-progress-item]');
    var cal = form.querySelector('[data-cal]');
    var calTitle = form.querySelector('[data-cal-title]');
    var slotsList = form.querySelector('[data-slots]');
    var slotsTitle = form.querySelector('[data-slots-title]');
    var slotsEmpty = form.querySelector('[data-slots-empty]');
    var current = 1;
    var confirmed = false;

    // Bookingperioden: de næste 14 dage fra i morgen.
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var first = new Date(today); first.setDate(first.getDate() + 1);
    var last = new Date(first); last.setDate(last.getDate() + 13);

    function treatment() {
      var r = form.querySelector('input[name="behandling"]:checked');
      return r ? { id: r.value, name: r.getAttribute('data-name'), min: +r.getAttribute('data-min'), price: +r.getAttribute('data-price'), from: r.getAttribute('data-from') === '1' } : null;
    }
    function staffChoice() {
      var r = form.querySelector('input[name="frisoer"]:checked');
      return r ? { id: r.value, name: r.getAttribute('data-name') } : null;
    }
    function dateChoice() { var r = form.querySelector('input[name="dato"]:checked'); return r ? r.value : null; }
    function timeChoice() { var r = form.querySelector('input[name="tid"]:checked'); return r ? { start: +r.value, staff: r.getAttribute('data-staff') } : null; }

    // Ledige starttider for en dag: hver halve time, så længe behandlingen kan nå at blive færdig.
    function slotsFor(day, min, staffId) {
      var d = fromIso(day), hours = OPEN[d.getDay()];
      if (!hours) return [];
      var blocks = Math.ceil(min / 30), out = [];
      for (var t = hours[0]; t + min <= hours[1]; t += 30) {
        var who = staffId === 'foerste' ? STAFF : [staffId];
        for (var i = 0; i < who.length; i++) {
          var free = true;
          for (var b = 0; b < blocks; b++) if (busy(day, who[i], (t - hours[0]) / 30 + b)) { free = false; break; }
          if (free) { out.push({ start: t, staff: who[i] }); break; }
        }
      }
      return out;
    }

    // Kalender
    function buildCalendar() {
      cal.innerHTML = '';
      DOW.forEach(function (d) { var el = document.createElement('span'); el.className = 'cal__dow'; el.setAttribute('aria-hidden', 'true'); el.textContent = d; cal.appendChild(el); });
      var start = new Date(first); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      var end = new Date(last); end.setDate(end.getDate() + (7 - ((end.getDay() + 6) % 7)) - 1);
      calTitle.textContent = first.getMonth() === last.getMonth() ? cap(MONTHS[first.getMonth()]) : cap(MONTHS[first.getMonth()]) + '–' + MONTHS[last.getMonth()];
      for (var d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        var label = document.createElement('label');
        label.className = 'day';
        var inRange = d >= first && d <= last;
        var closed = !OPEN[d.getDay()];
        var input = document.createElement('input');
        input.type = 'radio'; input.name = 'dato'; input.value = iso(d);
        var face = document.createElement('span');
        face.setAttribute('aria-hidden', 'true');
        face.textContent = d.getDate();
        var sr = document.createElement('span');
        sr.className = 'visually-hidden';
        sr.textContent = longDate(d) + (closed ? ', lukket' : '');
        if (!inRange) { label.classList.add('day--out'); input.disabled = true; sr.textContent = longDate(d) + ', kan ikke bookes'; }
        else if (closed) { label.classList.add('day--off'); input.disabled = true; }
        label.appendChild(input); label.appendChild(face); label.appendChild(sr);
        cal.appendChild(label);
      }
    }
    function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

    function renderSlots(keep) {
      var day = dateChoice(), t = treatment(), s = staffChoice();
      var prev = keep ? timeChoice() : null;
      slotsList.innerHTML = '';
      slotsEmpty.hidden = true;
      if (!day || !t || !s) { slotsTitle.textContent = 'Vælg først en dato'; return; }
      slotsTitle.textContent = 'Ledige tider ' + longDate(fromIso(day));
      var list = slotsFor(day, t.min, s.id);
      if (!list.length) { slotsEmpty.hidden = false; return; }
      list.forEach(function (slot) {
        var li = document.createElement('li');
        li.className = 'slot';
        var label = document.createElement('label');
        var input = document.createElement('input');
        input.type = 'radio'; input.name = 'tid'; input.value = slot.start; input.setAttribute('data-staff', slot.staff);
        if (prev && prev.start === slot.start) input.checked = true;
        var face = document.createElement('span');
        face.textContent = hm(slot.start);
        var sr = document.createElement('span');
        sr.className = 'visually-hidden';
        sr.textContent = ' til ' + hm(slot.start + t.min);
        face.appendChild(sr);
        label.appendChild(input); label.appendChild(face);
        li.appendChild(label);
        slotsList.appendChild(li);
      });
    }

    // Tjek om de valgte trin stadig hænger sammen
    function valid(step) {
      if (step === 1) return !!treatment();
      if (step === 2) return !!staffChoice();
      if (step === 3) return !!dateChoice() && !!timeChoice();
      if (step === 4) return fieldErrors().length === 0;
      return confirmed;
    }
    function reachable(step) { for (var i = 1; i < step; i++) if (!valid(i)) return false; return true; }

    function timeText() {
      var day = dateChoice(), tm = timeChoice(), t = treatment();
      if (!day || !tm || !t) return '';
      return cap(longDate(fromIso(day))) + ' kl. ' + hm(tm.start) + '–' + hm(tm.start + t.min);
    }
    function staffText() {
      var s = staffChoice(), tm = timeChoice();
      if (!s) return '';
      if (s.id === 'foerste' && tm) return cap(tm.staff) + ' (første ledige)';
      return s.name;
    }
    function priceText(t) { return (t.from ? 'fra ' : '') + kr(t.price); }

    function updateSummary() {
      var t = treatment();
      setSum('behandling', t ? t.name + ', ' + t.min + ' min.' : '');
      setSum('frisoer', staffText());
      setSum('tid', timeText());
      setSum('pris', t ? priceText(t) : '');
      var parts = [];
      if (t) parts.push(t.name + ' · ' + t.min + ' min. · ' + priceText(t));
      form.querySelectorAll('[data-chosen]').forEach(function (el) {
        var step = +el.closest('[data-step]').getAttribute('data-step');
        var bits = [];
        if (t) bits.push(t.name);
        if (step > 2 && staffChoice()) bits.push(staffText());
        if (step > 3 && timeText()) bits.push(timeText());
        el.textContent = bits.length ? 'Valgt: ' + bits.join(' · ') : '';
      });
    }
    function setSum(key, text) {
      var el = document.querySelector('[data-sum="' + key + '"]');
      if (!el) return;
      el.textContent = text || (key === 'pris' ? '–' : 'Ikke valgt');
      el.classList.toggle('is-empty', !text);
    }

    function renderProgress() {
      progress.forEach(function (li) {
        var n = +li.getAttribute('data-progress-item');
        var label = li.querySelector('.progress__label').textContent;
        li.innerHTML = '';
        var el;
        var canGo = !confirmed && n !== current && n < 5 && reachable(n) && (n < current || valid(n - 1));
        if (canGo) {
          el = document.createElement('button');
          el.type = 'button';
          el.addEventListener('click', function () { go(n, true); });
        } else {
          el = document.createElement('span');
          el.className = 'step';
        }
        if (n === current) el.setAttribute('aria-current', 'step');
        var num = document.createElement('span'); num.className = 'progress__n'; num.setAttribute('aria-hidden', 'true');
        var lab = document.createElement('span'); lab.className = 'progress__label'; lab.textContent = label;
        var sr = document.createElement('span'); sr.className = 'visually-hidden';
        sr.textContent = n < current || confirmed ? ', udfyldt' : (n === current ? ', nuværende trin' : '');
        el.appendChild(num); el.appendChild(lab); el.appendChild(sr);
        li.appendChild(el);
      });
    }

    function alertFor(step) { return form.querySelector('[data-step="' + step + '"] [data-alert]'); }
    function showAlert(step, html) {
      var a = alertFor(step);
      if (!a) return;
      if (!html) { a.hidden = true; a.innerHTML = ''; return; }
      a.innerHTML = html; a.hidden = false;
    }

    function go(n, push, quiet) {
      if (n > 1 && !reachable(n)) return;
      current = n;
      panels.forEach(function (p) { p.hidden = +p.getAttribute('data-step') !== n; });
      if (n === 3) {
        if (!dateChoice()) { var firstOpen = cal.querySelector('input:not(:disabled)'); if (firstOpen) firstOpen.checked = true; }
        renderSlots(true);
      }
      renderProgress();
      updateSummary();
      if (push && history.pushState) {
        entries = entries.slice(0, pos + 1).concat(n);
        pos = entries.length - 1;
        history.pushState({ step: n, i: pos }, '', '#trin-' + n);
      }
      if (quiet) return;
      var h = form.querySelector('[data-step="' + n + '"] h2');
      if (h) h.focus({ preventScroll: true });
      var top = form.getBoundingClientRect().top + window.scrollY - 16;
      if (window.scrollY > top) window.scrollTo(0, top);
    }

    // Browserens tilbageknap går et trin tilbage. entries spejler historikken siden siden blev åbnet.
    var entries = [1], pos = 0;
    window.addEventListener('popstate', function (e) {
      var n = e.state && e.state.step ? e.state.step : 1;
      pos = e.state && typeof e.state.i === 'number' ? e.state.i : 0;
      if (confirmed && n < 5) { restart(false); return; }
      go(reachable(n) ? n : 1, false);
    });

    var messages = {
      1: 'Vælg en behandling for at fortsætte.',
      2: 'Vælg en frisør eller „Første ledige“.',
      3: 'Vælg en dato og en ledig tid for at fortsætte.'
    };

    form.addEventListener('click', function (e) {
      var next = e.target.closest('[data-next]');
      var back = e.target.closest('[data-back]');
      if (next) {
        if (!valid(current)) {
          var msg = messages[current];
          if (current === 3 && dateChoice() && !slotsList.children.length) msg = 'Der er ingen ledige tider den valgte dag. Vælg en anden dato.';
          showAlert(current, msg);
          var a = alertFor(current); if (a) a.scrollIntoView({ block: 'nearest' });
          return;
        }
        showAlert(current, '');
        go(current + 1, true);
      }
      if (back) {
        if (pos > 0 && entries[pos - 1] === current - 1) history.back();
        else go(current - 1, true);
      }
      if (e.target.closest('[data-restart]')) restart(true);
    });

    form.addEventListener('change', function (e) {
      var name = e.target.name;
      if (name === 'behandling' || name === 'frisoer') {
        showAlert(current, '');
        // Skift i behandling eller frisør kan gøre den valgte tid ugyldig
        var before = timeChoice();
        renderSlots(true);
        if (before && !timeChoice()) showAlert(3, 'Den tid, du havde valgt, passer ikke længere med din behandling eller frisør. Vælg en ny tid.');
      }
      if (name === 'dato') { showAlert(3, ''); renderSlots(false); }
      if (name === 'tid') showAlert(3, '');
      if (e.target.getAttribute('aria-invalid') === 'true') checkField(name);
      renderProgress();
      updateSummary();
    });
    form.addEventListener('input', function (e) {
      if (e.target.getAttribute('aria-invalid') === 'true') checkField(e.target.name);
    });

    // Oplysninger
    var rules = {
      navn: function (v) { return v.length < 2 ? 'Skriv dit navn.' : ''; },
      telefon: function (v) { return /^(\+45)?\d{8}$/.test(v.replace(/\s/g, '')) ? '' : 'Skriv et telefonnummer med 8 cifre.'; },
      email: function (v) { return !v ? 'Skriv din e-mail, så du kan få bekræftelsen.' : (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? '' : 'Skriv en gyldig e-mail, fx navn@mail.dk.'); }
    };
    function value(name) { return String(form.elements[name].value || '').trim(); }
    function fieldErrors() {
      return Object.keys(rules).map(function (k) { return { name: k, msg: rules[k](value(k)) }; }).filter(function (x) { return x.msg; });
    }
    function checkField(name) {
      if (!rules[name]) return '';
      var msg = rules[name](value(name));
      form.querySelector('[data-error-for="' + name + '"]').textContent = msg;
      form.elements[name].setAttribute('aria-invalid', msg ? 'true' : 'false');
      return msg;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (current !== 4) return;
      var errs = [];
      Object.keys(rules).forEach(function (k) { var m = checkField(k); if (m) errs.push({ name: k, msg: m }); });
      if (errs.length) {
        showAlert(4, '<strong>Ret venligst følgende:</strong><ul>' + errs.map(function (x) { return '<li><a href="#' + x.name + '">' + x.msg + '</a></li>'; }).join('') + '</ul>');
        form.querySelectorAll('[data-step="4"] [data-alert] a').forEach(function (a) {
          a.addEventListener('click', function (ev) { ev.preventDefault(); form.elements[a.getAttribute('href').slice(1)].focus(); });
        });
        form.elements[errs[0].name].focus();
        return;
      }
      showAlert(4, '');
      confirmed = true;
      var t = treatment();
      form.querySelector('[data-confirm-name]').textContent = value('navn').split(' ')[0];
      var dl = form.querySelector('[data-confirm-list]');
      dl.innerHTML = '';
      [['Behandling', t.name + ', ' + t.min + ' min.'], ['Frisør', staffText()], ['Tid', timeText()], ['Pris', priceText(t) + ', betales i salonen'], ['Navn', value('navn')], ['Mail', value('email')]]
        .concat(value('besked') ? [['Besked', value('besked')]] : [])
        .forEach(function (row) {
          var div = document.createElement('div');
          var dt = document.createElement('dt'); dt.textContent = row[0];
          var dd = document.createElement('dd'); dd.textContent = row[1];
          div.appendChild(dt); div.appendChild(dd); dl.appendChild(div);
        });
      go(5, true);
    });

    function restart(push) {
      confirmed = false;
      form.reset();
      form.querySelectorAll('[data-error-for]').forEach(function (el) { el.textContent = ''; });
      form.querySelectorAll('[aria-invalid]').forEach(function (el) { el.setAttribute('aria-invalid', 'false'); });
      [1, 2, 3, 4].forEach(function (n) { showAlert(n, ''); });
      buildCalendar();
      renderSlots(false);
      go(1, push);
    }

    buildCalendar();
    // Forvalg fra behandlingssiden: book?behandling=dameklip
    var pre = new URLSearchParams(location.search).get('behandling');
    var preInput = pre && form.querySelector('input[name="behandling"][value="' + pre.replace(/[^a-z-]/g, '') + '"]');
    if (history.replaceState) history.replaceState({ step: 1, i: 0 }, '', location.pathname + location.search);
    if (preInput) { preInput.checked = true; go(2, true, true); }
    else go(1, false, true);
  });
})();
