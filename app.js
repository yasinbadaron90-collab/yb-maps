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

  var gpsStatus = true; // initial "Waiting for GPS" message is a GPS message

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

  // ---------- Destination search + route ----------
  var NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  var OSRM = 'https://router.project-osrm.org/route/v1/driving/';
  var OFF_ROUTE_M = 50;
  var OFF_ROUTE_MS = 4000;
  var REROUTE_GAP_MS = 10000;

  var fromEl = document.getElementById('from');
  var toEl = document.getElementById('to');
  var goEl = document.getElementById('go');
  var resultsEl = document.getElementById('results');
  var tripEl = document.getElementById('trip');
  var tripTextEl = document.getElementById('trip-text');
  var clearEl = document.getElementById('clear');

  var lastLatLng = null;       // latest GPS fix
  var fromPt = null;           // null = use my GPS position
  var toPt = null;
  var routeLine = null, endMarker = null, startMarker = null;
  var routePts = null;         // [{lat, lon}]
  var routeFromGps = true;
  var offSince = 0, lastReroute = 0, routing = false;
  var pauseFollowUntil = 0;
  var resetZoom = false;

  var endIcon = L.divIcon({
    className: 'end-icon', html: '<div></div>', iconSize: [22, 22], iconAnchor: [11, 11]
  });

  function shortName(r) {
    var parts = String(r.display_name || '').split(',');
    return parts.slice(0, 2).join(',').trim();
  }

  function showResults(list, onPick) {
    resultsEl.innerHTML = '';
    if (!list.length) {
      var m = document.createElement('div');
      m.className = 'msg';
      m.textContent = 'No places found';
      resultsEl.appendChild(m);
      return;
    }
    list.forEach(function (r) {
      var d = document.createElement('div');
      d.textContent = r.display_name;
      d.addEventListener('click', function () {
        resultsEl.innerHTML = '';
        onPick(r);
      });
      resultsEl.appendChild(d);
    });
  }

  function search(text, onPick) {
    resultsEl.innerHTML = '<div class="msg">Searching…</div>';
    var url = NOMINATIM + '?format=jsonv2&limit=5&q=' + encodeURIComponent(text);
    if (lastLatLng) {
      // prefer places near me (soft bias, not a limit)
      var b = lastLatLng;
      url += '&viewbox=' + (b.lng - 0.7) + ',' + (b.lat + 0.7) + ',' + (b.lng + 0.7) + ',' + (b.lat - 0.7);
    }
    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (list) { showResults(list, onPick); })
      .catch(function () {
        resultsEl.innerHTML = '<div class="msg">Search failed. Try again.</div>';
      });
  }

  function pickTo(r) {
    toPt = L.latLng(parseFloat(r.lat), parseFloat(r.lon));
    toEl.value = shortName(r);
    go();
  }
  function pickFrom(r) {
    fromPt = L.latLng(parseFloat(r.lat), parseFloat(r.lon));
    fromEl.value = shortName(r);
    go();
  }

  function go() {
    var fromText = fromEl.value.trim();
    var toText = toEl.value.trim();
    if (fromText && !fromPt) return search(fromText, pickFrom);
    if (!toText) { toEl.focus(); return; }
    if (!toPt) return search(toText, pickTo);
    var start = fromPt || lastLatLng;
    if (!start) { setStatus('Waiting for GPS…'); return; }
    routeFromGps = !fromPt;
    drawRoute(start, toPt, false);
  }

  fromEl.addEventListener('input', function () { fromPt = null; });
  toEl.addEventListener('input', function () { toPt = null; });
  goEl.addEventListener('click', go);
  [fromEl, toEl].forEach(function (el) {
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { el.blur(); go(); } });
  });

  function fmtTrip(m, s) {
    var km = m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
    var min = Math.round(s / 60);
    var t = min >= 60 ? Math.floor(min / 60) + ' h ' + (min % 60) + ' min' : Math.max(1, min) + ' min';
    return km + ' · ' + t;
  }

  function clearRoute() {
    [routeLine, endMarker, startMarker].forEach(function (l) { if (l) map.removeLayer(l); });
    routeLine = endMarker = startMarker = null;
    routePts = null;
    offSince = 0;
    tripEl.classList.add('hidden');
    resultsEl.innerHTML = '';
  }

  function drawRoute(a, b, isReroute) {
    if (routing) return;
    routing = true;
    if (!isReroute) setStatus('Finding route…');
    var url = OSRM + a.lng + ',' + a.lat + ';' + b.lng + ',' + b.lat +
              '?overview=full&geometries=geojson';
    fetch(url)
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) {
        if (!data.routes || !data.routes.length) throw new Error('none');
        var rt = data.routes[0];
        var latlngs = rt.geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
        clearRoute();
        routePts = latlngs.map(function (p) { return { lat: p[0], lon: p[1] }; });
        routeLine = L.polyline(latlngs, { color: '#2563eb', weight: 7, opacity: 0.85 }).addTo(map);
        endMarker = L.marker(b, { icon: endIcon, interactive: false, keyboard: false }).addTo(map);
        if (!routeFromGps) {
          startMarker = L.circleMarker(a, { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(map);
        }
        tripTextEl.textContent = fmtTrip(rt.distance, rt.duration);
        tripEl.classList.remove('hidden');
        if (!isReroute) {
          map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
          pauseFollowUntil = Date.now() + 6000;
          resetZoom = true;
          setStatus('');
        } else {
          setStatus('Rerouted');
          setTimeout(function () { setStatus(''); }, 2000);
        }
      })
      .catch(function () {
        setStatus(isReroute ? 'Reroute failed' : 'No route found', true);
        setTimeout(function () { setStatus(''); }, 3000);
      })
      .then(function () { routing = false; });
  }

  clearEl.addEventListener('click', function () {
    clearRoute();
    toPt = null; toEl.value = '';
    fromPt = null; fromEl.value = '';
  });

  function checkRoute(lat, lon) {
    if (!routePts || !toPt) return;
    // arrived
    if (distM(lat, lon, toPt.lat, toPt.lng) < 30) {
      setStatus('You have arrived');
      setTimeout(function () { setStatus(''); }, 4000);
      clearRoute();
      return;
    }
    if (!routeFromGps) return; // custom start: no rerouting
    var p = { lat: lat, lon: lon }, min = Infinity;
    for (var i = 0; i < routePts.length - 1; i++) {
      var d = distToSegM(p, routePts[i], routePts[i + 1]);
      if (d < min) min = d;
      if (min < OFF_ROUTE_M) break;
    }
    var now = Date.now();
    if (min > OFF_ROUTE_M) {
      if (!offSince) offSince = now;
      else if (now - offSince > OFF_ROUTE_MS && now - lastReroute > REROUTE_GAP_MS && !routing) {
        lastReroute = now;
        setStatus('Rerouting…');
        drawRoute(L.latLng(lat, lon), toPt, true);
      }
    } else {
      offSince = 0;
    }
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

    lastLatLng = latlng;
    if (firstFix || Date.now() > pauseFollowUntil) {
      var z = (firstFix || resetZoom) ? 17 : map.getZoom();
      resetZoom = false;
      map.setView(latlng, z, { animate: !firstFix });
    }
    firstFix = false;

    if (gpsStatus) { gpsStatus = false; setStatus(''); }
    lookupLimit(c.latitude, c.longitude);
    checkRoute(c.latitude, c.longitude);
  }

  function onError(err) {
    var msg = err.code === 1 ? 'Location blocked. Allow location for this site.'
            : err.code === 2 ? 'No GPS signal'
            : 'GPS timeout, retrying…';
    gpsStatus = true;
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
