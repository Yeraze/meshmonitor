/*
 * Viewport diagnostic overlay for issue #5310 — load any page with
 * `?vpdebug=1` to see it. Inert otherwise, and it is never bundled into the
 * app: index.html loads it only when the query string asks.
 *
 * What it answers: the bottom bar renders 62 CSS px above the screen edge in
 * an iOS 27 home-screen web app, and 62 is exactly that device's TOP
 * safe-area inset. Measurements from the reported screenshots put every
 * bottom-anchored element at y=894 while the window reports 956, so the page
 * is being laid out in a viewport shorter than the window and anchored at the
 * top. This prints the numbers that distinguish "the layout viewport is
 * short" from "the bar is positioned wrong", and pins a reference strip to
 * the true bottom edge so the shortfall is visible rather than inferred.
 *
 * Read the readout top to bottom: if `clientH` is less than `innerH` by the
 * top inset, and the bar's `rect.bottom` equals `clientH`, the element is
 * doing what it was told and the viewport is the problem.
 */
(function () {
  'use strict';
  /*
   * ON BY DEFAULT in this build, which exists only to diagnose #5310.
   *
   * It was gated on `?vpdebug=1`, which cannot work in the environment that
   * reproduces the bug: launching an iOS home-screen web app opens the
   * manifest's `start_url`, so the query string is dropped before this script
   * ever runs. The gate hid the overlay in precisely the one place it was
   * needed. `?vpdebug=0` still turns it off, and the preference sticks per
   * origin so the PWA remembers it across launches.
   */
  try {
    if (/[?&]vpdebug=0/.test(location.search)) localStorage.setItem('vpdebug', '0');
    else if (/[?&]vpdebug=1/.test(location.search)) localStorage.removeItem('vpdebug');
    if (localStorage.getItem('vpdebug') === '0') return;
  } catch (e) {
    // Private mode / blocked storage: fall through and show the overlay.
  }

  var BARS = [
    ['.sidebar', 'sidebar (fixed shell)'],
    ['[class*="mobileBottomBar"]', 'mobileBottomBar'],
    ['.save-bar', 'save-bar'],
    ['.app-main', 'app-main'],
  ];

  function px(n) {
    return n == null ? '—' : Math.round(n * 10) / 10;
  }

  /** The env() insets, read through a probe element since JS can't see them. */
  function insets() {
    var probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;' +
      'padding-top:env(safe-area-inset-top,0px);' +
      'padding-right:env(safe-area-inset-right,0px);' +
      'padding-bottom:env(safe-area-inset-bottom,0px);' +
      'padding-left:env(safe-area-inset-left,0px);';
    document.body.appendChild(probe);
    var cs = getComputedStyle(probe);
    var out = {
      top: parseFloat(cs.paddingTop) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
    };
    probe.remove();
    return out;
  }

  var panel = document.createElement('pre');
  panel.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:2147483647;margin:0;' +
    'padding:6px 8px;font:11px/1.35 ui-monospace,Menlo,monospace;' +
    'background:rgba(0,0,0,.82);color:#0f0;white-space:pre;pointer-events:none;' +
    'max-height:60vh;overflow:hidden;';

  /*
   * Two reference strips, both `position: fixed`, one anchored to each end.
   * The bottom strip is the whole point: if it sits above the screen edge, the
   * fixed containing block itself is short, and no amount of padding on the
   * bar will reach the edge.
   */
  function strip(edge, color) {
    var el = document.createElement('div');
    // Marked so the fixed-element scan below skips our own strips.
    el.dataset.vpdebug = '1';
    el.style.cssText =
      'position:fixed;left:0;right:0;' + edge + ':0;height:3px;' +
      'background:' + color + ';z-index:2147483646;pointer-events:none;';
    return el;
  }

  function report() {
    var de = document.documentElement;
    var vv = window.visualViewport;
    var ins = insets();
    var lines = [
      'vpdebug #5310  ' + new Date().toLocaleTimeString(),
      'orientation   ' + (window.innerWidth > window.innerHeight ? 'landscape' : 'portrait') +
        '  dpr ' + window.devicePixelRatio,
      'standalone    ' + (window.navigator.standalone === true ? 'yes (home-screen app)' : 'no'),
      'window.inner  ' + px(window.innerWidth) + ' x ' + px(window.innerHeight),
      'doc.clientH   ' + px(de.clientWidth) + ' x ' + px(de.clientHeight) +
        '   shortfall ' + px(window.innerHeight - de.clientHeight),
      'visualViewport' + (vv
        ? '  ' + px(vv.width) + ' x ' + px(vv.height) + '  offsetTop ' + px(vv.offsetTop) +
          '  scale ' + px(vv.scale)
        : '  (unsupported)'),
      'safe-area     top ' + px(ins.top) + '  bottom ' + px(ins.bottom) +
        '  left ' + px(ins.left) + '  right ' + px(ins.right),
      'dvh/svh/lvh   ' + px(unit('dvh')) + ' / ' + px(unit('svh')) + ' / ' + px(unit('lvh')),
      'scrollY       ' + px(window.scrollY) + '   body.scrollH ' + px(document.body.scrollHeight),
      '',
    ];

    BARS.forEach(function (pair) {
      var el = document.querySelector(pair[0]);
      if (!el) {
        lines.push(pair[1] + ': (absent)');
        return;
      }
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      lines.push(
        pair[1] + ': top ' + px(r.top) + ' bottom ' + px(r.bottom) + ' h ' + px(r.height) +
          '  gapToWindow ' + px(window.innerHeight - r.bottom) +
          '  gapToClientH ' + px(de.clientHeight - r.bottom),
      );
      lines.push(
        '   position ' + cs.position + '  bottom ' + cs.bottom +
          '  pad-bottom ' + cs.paddingBottom + '  transform ' + cs.transform,
      );
    });

    /*
     * The named selectors above miss whatever the current route actually
     * docks — a MeshCore page renders its nav inline, and `.sidebar` is absent
     * on several routes. Anything anchored near the bottom is a candidate for
     * the reported gap, so list what is really there rather than reporting
     * four "(absent)" lines and wasting the capture.
     */
    lines.push('');
    lines.push('root/body: ' + rectOf(document.getElementById('root')) + '  body ' + rectOf(document.body));
    var seen = 0;
    var all = document.body.getElementsByTagName('*');
    for (var i = 0; i < all.length && seen < 5; i++) {
      var el = all[i];
      if (el === panel || el.dataset.vpdebug) continue;
      var cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      var r = el.getBoundingClientRect();
      // Only things sitting in the bottom third, where the gap shows.
      if (r.height === 0 || r.bottom < window.innerHeight * 0.66) continue;
      seen++;
      lines.push(
        'fixed: ' + tag(el) + ' ' + rectOf(el) +
          '  gapToWindow ' + px(window.innerHeight - r.bottom) +
          '  ' + cs.position + ' bottom ' + cs.bottom,
      );
    }
    if (seen === 0) lines.push('fixed: (nothing anchored in the bottom third)');

    panel.textContent = lines.join('\n');
  }

  function tag(el) {
    var cls = (el.className && el.className.toString ? el.className.toString() : '').trim().split(/\s+/)[0] || '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
  }

  function rectOf(el) {
    if (!el) return '(absent)';
    var r = el.getBoundingClientRect();
    return 'top ' + px(r.top) + ' bottom ' + px(r.bottom) + ' h ' + px(r.height);
  }

  /** Resolve one viewport unit by measuring a probe sized to 100 of it. */
  function unit(name) {
    var probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:100' + name + ';visibility:hidden;';
    document.body.appendChild(probe);
    var h = probe.getBoundingClientRect().height;
    probe.remove();
    return h;
  }

  function start() {
    document.body.appendChild(panel);
    document.body.appendChild(strip('top', '#f0f'));
    document.body.appendChild(strip('bottom', '#f00'));
    report();
    // Re-read on everything that has been observed to change the answer: a
    // rotation is what makes the gap disappear in the real app.
    ['resize', 'orientationchange', 'scroll', 'pageshow'].forEach(function (ev) {
      window.addEventListener(ev, report, { passive: true });
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', report);
      window.visualViewport.addEventListener('scroll', report);
    }
    // The app mounts after this script runs, so the bars appear late.
    setTimeout(report, 500);
    setTimeout(report, 2000);
    setInterval(report, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
