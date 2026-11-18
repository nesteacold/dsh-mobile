/* Progressive enhancement for the static landing page.
 * Classic script: no imports, no fetch, no network calls. Every interaction
 * degrades to readable static content when this file is absent. */
(function () {
  'use strict';

  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var $$ = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };
  var tr = function (key) {
    return window.DSH_I18N && window.DSH_I18N.get(window.DSH_I18N.current || 'vi', key);
  };
  var setText = function (el, value) {
    if (!el || value === undefined) return;
    el.innerHTML = value;
  };

  /* ---------- language toggle ---------- */
  var currentLang = 'vi';
  var toggle = $('#lang-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      currentLang = currentLang === 'vi' ? 'en' : 'vi';
      if (!window.DSH_I18N) return;
      window.DSH_I18N.current = currentLang;
      window.DSH_I18N.apply(currentLang);
      // Re-render dynamic simulated states in the newly selected language.
      updateDesktopState();
      updateWikiResult();
      updateSetupStep();
      if ($('#vscode-status').dataset.state) {
        setText($('#vscode-status'), tr('vscode.status.' + $('#vscode-status').dataset.state));
      }
    });
  }
  if (window.DSH_I18N) {
    window.DSH_I18N.current = currentLang;
    window.addEventListener('dsh:i18n', function (event) { currentLang = event.detail.lang; });
  }

  /* ---------- responsive menu ---------- */
  var menuToggle = $('#menu-toggle');
  var mobileNav = $('#mobile-nav');
  if (menuToggle && mobileNav) {
    menuToggle.addEventListener('click', function () {
      var open = menuToggle.getAttribute('aria-expanded') !== 'true';
      menuToggle.setAttribute('aria-expanded', String(open));
      mobileNav.hidden = !open;
      var label = open ? tr('menu.close') : tr('menu.open');
      if (label) menuToggle.setAttribute('aria-label', label);
    });
    $$('a', mobileNav).forEach(function (link) {
      link.addEventListener('click', function () {
        menuToggle.setAttribute('aria-expanded', 'false');
        mobileNav.hidden = true;
        var openLabel = tr('menu.open');
        if (openLabel) menuToggle.setAttribute('aria-label', openLabel);
      });
    });
  }

  /* ---------- generic tab wiring (experience tabs + setup steps) ---------- */
  function wireTabs(tabs, onSelect) {
    if (!tabs.length) return;
    var activate = function (tab, focus) {
      tabs.forEach(function (item) {
        var selected = item === tab;
        item.setAttribute('aria-selected', String(selected));
        item.tabIndex = selected ? 0 : -1;
        var panel = document.getElementById(item.getAttribute('aria-controls'));
        if (panel && panel.classList.contains('tabpanel')) panel.hidden = !selected;
      });
      if (focus) tab.focus();
      if (onSelect) onSelect(tab);
    };
    tabs.forEach(function (tab, index) {
      tab.addEventListener('click', function () { activate(tab, false); });
      tab.addEventListener('keydown', function (event) {
        var next = null;
        if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
        else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
        else if (event.key === 'Home') next = tabs[0];
        else if (event.key === 'End') next = tabs[tabs.length - 1];
        if (next) { event.preventDefault(); activate(next, true); }
      });
    });
  }

  /* ---------- experience tabs ---------- */
  wireTabs($$('#experience [role="tab"]'));

  /* ---------- mobile screenshot switcher + lightbox ---------- */
  var screenKeys = {
    '03-session-list': 'mobile.screen.alt.1',
    '04-session-detail': 'mobile.screen.alt.2',
    '05-approval-card': 'mobile.screen.alt.3',
    '02-pairing': 'mobile.screen.alt.4',
    '06-settings': 'mobile.screen.alt.5'
  };
  var mobileImg = $('#mobile-screen-img');
  $$('.screen-switcher .chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      $$('.screen-switcher .chip').forEach(function (item) {
        item.classList.toggle('is-active', item === chip);
        item.setAttribute('aria-pressed', String(item === chip));
      });
      if (mobileImg) {
        var file = chip.getAttribute('data-screen');
        mobileImg.src = 'assets/screens/' + file + '.png';
        var key = screenKeys[file];
        if (key) {
          mobileImg.setAttribute('data-i18n-alt', key);
          if (tr(key)) mobileImg.alt = tr(key);
        }
      }
    });
  });

  var dialog = $('#lightbox-dialog');
  var lightboxImg = $('#lightbox-img');
  var zoomButton = $('#screen-zoom');
  var lastFocus = null;
  if (zoomButton && dialog && typeof dialog.showModal === 'function') {
    zoomButton.addEventListener('click', function () {
      lastFocus = document.activeElement;
      if (lightboxImg && mobileImg) {
        lightboxImg.src = mobileImg.src;
        lightboxImg.alt = mobileImg.alt;
      }
      dialog.showModal();
    });
    $('#lightbox-close').addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', function () {
      if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    });
  } else if (zoomButton && mobileImg) {
    // file:// or an older browser without <dialog>: open the image in a new tab.
    zoomButton.addEventListener('click', function () { window.open(mobileImg.src, '_blank', 'noopener'); });
  }

  /* ---------- desktop host simulator ---------- */
  var desktopState = 'local';
  function updateDesktopState() {
    var remote = desktopState === 'remote';
    var suffix = remote ? 'remote' : 'local';
    $('#host-local-row').classList.toggle('is-current', !remote);
    $('#host-remote-row').classList.toggle('is-current', remote);
    setText($('#desktop-scope'), tr('desktop.scope.' + suffix));
    setText($('#desktop-route'), tr('desktop.route.' + suffix));
    setText($('#desktop-note'), tr('desktop.note.' + suffix));
  }
  $$('.sim-actions [data-host]').forEach(function (button) {
    button.addEventListener('click', function () {
      desktopState = button.getAttribute('data-host');
      $$('.sim-actions [data-host]').forEach(function (item) {
        item.classList.toggle('is-active', item === button);
        item.setAttribute('aria-pressed', String(item === button));
      });
      updateDesktopState();
    });
  });

  /* ---------- repo wiki search simulation ---------- */
  var wikiInput = $('#wiki-search');
  var wikiResult = $('#wiki-result');
  function updateWikiResult() {
    if (!wikiInput || !wikiResult) return;
    var query = wikiInput.value.trim().toLowerCase();
    if (!query) { setText(wikiResult, tr('wiki.result.idle')); return; }
    var key = null;
    if (query.indexOf('hash') >= 0) key = 'argsHash';
    else if (query.indexOf('pair') >= 0 || query.indexOf('qr') >= 0) key = 'pairing';
    else if (query.indexOf('gateway') >= 0 || query.indexOf('127') >= 0) key = 'gateway';
    setText(wikiResult, tr('wiki.result.' + (key || 'none')));
  }
  if (wikiInput) {
    wikiInput.addEventListener('input', updateWikiResult);
    updateWikiResult();
  }

  /* ---------- VS Code diff preview ---------- */
  var ideStatus = $('#vscode-status');
  if ($('#vscode-approve')) $('#vscode-approve').addEventListener('click', function () {
    if (!ideStatus) return;
    ideStatus.dataset.state = 'approved';
    setText(ideStatus, tr('vscode.status.approved'));
  });
  if ($('#vscode-revert')) $('#vscode-revert').addEventListener('click', function () {
    if (!ideStatus) return;
    ideStatus.dataset.state = 'reverted';
    setText(ideStatus, tr('vscode.status.reverted'));
  });

  /* ---------- setup carousel ---------- */
  var setupSteps = $$('.step-tab');
  var setupIndex = 0;
  var setupContent = [
    { label: 'setup.content.1.label', code: 'setup.content.1.code', hint: 'setup.content.1.hint' },
    { label: 'setup.content.2.label', code: 'setup.content.2.code', hint: 'setup.content.2.hint' },
    { label: 'setup.content.3.label', code: 'setup.content.3.code', hint: 'setup.content.3.hint' },
    { label: 'setup.content.4.label', code: 'setup.content.4.code', hint: 'setup.content.4.hint' },
    { label: 'setup.content.5.label', code: 'setup.content.5.code', hint: 'setup.content.5.hint' }
  ];

  function updateSetupStep() {
    var n = setupIndex + 1;
    setText($('#setup-kicker'), tr('setup.content.' + n + '.kicker'));
    setText($('#setup-heading'), tr('setup.content.' + n + '.title'));
    setText($('#setup-desc'), tr('setup.content.' + n + '.desc'));
    setText($('#setup-code-label'), tr(setupContent[setupIndex].label));
    var code = $('#setup-code');
    if (code) code.textContent = tr(setupContent[setupIndex].code) || '';
    setText($('#setup-hint'), tr(setupContent[setupIndex].hint));
    setText($('#setup-counter'), tr('setup.counter.' + n));
    var panel = $('#setup-panel');
    if (panel) panel.setAttribute('aria-labelledby', 'step-tab-' + n);
    if ($('#setup-prev')) $('#setup-prev').disabled = setupIndex === 0;
    if ($('#setup-next')) $('#setup-next').disabled = setupIndex === setupSteps.length - 1;
  }

  function goToSetup(index) {
    if (!setupSteps.length) return;
    setupIndex = Math.max(0, Math.min(setupSteps.length - 1, index));
    setupSteps.forEach(function (tab, i) {
      tab.setAttribute('aria-selected', String(i === setupIndex));
      tab.tabIndex = i === setupIndex ? 0 : -1;
    });
    updateSetupStep();
  }

  wireTabs(setupSteps, function (tab) {
    var index = setupSteps.indexOf(tab);
    if (index >= 0) goToSetup(index);
  });
  if ($('#setup-prev')) $('#setup-prev').addEventListener('click', function () { goToSetup(setupIndex - 1); });
  if ($('#setup-next')) $('#setup-next').addEventListener('click', function () { goToSetup(setupIndex + 1); });

  var copyButton = $('#copy-snippet');
  if (copyButton) {
    copyButton.addEventListener('click', function () {
      var text = $('#setup-code') ? $('#setup-code').textContent : '';
      var done = function () {
        var label = $('#copy-text');
        if (label) label.textContent = tr('setup.copied') || 'Copied';
        window.setTimeout(function () {
          if (label) label.textContent = tr('setup.copy') || 'Copy';
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {
          var label = $('#copy-text');
          if (label) label.textContent = tr('setup.copy-fallback') || 'Copy failed';
        });
      } else {
        // file:// has no secure clipboard context: select the snippet instead.
        var range = document.createRange();
        range.selectNodeContents($('#setup-code'));
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        done();
      }
    });
  }

  /* ---------- FAQ accordions ---------- */
  $$('.faq-q').forEach(function (button) {
    button.addEventListener('click', function () {
      var open = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!open));
      var panel = document.getElementById(button.getAttribute('aria-controls'));
      if (panel) panel.hidden = open;
    });
  });

  updateDesktopState();
  updateSetupStep();
})();
