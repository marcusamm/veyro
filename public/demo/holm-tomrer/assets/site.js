// Holm Tømrer: original designkoncept. Alle formularhandlinger er lokale demoer.
(() => {
  "use strict";
  document.documentElement.classList.add("js");
  const ready = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn)
      : fn();
  ready(() => {
    const button = document.querySelector(".menu-btn"),
      nav = document.querySelector("#menu");
    const wide = matchMedia("(min-width: 900px)"),
      reduce = matchMedia("(prefers-reduced-motion: reduce)");
    function menu(open, focus = true) {
      button?.setAttribute("aria-expanded", String(open));
      nav?.classList.toggle("is-open", open);
      document.body.classList.toggle("menu-open", open);
      document.querySelectorAll("main,footer").forEach((el) => {
        el.inert = open;
      });
      if (button?.querySelector("[data-menu-label]"))
        button.querySelector("[data-menu-label]").textContent = open
          ? "Luk"
          : "Menu";
      if (open) nav?.querySelector("a")?.focus();
      else if (focus) button?.focus();
    }
    button?.addEventListener("click", () =>
      menu(button.getAttribute("aria-expanded") !== "true"),
    );
    nav?.addEventListener("click", (event) => {
      if (event.target.closest("a")) menu(false, false);
    });
    document.addEventListener("keydown", (event) => {
      if (button?.getAttribute("aria-expanded") !== "true") return;
      if (event.key === "Escape") menu(false);
      if (event.key === "Tab") {
        const links = [
            ...document.querySelector(".header").querySelectorAll("a,button"),
          ].filter((el) => el.getClientRects().length),
          first = links[0],
          last = links.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });
    wide.addEventListener("change", () => {
      if (wide.matches) menu(false, false);
    });
    if ("IntersectionObserver" in window && !reduce.matches) {
      const obs = new IntersectionObserver(
        (entries) =>
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-visible");
              obs.unobserve(entry.target);
            }
          }),
        { threshold: 0.05 },
      );
      document.querySelectorAll("[data-reveal]").forEach((el) => {
        if (el.getBoundingClientRect().top < innerHeight)
          el.classList.add("is-visible");
        else obs.observe(el);
      });
      document.documentElement.classList.add("motion");
      document.addEventListener("focusin", (event) =>
        event.target.closest("[data-reveal]")?.classList.add("is-visible"),
      );
      reduce.addEventListener("change", () => {
        if (reduce.matches) document.documentElement.classList.remove("motion");
      });
    }
    const filter = document.querySelector("[data-filter]"),
      gallery = document.querySelector("[data-gallery]"),
      status = document.querySelector("[data-filter-status]");
    if (filter && gallery) {
      filter.hidden = false;
      filter.querySelectorAll("button").forEach((button) =>
        button.addEventListener("click", () => {
          let count = 0;
          const type = button.dataset.type;
          gallery.querySelectorAll("li.project").forEach((item) => {
            item.hidden = type !== "alle" && item.dataset.type !== type;
            if (!item.hidden) count++;
          });
          filter
            .querySelectorAll("button")
            .forEach((b) =>
              b.setAttribute("aria-pressed", String(b === button)),
            );
          if (status)
            status.textContent =
              "Viser " + count + (count === 1 ? " opgave" : " opgaver");
        }),
      );
    }
    // Kontaktformular (demo)
    var form = document.querySelector("[data-demo-form]");
    if (!form) return;
    // Formularen vises kun med JavaScript, så den aldrig kan sendes som en almindelig formular

    var done = document.querySelector("[data-done]");
    var summary = form.querySelector("[data-summary]");
    var summaryList = form.querySelector("[data-summary-list]");

    // Forvalg fra ydelsessiden: kontakt?opgave=terrasse
    var pre = new URLSearchParams(location.search).get("opgave");
    if (pre) {
      var radio = form.querySelector(
        'input[name="opgave"][data-key="' + pre.replace(/[^a-z]/g, "") + '"]',
      );
      if (radio) radio.checked = true;
    }

    var rules = [
      {
        name: "opgave",
        label: "Hvad drejer det sig om",
        test: function () {
          return form.querySelector('input[name="opgave"]:checked')
            ? ""
            : "Vælg, hvad opgaven drejer sig om.";
        },
      },
      {
        name: "beskrivelse",
        label: "Beskrivelse",
        test: function (v) {
          return v.length < 10 ? "Skriv mindst et par ord om opgaven." : "";
        },
      },
      {
        name: "navn",
        label: "Navn",
        test: function (v) {
          return v ? "" : "Skriv dit navn.";
        },
      },
      {
        name: "telefon",
        label: "Telefon",
        test: function (v) {
          return /^(\+45)?\d{8}$/.test(v.replace(/\s/g, ""))
            ? ""
            : "Skriv et telefonnummer med 8 cifre.";
        },
      },
      {
        name: "email",
        label: "E-mail",
        test: function (v) {
          return !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
            ? ""
            : "Skriv en gyldig e-mail, fx navn@mail.dk, eller lad feltet stå tomt.";
        },
      },
      {
        name: "postnr",
        label: "Postnummer",
        test: function (v) {
          return /^\d{4}$/.test(v) ? "" : "Skriv et postnummer med 4 cifre.";
        },
      },
    ];

    var setError = function (name, msg) {
      var el = form.querySelector('[data-error-for="' + name + '"]');
      if (el) el.textContent = msg;
      var input = form.elements[name];
      if (input && input.setAttribute)
        input.setAttribute("aria-invalid", msg ? "true" : "false");
      if (name === "opgave")
        form.querySelectorAll('input[name="opgave"]').forEach(function (r) {
          r.setAttribute("aria-describedby", "opgave-error");
          r.setAttribute("aria-invalid", msg ? "true" : "false");
        });
    };

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var errors = [];
      rules.forEach(function (r) {
        var input = form.elements[r.name];
        var v =
          input && input.value !== undefined ? String(input.value).trim() : "";
        var msg = r.test(v);
        setError(r.name, msg);
        if (msg) errors.push({ name: r.name, msg: msg });
      });
      if (errors.length) {
        summaryList.innerHTML = "";
        errors.forEach(function (err) {
          var li = document.createElement("li");
          var a = document.createElement("a");
          var target =
            err.name === "opgave"
              ? form.querySelector('input[name="opgave"]')
              : form.elements[err.name];
          a.href = "#" + (target && target.id ? target.id : "");
          a.textContent = err.msg;
          a.addEventListener("click", function (ev) {
            ev.preventDefault();
            if (target) target.focus();
          });
          li.appendChild(a);
          summaryList.appendChild(li);
        });
        summary.hidden = false;
        summary.focus();
        return;
      }
      summary.hidden = true;
      var data = new FormData(form);
      done.querySelector("[data-done-name]").textContent = String(
        data.get("navn"),
      ).split(" ")[0];
      var list = done.querySelector("[data-done-list]");
      list.innerHTML = "";
      [
        ["Opgave", data.get("opgave")],
        ["Beskrivelse", data.get("beskrivelse")],
        ["Postnummer", data.get("postnr")],
        ["Hvornår", data.get("hvornaar")],
      ].forEach(function (pair) {
        var dt = document.createElement("dt");
        dt.textContent = pair[0];
        var dd = document.createElement("dd");
        dd.textContent = String(pair[1] || "");
        list.appendChild(dt);
        list.appendChild(dd);
      });
      form.hidden = true;
      done.hidden = false;
      done.focus();
    });

    form.addEventListener("input", function (e) {
      var name = e.target.name;
      if (!name || e.target.getAttribute("aria-invalid") !== "true") return;
      var rule = rules.filter(function (r) {
        return r.name === name;
      })[0];
      if (rule) setError(name, rule.test(String(e.target.value).trim()));
    });
    form.addEventListener("change", function (e) {
      if (e.target.name === "opgave") setError("opgave", "");
    });

    done.querySelector("[data-reset]").addEventListener("click", function () {
      form.reset();
      rules.forEach(function (r) {
        setError(r.name, "");
      });
      done.hidden = true;
      form.hidden = false;
      form.querySelector("input").focus();
    });

    form.querySelector('button[type="submit"]').disabled = false;
    form.hidden = false;
  });
})();
