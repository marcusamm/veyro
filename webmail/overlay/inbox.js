/* Veyro's mailbox layout. Message content and all mail operations stay with SOGo. */
(() => {
  'use strict';
  if (window.top !== window.self || document.querySelector('[data-vm-appbar]')) return;

  function element(tag, cls, text) {
    const node = document.createElement(tag);
    node.className = cls;
    if (text) node.textContent = text;
    return node;
  }
  function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }
  function button(cls, label, action) {
    const b = element('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', action);
    return b;
  }
  function compose(main) {
    const action = main.querySelector('.sg-block-print [ng-click="mailbox.newMessage($event)"]');
    if (action && !action.disabled) action.click();
  }
  function composeButton(main) {
    const b = button('vm-compose', 'Skriv mail', () => compose(main));
    const icon = element('span', 'vm-compose-icon', '＋');
    icon.setAttribute('aria-hidden', 'true');
    b.prepend(icon);
    return b;
  }

  function masthead(main, bar) {
    if (bar.hasAttribute('data-vm-appbar')) return;
    const group = bar.querySelector('.sg-toolbar-group-last');
    if (!group) return;
    const brand = element('div', 'vm-brand');
    const mark = element('img', 'vm-mark');
    mark.src = '/veyro-mail/mark.svg';
    mark.alt = '';
    const name = element('span', 'vm-brand-name', 'Veyro ');
    name.append(element('span','vm-brand-product','Mail'));
    brand.append(mark, name);
    const tools = element('div', 'vm-head-actions');
    const appMenu = button('vm-apps-trigger', 'Menu', () => toggle(appMenu.getAttribute('aria-expanded') !== 'true'));
    group.id = 'vm-account-actions';
    appMenu.setAttribute('aria-controls', group.id);
    appMenu.setAttribute('aria-label', 'Åbn programmer og kontohandlinger');
    appMenu.setAttribute('aria-expanded', 'false');
    const close = () => toggle(false);
    function toggle(open) {
      appMenu.setAttribute('aria-expanded', String(open));
      bar.classList.toggle('vm-open-menu', open);
      if (open) group.querySelector('a:not(.ng-hide):not([disabled]),button:not([disabled])')?.focus();
    }
    bar.addEventListener('keydown', e => {
      if (e.key === 'Escape' && bar.classList.contains('vm-open-menu')) { close(); appMenu.focus(); }
    });
    bar.addEventListener('focusout', e => { if (!bar.contains(e.relatedTarget)) close(); });
    const folderToggle = button('vm-mobile-folders', 'Mapper', () => {
      bar.querySelector('.sg-toolbar-group-1 .hide-gt-md[ng-click="toggleLeft()"]')?.click();
    });
    for (const action of group.querySelectorAll('a.md-button, button.md-button')) {
      let title = (action.getAttribute('aria-label') || action.querySelector('md-tooltip')?.textContent || action.title || '').trim();
      if (title === 'Afbryd' || /logout/i.test(action.getAttribute('onclick') || '')) {
        title = 'Log ud';
        action.setAttribute('aria-label',title);
      }
      if (title) action.append(element('span','vm-menu-label',title));
    }
    const accountTools = button('vm-account-trigger', 'Mappeindstillinger', () => {
      main.classList.toggle('vm-show-account-tools');
      close();
      if (folderToggle.getClientRects().length && main.querySelector(':scope > md-sidenav.md-closed')) folderToggle.click();
      else appMenu.focus();
    });
    group.append(accountTools);
    tools.append(folderToggle, composeButton(main), appMenu);
    bar.prepend(brand);
    bar.append(tools);
    bar.setAttribute('data-vm-appbar', '');
  }

  function folderRail(main, rail) {
    if (rail.querySelector('.vm-folder-head')) return;
    const head = element('div','vm-folder-head');
    head.append(element('h2','vm-rail-title','Postkasse'), composeButton(main));
    rail.prepend(head);
  }
  function folderHead(list) {
    let head = list.querySelector('.vm-list-head');
    if (!head) {
      head = element('header','vm-list-head');
      const title = element('h1','vm-folder-title');
      const count = element('span','vm-count');
      const opts = button('vm-options','···', () => {
        const open = list.classList.toggle('vm-options-open');
        opts.setAttribute('aria-expanded',String(open));
      });
      opts.setAttribute('aria-label','Vis eller skjul mappehandlinger');
      opts.setAttribute('aria-expanded','false');
      head.append(title,count,opts);
      list.prepend(head);
    }
    const label = list.querySelector('.sg-folder-name')?.textContent.trim();
    const counter = list.querySelector('#messagesList [ng-switch="mailbox.service.selectedFolder.getLength()"]');
    const number = counter?.querySelector('[ng-bind]')?.textContent.trim();
    const input = list.querySelector('[name="folderSearch"]');
    if (input && !input.hasAttribute('data-vm-search')) {
      input.setAttribute('data-vm-search','');
      input.setAttribute('placeholder', 'Søg i mappen');
      input.setAttribute('aria-label', 'Søg i mappen');
      const cancel = input.form?.querySelector('[ng-click="mailbox.cancelSearch()"]');
      if (cancel) {
        cancel.setAttribute('aria-label','Ryd søgning');
        input.addEventListener('input', () => { if (!input.value) cancel.click(); });
      }
    }
    setText(head.querySelector('h1'),label || 'Mail');
    setText(head.querySelector('.vm-count'),number ? number + (number === '1' ? ' mail' : ' mails') : counter?.textContent.trim() || '');
  }

  // The Material virtual scroller uses a fixed row height to position unloaded
  // messages. Change its measured size along with the rendered row, including
  // in long folders. If a future version lacks this API, keep its native height.
  function sizeRows(list) {
    const repeat = list.querySelector('#messagesList md-virtual-repeat-container');
    const ctl = repeat && window.angular?.element(repeat).controller('mdVirtualRepeatContainer');
    if (!ctl?.repeater || typeof ctl.setScrollSize !== 'function' || typeof ctl.updateSize !== 'function') return;
    const height = 88;
    if (ctl.repeater.itemSize === height) return;
    ctl.repeater.itemSize = height;
    repeat.style.setProperty('--vm-row-height',height + 'px');
    ctl.setScrollSize(ctl.repeater.getItemCount() * height);
    ctl.updateSize();
  }
  function rows(list) {
    for (const row of list.querySelectorAll('#messagesList .sg-message-list-item')) {
      const tile = row.querySelector('.sg-tile-content');
      if (!tile) continue;
      const ctrl = window.angular?.element(row).controller('sgMessageListItem');
      const msg = ctrl?.message;
      row.classList.toggle('vm-checked',!!msg?.selected);
      let line = tile.querySelector('.vm-row-note');
      if (!line) {
        line = element('div','vm-row-note');
        tile.append(line);
      }
      // The list endpoint returns headers. Use the actual correspondent address
      // instead of fetching and marking messages read just to build snippets.
      const outbound = msg?.$mailbox?.isSentFolder || msg?.$mailbox?.isDraftsFolder;
      const peer = (outbound ? msg?.to : msg?.from)?.[0];
      const address = typeof peer?.email === 'string' ? peer.email.trim() : '';
      const sender = tile.querySelector('.sg-md-subhead > :first-child')?.textContent.trim() || '';
      setText(line,msg && !msg.loading && !sender.toLowerCase().includes(address.toLowerCase()) ? address : '');
    }
  }

  function reader(detail) {
    const card = detail.querySelector('.sg-face > md-card');
    if (!card) {
      const panel = detail.querySelector(':scope > md-content');
      if (panel && !panel.querySelector('.vm-empty')) {
        const empty = element('div','vm-empty');
        const icon = element('span','vm-empty-icon','✉');
        icon.setAttribute('aria-hidden','true');
        empty.append(icon,element('h2','vm-empty-title','Vælg en mail'));
        panel.append(empty);
      }
      return;
    }
    const content = card.querySelector(':scope > md-card-content');
    if (!content) return;
    let head = content.querySelector(':scope > .vm-letter-head');
    if (!head) {
      const subject = content.querySelector(':scope > .sg-padded > .sg-md-headline');
      const envelope = content.querySelector(':scope > [layout-wrap]');
      if (!subject || !envelope) return;
      const date = subject.parentElement.querySelector('time.msg-date');
      head = element('header','vm-letter-head');
      content.prepend(head);
      head.append(subject,envelope);
      if (date) head.append(date);
      card.classList.add('vm-letter');
      const back = card.querySelector(':scope > md-card-actions [ng-click="viewer.close()"]');
      if (back) {
        back.setAttribute('aria-label','Tilbage til mappen');
        back.querySelector('md-icon').textContent = 'arrow_back';
        back.append(element('span','vm-back-label','Tilbage til mappen'));
      }
    }
    const sender = head.querySelector('[ng-bind*="from[0].email"]');
    const address = sender?.textContent.trim() || '';
    const name = sender?.previousElementSibling?.textContent.trim() || '';
    const fullName = name && !name.includes('@') ? name : address.split('@')[0];
    const initials = fullName.split(/[\s._-]+/).filter(Boolean).slice(0,2).map(part => Array.from(part)[0]).join('').toLocaleUpperCase();
    const nativeAvatar = head.querySelector('sg-avatar-image');
    if (nativeAvatar) {
      let avatar = head.querySelector('.vm-letter-avatar');
      if (!avatar) {
        avatar = element('span','vm-letter-avatar');
        avatar.setAttribute('aria-hidden','true');
        nativeAvatar.before(avatar);
      }
      setText(avatar,initials);
      avatar.hidden = !initials;
    }
  }

  let frame;
  function refresh() {
    frame = null;
    const main = document.querySelector('main[ui-view="mailboxes"]');
    if (!main) return;
    const bar = main.querySelector('section[ui-view="mailbox"] > .toolbar-main');
    const rail = main.querySelector(':scope > md-sidenav');
    if (!rail || !bar) return;
    main.classList.add('vm-workspace');
    masthead(main,bar);
    folderRail(main,rail);
    const list = main.querySelector('.view-list');
    if (list) { folderHead(list); sizeRows(list); rows(list); }
    const action = main.querySelector('.sg-block-print [ng-click="mailbox.newMessage($event)"]');
    main.querySelectorAll('.vm-compose').forEach(b => { b.disabled = !action || action.disabled; });
    const detail = main.querySelector('#detailView');
    if (detail) reader(detail);
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(refresh);
  }
  const observer = new MutationObserver(changes => {
    if (changes.some(({target}) => !(target.parentElement?.closest('.msg-body,#mailEditor,.vm-row-note,.vm-folder-title,.vm-count')))) schedule();
  });
  observer.observe(document.body,{subtree:true,childList:true,characterData:true});
  window.addEventListener('resize',schedule);
  refresh();
})();
