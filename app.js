(function () {
  'use strict';

  var DEFAULT_CENTER = [-33.9249, 18.4241]; // Cape Town
  var OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
  var LIMIT_MIN_MOVE_M = 40;     // re-query after moving this far
  var LIMIT_MIN_INTERVAL_MS = 8000;
  var HEADING_MIN_SPEED = 1.5;   // m/s, below this GPS heading is unreliable
  var DRIVABLE = {
    motorway: 1, motorway_link: 1, trunk: 1, trunk_link: 1,
    primary: 1, primary_link: 1, secondary: 1, secondary_link: 1,
    tertiary: 1, tertiary_link: 1, unclassified: 1, residential: 1,
    living_street: 1, service: 1, road: 1
  };

  var map = L.map('map', { zoomControl: false, attributionControl: true })
    .setView(DEFAULT_CENTER, 17);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  var statusEl = document.getElementById('status');
  var speedEl = document.getElementById('speed');
  var limitEl = document.getElementById('limit');
  var limitValEl = document.getElementById('limit-val');

  function setStatus(text, isError) {
    if (!text) { statusEl.classList.add('hidden'); return; }
    statusEl.textContent = text;
    statusEl.classList.toggle('error', !!isError);
    statusEl.classList.remove('hidden');
  }

  // ---------- Arrow marker ----------
  var ARROW_SVG =
    '<svg viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="22" cy="22" r="20" fill="rgba(37,99,235,0.18)"/>' +
    '<path d="M22 4 L36 38 L22 30 L8 38 Z" fill="#2563eb" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>' +
    '</svg>';

  var arrowIcon = L.divIcon({
    className: 'arrow-icon',
    html: ARROW_SVG,
    iconSize: [44, 44],
    iconAnchor: [22, 22]
  });

  var marker = null;
  var heading = 0;       // degrees, 0 = north, clockwise
  var shownHeading = 0;  // unwrapped angle so rotation takes the short way

  function setHeading(deg) {
    // keep rotation continuous (avoid spinning 350 -> 10 the long way)
    var diff = ((deg - shownHeading) % 360 + 540) % 360 - 180;
    shownHeading += diff;
    heading = deg;
    if (marker) {
      var svg = marker.getElement() && marker.getElement().querySelector('svg');
      if (svg) svg.style.transform = 'rotate(' + shownHeading + 'deg)';
    }
  }

  function bearing(a, b) {
    var toRad = Math.PI / 180;
    var y = Math.sin((b.lng - a.lng) * toRad) * Math.cos(b.lat * toRad);
    var x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) -
            Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lng - a.lng) * toRad);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // ---------- Geometry helpers ----------
  function distM(lat1, lon1, lat2, lon2) {
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // distance in metres from point p to segment a-b (local flat projection)
  function distToSegM(p, a, b) {
    var kx = 111320 * Math.cos(p.lat * Math.PI / 180), ky = 110540;
    var ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky;
    var bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    var cx = ax + t * dx, cy = ay + t * dy;
    return Math.sqrt(cx * cx + cy * cy);
  }

  // ---------- Speed limit ----------
  function parseMaxspeed(raw) {
    if (!raw) return null;
    var s = String(raw).trim().toLowerCase();
    var m = s.match(/^(\d+)\s*(mph)?$/);
    if (!m) return null; // "none", "signals", "ZA:urban" etc -> unknown, never guess
    var n = parseInt(m[1], 10);
    if (m[2]) n = Math.round(n * 1.609344);
    return n;
  }

  var lastQuery = { lat: null, lon: null, time: 0 };
  var queryBusy = false;
  var currentLimit = null;

  function showLimit(val) {
    currentLimit = val;
    if (val == null) {
      limitValEl.textContent = '?';
      limitEl.classList.add('unknown');
    } else {
      limitValEl.textContent = val;
      limitEl.classList.remove('unknown');
    }
  }

  function lookupLimit(lat, lon) {
    var now = Date.now();
    if (queryBusy) return;
    if (lastQuery.lat !== null) {
      var moved = distM(lastQuery.lat, lastQuery.lon, lat, lon);
      if (moved < LIMIT_MIN_MOVE_M || now - lastQuery.time < LIMIT_MIN_INTERVAL_MS) return;
    }
    queryBusy = true;
    lastQuery = { lat: lat, lon: lon, time: now };

    var q = '[out:json][timeout:10];way(around:30,' + lat.toFixed(6) + ',' + lon.toFixed(6) +
            ')[highway];out tags geom;';
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 12000);

    fetch(OVERPASS_URL, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (r) {
        if (!r.ok) throw new Error('Overpass ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var p = { lat: lat, lon: lon };
        var best = null, bestD = Infinity;
        (data.elements || []).forEach(function (w) {
          if (!w.geometry || !w.tags || !DRIVABLE[w.tags.highway]) return;
          for (var i = 0; i < w.geometry.length - 1; i++) {
            var d = distToSegM(p, w.geometry[i], w.geometry[i + 1]);
            if (d < bestD) { bestD = d; best = w; }
          }
        });
        showLimit(best ? parseMaxspeed(best.tags.maxspeed) : null);
      })
      .catch(function () {
        // keep last value on network trouble; nothing to guess
        lastQuery.time = Date.now() - LIMIT_MIN_INTERVAL_MS + 3000; // retry soon
      })
      .then(function () {
        clearTimeout(timer);
        queryBusy = false;
      });
  }

  // ---------- GPS ----------
  var prevPos = null;
  var firstFix = true;

  function onPosition(pos) {
    var c = pos.coords;
    var latlng = L.latLng(c.latitude, c.longitude);

    // speed: m/s -> km/h
    var kmh = (c.speed != null && !isNaN(c.speed)) ? Math.round(c.speed * 3.6) : null;
    speedEl.textContent = kmh == null ? '--' : kmh;

    // heading: GPS heading when moving, else bearing from last position, else keep
    var moving = c.speed != null && c.speed >= HEADING_MIN_SPEED;
    if (moving && c.heading != null && !isNaN(c.heading)) {
      setHeading(c.heading);
    } else if (moving && prevPos && distM(prevPos.lat, prevPos.lng, latlng.lat, latlng.lng) > 3) {
      setHeading(bearing(prevPos, latlng));
    }
    if (moving || !prevPos) prevPos = latlng;

    if (!marker) {
      marker = L.marker(latlng, { icon: arrowIcon, keyboard: false, interactive: false, zIndexOffset: 1000 }).addTo(map);
      setHeading(heading);
    } else {
      marker.setLatLng(latlng);
    }

    map.setView(latlng, firstFix ? 17 : map.getZoom(), { animate: !firstFix });
    firstFix = false;

    setStatus('');
    lookupLimit(c.latitude, c.longitude);
  }

  function onError(err) {
    var msg = err.code === 1 ? 'Location blocked. Allow location for this site.'
            : err.code === 2 ? 'No GPS signal'
            : 'GPS timeout, retrying…';
    setStatus(msg, err.code === 1);
  }

  if (!('geolocation' in navigator)) {
    setStatus('This device has no GPS', true);
  } else {
    navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 15000
    });
  }

  // ---------- Keep screen awake ----------
  var wakeLock = null;
  function requestWake() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l;
      l.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }
  requestWake();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !wakeLock) requestWake();
  });
  // some browsers only allow wake lock after a user gesture
  document.addEventListener('click', function () { if (!wakeLock) requestWake(); });
  document.addEventListener('touchstart', function () { if (!wakeLock) requestWake(); }, { passive: true });

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  // exposed for tests
  window.__ybmaps = { onPosition: onPosition, showLimit: showLimit, map: map };
})();
