// Holm Tømrer (fiktivt designkoncept). Menu, filter på projekter og en kontaktformular,
// der kun viser en demobekræftelse. Intet sendes eller gemmes.
(function () {
  'use strict';
  document.documentElement.classList.add('js');

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

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

    // Filter på projektsiden
    var filter = document.querySelector('[data-filter]');
    var gallery = document.querySelector('[data-gallery]');
    var status = document.querySelector('[data-filter-status]');
    if (filter && gallery) {
      filter.hidden = false;
      var buttons = filter.querySelectorAll('button');
      var items = gallery.querySelectorAll('li');
      var show = function (type) {
        var n = 0;
        items.forEach(function (li) {
          var hit = type === 'alle' || li.getAttribute('data-type') === type;
          li.hidden = !hit;
          if (hit) n++;
        });
        buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-type') === type)); });
        if (status) status.textContent = n === 1 ? 'Viser 1 opgave' : 'Viser ' + n + ' opgaver';
      };
      buttons.forEach(function (b) {
        b.addEventListener('click', function () { show(b.getAttribute('data-type')); });
      });
    }

    // Kontaktformular (demo)
    var form = document.querySelector('[data-demo-form]');
    if (!form) return;
    // Formularen vises kun med JavaScript, så den aldrig kan sendes som en almindelig formular
    form.hidden = false;
    var done = document.querySelector('[data-done]');
    var summary = form.querySelector('[data-summary]');
    var summaryList = form.querySelector('[data-summary-list]');

    // Forvalg fra ydelsessiden: kontakt?opgave=terrasse
    var pre = new URLSearchParams(location.search).get('opgave');
    if (pre) {
      var radio = form.querySelector('input[name="opgave"][data-key="' + pre.replace(/[^a-z]/g, '') + '"]');
      if (radio) radio.checked = true;
    }

    var rules = [
      { name: 'opgave', label: 'Hvad drejer det sig om', test: function () { return form.querySelector('input[name="opgave"]:checked') ? '' : 'Vælg, hvad opgaven drejer sig om.'; } },
      { name: 'beskrivelse', label: 'Beskrivelse', test: function (v) { return v.length < 10 ? 'Skriv mindst et par ord om opgaven.' : ''; } },
      { name: 'navn', label: 'Navn', test: function (v) { return v ? '' : 'Skriv dit navn.'; } },
      { name: 'telefon', label: 'Telefon', test: function (v) { return /^(\+45)?\d{8}$/.test(v.replace(/\s/g, '')) ? '' : 'Skriv et telefonnummer med 8 cifre.'; } },
      { name: 'email', label: 'E-mail', test: function (v) { return !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? '' : 'Skriv en gyldig e-mail, fx navn@mail.dk, eller lad feltet stå tomt.'; } },
      { name: 'postnr', label: 'Postnummer', test: function (v) { return /^\d{4}$/.test(v) ? '' : 'Skriv et postnummer med 4 cifre.'; } },
    ];

    var setError = function (name, msg) {
      var el = form.querySelector('[data-error-for="' + name + '"]');
      if (el) el.textContent = msg;
      var input = form.elements[name];
      if (input && input.setAttribute) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
      if (name === 'opgave') form.querySelectorAll('input[name="opgave"]').forEach(function (r) { r.setAttribute('aria-describedby', 'opgave-error'); });
    };

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var errors = [];
      rules.forEach(function (r) {
        var input = form.elements[r.name];
        var v = input && input.value !== undefined ? String(input.value).trim() : '';
        var msg = r.test(v);
        setError(r.name, msg);
        if (msg) errors.push({ name: r.name, msg: msg });
      });
      if (errors.length) {
        summaryList.innerHTML = '';
        errors.forEach(function (err) {
          var li = document.createElement('li');
          var a = document.createElement('a');
          var target = err.name === 'opgave' ? form.querySelector('input[name="opgave"]') : form.elements[err.name];
          a.href = '#' + (target && target.id ? target.id : '');
          a.textContent = err.msg;
          a.addEventListener('click', function (ev) { ev.preventDefault(); if (target) target.focus(); });
          li.appendChild(a);
          summaryList.appendChild(li);
        });
        summary.hidden = false;
        summary.focus();
        return;
      }
      summary.hidden = true;
      var data = new FormData(form);
      done.querySelector('[data-done-name]').textContent = String(data.get('navn')).split(' ')[0];
      var list = done.querySelector('[data-done-list]');
      list.innerHTML = '';
      [['Opgave', data.get('opgave')], ['Beskrivelse', data.get('beskrivelse')], ['Postnummer', data.get('postnr')], ['Hvornår', data.get('hvornaar')]].forEach(function (pair) {
        var dt = document.createElement('dt');
        dt.textContent = pair[0];
        var dd = document.createElement('dd');
        dd.textContent = String(pair[1] || '');
        list.appendChild(dt);
        list.appendChild(dd);
      });
      form.hidden = true;
      done.hidden = false;
      done.focus();
    });

    form.addEventListener('input', function (e) {
      var name = e.target.name;
      if (!name || e.target.getAttribute('aria-invalid') !== 'true') return;
      var rule = rules.filter(function (r) { return r.name === name; })[0];
      if (rule) setError(name, rule.test(String(e.target.value).trim()));
    });
    form.addEventListener('change', function (e) {
      if (e.target.name === 'opgave') setError('opgave', '');
    });

    done.querySelector('[data-reset]').addEventListener('click', function () {
      form.reset();
      rules.forEach(function (r) { setError(r.name, ''); });
      done.hidden = true;
      form.hidden = false;
      form.querySelector('input').focus();
    });
  });
})();
