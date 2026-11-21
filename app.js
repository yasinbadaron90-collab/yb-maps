(function () {
  'use strict';

  var DEFAULT_CENTER = [-33.9249, 18.4241]; // Cape Town
  var OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
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

  // Ask the OSM data servers in turn; the first good answer wins.
  function overpass(q, perServerMs) {
    function tryAt(i) {
      if (i >= OVERPASS_URLS.length) return Promise.reject(new Error('OSM data servers busy'));
      var ctrl = new AbortController();
      var t = setTimeout(function () { ctrl.abort(); }, perServerMs);
      return fetch(OVERPASS_URLS[i], {
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctrl.signal
      }).then(function (r) {
        clearTimeout(t);
        if (!r.ok) throw new Error('Overpass ' + r.status);
        return r.json();
      }).catch(function () { clearTimeout(t); return tryAt(i + 1); });
    }
    return tryAt(0);
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
    overpass(q, 8000)
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
        queryBusy = false;
      });
  }

  // ---------- Destination search + route ----------
  var NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  var OSRM_SERVERS = [
    'https://router.project-osrm.org/route/v1/driving/',
    'https://routing.openstreetmap.de/routed-car/route/v1/driving/'
  ];
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

  var MY_LOC = 'My location';
  var hereEl = document.getElementById('here');
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

  function fmtDist(m) {
    return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
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
      d.className = 'res';
      var left = document.createElement('span');
      left.className = 'res-name';
      var parts = String(r.display_name).split(',');
      var t = document.createElement('b');
      t.textContent = parts[0];
      var rest = document.createElement('small');
      rest.textContent = parts.slice(1, 4).join(',').trim();
      left.appendChild(t);
      left.appendChild(rest);
      d.appendChild(left);
      if (r._dist != null) {
        var dist = document.createElement('span');
        dist.className = 'res-dist';
        dist.textContent = fmtDist(r._dist);
        d.appendChild(dist);
      }
      d.addEventListener('click', function () {
        resultsEl.innerHTML = '';
        onPick(r);
      });
      resultsEl.appendChild(d);
    });
  }

  function nominatim(text, bounded) {
    var url = NOMINATIM + '?format=jsonv2&limit=10&q=' + encodeURIComponent(text);
    if (lastLatLng) {
      var b = lastLatLng, d = bounded ? 0.3 : 0.7; // ~30 km box, or soft bias
      url += '&viewbox=' + (b.lng - d) + ',' + (b.lat + d) + ',' + (b.lng + d) + ',' + (b.lat - d);
      if (bounded) url += '&bounded=1';
    }
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }

  // Nearest first. Looks within ~30 km of me, widens if nothing is found.
  function osmSearch(text, onPick, note) {
    resultsEl.innerHTML = '<div class="msg">Searching…</div>';
    if (note) {
      var nn = document.createElement('div');
      nn.className = 'msg';
      nn.textContent = note;
      resultsEl.insertBefore(nn, resultsEl.firstChild);
    }
    var first = lastLatLng ? nominatim(text, true) : nominatim(text, false);
    var widened = false;
    first
      .then(function (list) {
        if (list.length || !lastLatLng) return list;
        widened = true;
        return nominatim(text, false);
      })
      .then(function (list) {
        if (lastLatLng) {
          list.forEach(function (r) {
            r._dist = distM(lastLatLng.lat, lastLatLng.lng, parseFloat(r.lat), parseFloat(r.lon));
          });
          list.sort(function (x, y) { return x._dist - y._dist; });
        }
        showResults(list.slice(0, 8), onPick);
        if (widened && list.length) {
          var n = document.createElement('div');
          n.className = 'msg';
          n.textContent = 'None within 30 km. Showing the nearest found. Tip: press and hold the map to drop a pin.';
          resultsEl.insertBefore(n, resultsEl.firstChild);
        }
      })
      .catch(function () {
        resultsEl.innerHTML = '<div class="msg">Search failed. Try again.</div>';
      });
  }

  // ---------- Business search key (TomTom), stored on this phone only ----------
  var KEY_NAME = 'yb-maps-tomtom-key';
  function getKey() { try { return localStorage.getItem(KEY_NAME) || ''; } catch (e) { return ''; } }
  function setKey(v) { try { if (v) localStorage.setItem(KEY_NAME, v); else localStorage.removeItem(KEY_NAME); } catch (e) {} }

  function tomtom(text, onPick, key, idx) {
    resultsEl.innerHTML = '<div class="msg">Searching…</div>';
    function call(withRadius) {
      var url = 'https://api.tomtom.com/search/2/search/' + encodeURIComponent(text) +
                '.json?key=' + encodeURIComponent(key) + '&limit=10&language=en-GB';
      if (idx) url += '&idxSet=' + idx;
      if (lastLatLng) {
        url += '&lat=' + lastLatLng.lat + '&lon=' + lastLatLng.lng;
        if (withRadius) url += '&radius=60000';
      }
      return fetch(url).then(function (r) {
        if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
        return r.json();
      }).then(function (d) { return d.results || []; });
    }
    // TomTom misses some places OSM has (and the other way round), so ask both and merge.
    var osmList = nominatim(text, !!lastLatLng)
      .then(function (l) { return l.length || !lastLatLng ? l : nominatim(text, false); })
      .catch(function () { return []; });
    call(true)
      .then(function (list) { return list.length || !lastLatLng ? list : call(false); })
      .then(function (list) { return osmList.then(function (o) { return { tt: list, osm: o }; }); })
      .then(function (both) {
        var list = both.tt;
        var out = list.map(function (r) {
          var addr = (r.address && r.address.freeformAddress) || '';
          var name = r.poi && r.poi.name;
          return {
            display_name: name ? name + ', ' + addr : addr,
            lat: r.position.lat, lon: r.position.lon,
            _dist: lastLatLng ? distM(lastLatLng.lat, lastLatLng.lng, r.position.lat, r.position.lon) : null
          };
        });
        both.osm.forEach(function (r) {
          var la = parseFloat(r.lat), lo = parseFloat(r.lon);
          var dup = out.some(function (o) { return distM(o.lat, o.lon, la, lo) < 80; });
          if (dup) return;
          out.push({
            display_name: r.display_name, lat: la, lon: lo,
            _dist: lastLatLng ? distM(lastLatLng.lat, lastLatLng.lng, la, lo) : null
          });
        });
        if (lastLatLng) out.sort(function (x, y) { return x._dist - y._dist; });
        showResults(out.slice(0, 8), onPick);
      })
      .catch(function (err) {
        var why = err && err.status === 403 || err && err.status === 401 ? 'key not accepted'
                : err && err.status === 429 ? 'daily limit reached' : 'no connection';
        osmSearch(text, onPick, 'Business search failed (' + why + '). Using free map data.');
      });
  }

  function search(text, onPick, idx) {
    var key = getKey();
    if (key) return tomtom(text, onPick, key, idx);
    osmSearch(text, onPick);
  }

  function showSettings() {
    // tap the cog again to hide the panel
    if (resultsEl.querySelector('.settings')) { resultsEl.innerHTML = ''; return; }
    resultsEl.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'settings';
    var has = !!getKey();
    box.innerHTML =
      '<p class="state">Business search: ' + (has ? 'ON' : 'OFF') + '</p>' +
      '<p>Finds shops and businesses like Google Maps. Get a free key at developer.tomtom.com, then paste it here. It stays on this phone.</p>' +
      '<div class="srow"><input id="keyin" type="password" placeholder="Paste key" autocomplete="off">' +
      '<button id="keysave" type="button">Save</button></div>' +
      (has ? '<div class="srow" style="margin-top:8px"><button id="keyoff" type="button" class="btn2">Turn off and remove key</button></div>' : '') +
      '<div class="srow" style="margin-top:8px"><button id="refresh" type="button" class="btn2">🔄 Refresh app (get latest version)</button></div>' +
      '<p class="state" style="margin-top:8px;font-size:13px;font-weight:400">App version 15</p>';
    resultsEl.appendChild(box);
    document.getElementById('keysave').addEventListener('click', function () {
      var v = document.getElementById('keyin').value.trim();
      if (!v) return;
      setKey(v);
      resultsEl.innerHTML = '<div class="msg">Saved. Business search is on.</div>';
      setTimeout(function () { if (!resultsEl.querySelector('.settings')) resultsEl.innerHTML = ''; }, 2500);
    });
    document.getElementById('refresh').addEventListener('click', function () {
      this.textContent = 'Refreshing…';
      var done = function () { location.reload(); };
      var clear = function () {
        if (!window.caches) return Promise.resolve();
        return caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); });
      };
      var unreg = (navigator.serviceWorker && navigator.serviceWorker.getRegistrations)
        ? navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); })
        : Promise.resolve();
      unreg.then(clear).then(done, done);
    });
    var off = document.getElementById('keyoff');
    if (off) off.addEventListener('click', function () {
      setKey('');
      resultsEl.innerHTML = '<div class="msg">Removed. Using free map data.</div>';
      setTimeout(function () { if (!resultsEl.querySelector('.settings')) resultsEl.innerHTML = ''; }, 2500);
    });
  }
  document.getElementById('cog').addEventListener('click', showSettings);

  // Press and hold the map to drop a destination pin
  map.on('contextmenu', function (e) {
    toPt = e.latlng;
    toEl.value = 'Dropped pin';
    resultsEl.innerHTML = '';
    go();
  });

  // Quick "near me" buttons
  var NEARBY = [
    ['⛽ Fuel', 'petrol station'], ['🛒 Shops', 'supermarket'], ['🍔 Food', 'restaurant'],
    ['🏧 ATM', 'atm'], ['🏥 Hospital', 'hospital'], ['🅿️ Parking', 'parking']
  ];
  // ---------- Saved places (Home, Work, favourites) — stored on this phone ----------
  var PLACES_KEY = 'yb-maps-places';
  function getPlaces() {
    try { var l = JSON.parse(localStorage.getItem(PLACES_KEY) || '[]'); return Array.isArray(l) ? l : []; }
    catch (e) { return []; }
  }
  function setPlaces(l) { try { localStorage.setItem(PLACES_KEY, JSON.stringify(l)); } catch (e) {} }
  function savePlace(name, lat, lon) {
    var l = getPlaces().filter(function (p) { return p.name.toLowerCase() !== name.toLowerCase(); });
    l.push({ name: name, lat: lat, lon: lon });
    setPlaces(l);
  }
  function placeSaved(name) {
    resultsEl.innerHTML = '<div class="msg">Saved “' + name.replace(/</g, '&lt;') + '”. Tap “Where to?” to use it.</div>';
    setTimeout(function () { if (resultsEl.querySelector('.msg') && !resultsEl.querySelector('.res')) resultsEl.innerHTML = ''; }, 3000);
  }

  // Ask what to call a place, then save it
  function showNamePicker(lat, lon, hint) {
    resultsEl.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'namer';
    box.innerHTML =
      '<p class="state">Save this place as:</p>' +
      '<div class="chips" style="border:0;padding:0 0 8px"></div>' +
      '<div class="srow"><input id="pname" type="text" placeholder="Name, e.g. Home" autocomplete="off">' +
      '<button id="psave" type="button">Save</button></div>';
    resultsEl.appendChild(box);
    var input = document.getElementById('pname');
    if (hint) input.value = hint;
    var chips = box.querySelector('.chips');
    ['Home', 'Work'].forEach(function (n) {
      var c = document.createElement('button');
      c.type = 'button'; c.className = 'chip'; c.textContent = n;
      c.addEventListener('click', function () { input.value = n; });
      chips.appendChild(c);
    });
    document.getElementById('psave').addEventListener('click', function () {
      var name = input.value.trim();
      if (!name) { input.focus(); return; }
      savePlace(name, lat, lon);
      placeSaved(name);
    });
  }

  document.getElementById('save-place').addEventListener('click', function () {
    if (!toPt) return;
    showNamePicker(toPt.lat, toPt.lng, '');
  });

  function showNearbyChips() {
    if (toEl.value.trim() || routePts) return;
    resultsEl.innerHTML = '';

    var places = getPlaces();
    places.forEach(function (p, i) {
      var d = document.createElement('div');
      d.className = 'res';
      var left = document.createElement('span');
      left.className = 'res-name';
      var t = document.createElement('b');
      t.textContent = '⭐ ' + p.name;
      left.appendChild(t);
      d.appendChild(left);
      var right = document.createElement('span');
      right.className = 'res-right';
      if (lastLatLng) {
        var dist = document.createElement('span');
        dist.className = 'res-dist';
        dist.textContent = fmtDist(distM(lastLatLng.lat, lastLatLng.lng, p.lat, p.lon));
        right.appendChild(dist);
      }
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'saved-del';
      del.setAttribute('aria-label', 'Remove ' + p.name);
      del.textContent = '✕';
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!confirm('Remove “' + p.name + '”?')) return;
        var l = getPlaces(); l.splice(i, 1); setPlaces(l);
        showNearbyChips();
      });
      right.appendChild(del);
      d.appendChild(right);
      d.addEventListener('click', function () {
        toPt = L.latLng(p.lat, p.lon);
        toEl.value = p.name;
        go();
      });
      resultsEl.appendChild(d);
    });

    var wrap = document.createElement('div');
    wrap.className = 'chips';
    NEARBY.forEach(function (n) {
      var c = document.createElement('button');
      c.type = 'button';
      c.className = 'chip';
      c.textContent = n[0];
      c.addEventListener('click', function () {
        toEl.value = n[1];
        toPt = null;
        search(n[1], pickTo, 'POI');
      });
      wrap.appendChild(c);
    });
    var here = document.createElement('button');
    here.type = 'button';
    here.className = 'chip';
    here.textContent = '⭐ Save where I am';
    here.addEventListener('click', function () {
      if (!lastLatLng) { flash('Waiting for GPS…', false, 3000); return; }
      showNamePicker(lastLatLng.lat, lastLatLng.lng, '');
    });
    wrap.appendChild(here);
    resultsEl.appendChild(wrap);
    if (!places.length) {
      var hint = document.createElement('div');
      hint.className = 'msg';
      hint.textContent = 'No saved places yet. Pick a destination, then tap ⭐ to save it as Home, Work, etc.';
      resultsEl.appendChild(hint);
    }
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
    unlockSpeech();
    var fromText = fromEl.value.trim();
    var toText = toEl.value.trim();
    if (fromText && fromText !== MY_LOC && !fromPt) return search(fromText, pickFrom);
    if (!toText) { toEl.focus(); return; }
    if (!toPt) return search(toText, pickTo);
    var start = fromPt || lastLatLng;
    if (!start) { setStatus('Waiting for GPS…'); return; }
    routeFromGps = !fromPt;
    drawRoute(start, toPt, false);
  }

  function useMyLocation() {
    fromPt = null;
    fromEl.value = MY_LOC;
    resultsEl.innerHTML = '';
    if (toPt) go();
  }
  hereEl.addEventListener('click', useMyLocation);
  fromEl.addEventListener('focus', function () { if (fromEl.value === MY_LOC) fromEl.select(); });
  fromEl.addEventListener('input', function () { fromPt = null; });
  toEl.addEventListener('focus', showNearbyChips);
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


  // ---------- Turn-by-turn ----------
  var navEl = document.getElementById('nav');
  var navIconEl = document.getElementById('nav-icon');
  var navDistEl = document.getElementById('nav-dist');
  var navTextEl = document.getElementById('nav-text');
  var muteEl = document.getElementById('mute');
  var MUTE_KEY = 'yb-maps-muted';
  var muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) {}
  muteEl.textContent = muted ? '🔇' : '🔊';
  var steps = null;     // [{type, modifier, name, lat, lon}] ; steps[0] = depart
  var stepIdx = 1;
  var said = {};        // which announcements were already spoken for stepIdx

  function speak(text) {
    if (muted || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-ZA';
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }
  function unlockSpeech() {   // phones only allow speech after a tap
    if (!('speechSynthesis' in window)) return;
    try { var u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u); } catch (e) {}
  }
  muteEl.addEventListener('click', function () {
    muted = !muted;
    muteEl.textContent = muted ? '🔇' : '🔊';
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) {}
    if (muted) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    else { unlockSpeech(); speak('Voice on'); }
  });

  function turnWord(mod) {
    switch (mod) {
      case 'left': return 'left';
      case 'right': return 'right';
      case 'slight left': return 'slightly left';
      case 'slight right': return 'slightly right';
      case 'sharp left': return 'sharp left';
      case 'sharp right': return 'sharp right';
      case 'uturn': return 'around';
      default: return '';
    }
  }
  function turnIcon(st) {
    if (st.type === 'arrive') return '⚑';
    if (st.type === 'roundabout' || st.type === 'rotary' || st.type === 'roundabout turn') return '⟳';
    switch (st.modifier) {
      case 'left': return '←';
      case 'right': return '→';
      case 'slight left': return '↖';
      case 'slight right': return '↗';
      case 'sharp left': return '↰';
      case 'sharp right': return '↱';
      case 'uturn': return '↩';
      default: return '↑';
    }
  }
  // "turn left onto Main Road"
  function stepPhrase(st) {
    var onto = st.name ? ' onto ' + st.name : '';
    var w = turnWord(st.modifier);
    if (st.type === 'arrive') return 'You have arrived';
    if (st.type === 'roundabout' || st.type === 'rotary') {
      return 'Take the ' + (st.exit ? ordinal(st.exit) + ' exit' : 'exit') + ' at the roundabout' + onto;
    }
    if (st.type === 'fork') return 'Keep ' + (w || 'straight') + (st.name ? ' onto ' + st.name : '');
    if (st.modifier === 'uturn') return 'Make a U-turn';
    if (st.type === 'continue' || st.type === 'new name' || !w || st.modifier === 'straight') {
      return 'Continue straight' + onto;
    }
    return 'Turn ' + w + onto;
  }
  function ordinal(n) {
    return ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'][n] || (n + 'th');
  }
  function fmtDist(m) {
    if (m >= 1000) return (m / 1000).toFixed(1) + ' km';
    return (Math.round(m / 10) * 10) + ' m';
  }
  function spokenDist(m) {
    return m >= 1000 ? (m / 1000).toFixed(1) + ' kilometres' : (Math.round(m / 10) * 10) + ' metres';
  }

  function navStart(rt) {
    steps = null;
    if (!routeFromGps || !rt.legs) { navEl.classList.add('hidden'); return; }
    var list = [];
    rt.legs.forEach(function (leg) {
      (leg.steps || []).forEach(function (s) {
        if (!s.maneuver || !s.maneuver.location) return;
        list.push({
          type: s.maneuver.type,
          modifier: s.maneuver.modifier,
          exit: s.maneuver.exit,
          name: s.name || '',
          lat: s.maneuver.location[1],
          lon: s.maneuver.location[0]
        });
      });
    });
    if (list.length < 2) { navEl.classList.add('hidden'); return; }
    steps = list;
    stepIdx = 1;
    said = {};
    navEl.classList.remove('hidden');
    navRender(null);
    if (lastLatLng) navUpdate(lastLatLng.lat, lastLatLng.lng);
  }
  function navReset() {
    steps = null;
    navEl.classList.add('hidden');
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }
  function navRender(d) {
    var st = steps[stepIdx];
    navIconEl.textContent = turnIcon(st);
    navDistEl.textContent = d == null ? '' : (st.type === 'arrive' ? fmtDist(d) : fmtDist(d));
    navTextEl.textContent = stepPhrase(st);
  }
  function navUpdate(lat, lon) {
    if (!steps || stepIdx >= steps.length) return;
    var st = steps[stepIdx];
    var d = distM(lat, lon, st.lat, st.lon);
    var isLast = st.type === 'arrive';
    // reached this manoeuvre: move on
    if (d < 25 && !isLast) {
      stepIdx++;
      said = {};
      st = steps[stepIdx];
      d = distM(lat, lon, st.lat, st.lon);
      isLast = st.type === 'arrive';
    }
    navRender(d);
    if (isLast) {
      if (d < 120 && !said.far) { said.far = true; speak('Your destination is ahead'); }
      return;
    }
    var phrase = stepPhrase(st);
    if (d < 100 && !said.near) {
      said.near = said.far = true;
      speak(phrase + ' now');
    } else if (d < 350 && d >= 100 && !said.far) {
      said.far = true;
      speak('In ' + spokenDist(d) + ', ' + phrase.charAt(0).toLowerCase() + phrase.slice(1));
    }
  }

  function clearRoute() {
    [routeLine, endMarker, startMarker].forEach(function (l) { if (l) map.removeLayer(l); });
    routeLine = endMarker = startMarker = null;
    routePts = null;
    offSince = 0;
    navReset();
    tripEl.classList.add('hidden');
    resultsEl.innerHTML = '';
  }

  var routeCtl = null;

  // Ask the route servers in turn (each gets 10 s). Returns the first good route.
  function fetchRoute(a, b, signal) {
    var tail = a.lng + ',' + a.lat + ';' + b.lng + ',' + b.lat + '?overview=full&geometries=geojson&steps=true';
    var lastErr = 'no answer';
    function tryServer(i) {
      if (i >= OSRM_SERVERS.length) return Promise.reject(new Error(lastErr));
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, 10000);
      signal.addEventListener('abort', function () { ctl.abort(); });
      return fetch(OSRM_SERVERS[i] + tail, { signal: ctl.signal })
        .then(function (r) {
          clearTimeout(timer);
          if (!r.ok) throw new Error('server ' + r.status);
          return r.json();
        })
        .then(function (data) {
          if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
            throw new Error(data.code || 'no route');
          }
          return data.routes[0];
        })
        .catch(function (err) {
          clearTimeout(timer);
          if (signal.aborted) throw err;
          lastErr = (err && err.name === 'AbortError') ? 'timed out' : (err && err.message) || 'failed';
          return tryServer(i + 1);
        });
    }
    return tryServer(0);
  }

  function flash(text, isError, ms) {
    setStatus(text, isError);
    setTimeout(function () { if (statusEl.textContent === text) setStatus(''); }, ms || 6000);
  }

  function drawRoute(a, b, isReroute) {
    if (routing) {
      if (isReroute) return;          // let the running request finish
      if (routeCtl) routeCtl.abort(); // a new destination replaces a stuck one
    }
    if (!isReroute && distM(a.lat, a.lng, b.lat, b.lng) < 40) {
      flash('You are already here');
      return;
    }
    routing = true;
    var ctl = new AbortController();
    routeCtl = ctl;
    if (!isReroute) setStatus('Finding route…');
    fetchRoute(a, b, ctl.signal)
      .then(function (rt) {
        if (ctl.signal.aborted) return;
        var latlngs = rt.geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
        clearRoute();
        routePts = latlngs.map(function (p) { return { lat: p[0], lon: p[1] }; });
        routeLine = L.polyline(latlngs, { color: '#2563eb', weight: 7, opacity: 0.85 }).addTo(map);
        endMarker = L.marker(b, { icon: endIcon, interactive: false, keyboard: false }).addTo(map);
        if (!routeFromGps) {
          startMarker = L.circleMarker(a, { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(map);
        }
        navStart(rt);
        tripTextEl.textContent = fmtTrip(rt.distance, rt.duration);
        tripEl.classList.remove('hidden');
        if (!isReroute) {
          map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
          pauseFollowUntil = Date.now() + 8000;
          resetZoom = true;
          setStatus('');
        } else {
          flash('Rerouted', false, 2000);
        }
      })
      .catch(function (err) {
        if (ctl.signal.aborted) return;
        flash((isReroute ? 'Reroute failed: ' : 'No route: ') + ((err && err.message) || 'unknown'), true, 7000);
      })
      .then(function () { if (routeCtl === ctl) { routing = false; routeCtl = null; } });
  }

  clearEl.addEventListener('click', function () {
    clearRoute();
    toPt = null; toEl.value = '';
    fromPt = null; fromEl.value = MY_LOC;
  });

  function checkRoute(lat, lon) {
    if (!routePts || !toPt) return;
    // arrived
    if (distM(lat, lon, toPt.lat, toPt.lng) < 30) {
      setStatus('You have arrived');
      setTimeout(function () { setStatus(''); }, 4000);
      var wasNav = !!steps;
      clearRoute();
      if (wasNav) speak('You have arrived');
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

  // ---------- Speed cameras (from OpenStreetMap) ----------
  var CAM_KEY = 'yb-maps-cams';
  var CAM_RADIUS_M = 10000, CAM_REFETCH_M = 4000, CAM_WARN_M = 500, CAM_CLEAR_M = 800;
  var cams = [], camCenter = null, camBusy = false, camLastTry = 0, camWarned = {};
  var camLayer = L.layerGroup().addTo(map);
  var camIcon = L.divIcon({ className: 'cam-icon', html: '<div>📷</div>', iconSize: [28, 28], iconAnchor: [14, 14] });

  function drawCams() {
    camLayer.clearLayers();
    cams.forEach(function (c) {
      L.marker([c.lat, c.lon], { icon: camIcon, interactive: false, keyboard: false }).addTo(camLayer);
    });
  }
  try {
    var savedCams = JSON.parse(localStorage.getItem(CAM_KEY) || 'null');
    if (savedCams && savedCams.cams) { cams = savedCams.cams; camCenter = savedCams.center; drawCams(); }
  } catch (e) {}

  function fetchCams(lat, lon) {
    var now = Date.now();
    if (camBusy || now - camLastTry < 30000) return;
    if (camCenter && distM(camCenter.lat, camCenter.lon, lat, lon) < CAM_REFETCH_M) return;
    camBusy = true;
    camLastTry = now;
    var a = 'around:' + CAM_RADIUS_M + ',' + lat.toFixed(5) + ',' + lon.toFixed(5);
    var q = '[out:json][timeout:25];(node["highway"="speed_camera"](' + a + ');node["enforcement"="maxspeed"](' + a + '););out;';
    overpass(q, 15000)
      .then(function (data) {
        var seen = {};
        cams = [];
        (data.elements || []).forEach(function (e) {
          if (e.lat == null || seen[e.id]) return;
          seen[e.id] = 1;
          cams.push({ id: e.id, lat: e.lat, lon: e.lon, max: parseMaxspeed(e.tags && e.tags.maxspeed) });
        });
        camCenter = { lat: lat, lon: lon };
        try { localStorage.setItem(CAM_KEY, JSON.stringify({ cams: cams, center: camCenter })); } catch (e) {}
        drawCams();
      })
      .catch(function () {})
      .then(function () { camBusy = false; });
  }

  function angDiff(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  function checkCams(lat, lon, speedMs, kmh) {
    if (!cams.length) return;
    var me = L.latLng(lat, lon);
    var moving = speedMs != null && speedMs >= 3;
    cams.forEach(function (c) {
      var d = distM(lat, lon, c.lat, c.lon);
      if (d > CAM_CLEAR_M) { delete camWarned[c.id]; return; }
      if (!moving || d > CAM_WARN_M || camWarned[c.id]) return;
      if (angDiff(bearing(me, L.latLng(c.lat, c.lon)), heading) > 45) return; // not ahead of me
      camWarned[c.id] = true;
      var lim = c.max != null ? c.max : currentLimit;
      var slow = lim != null && kmh != null && kmh > lim + 3;
      var text = 'Speed camera ahead · ' + (Math.round(d / 50) * 50) + ' m' + (slow ? ' · slow down' : '');
      flash(text, true, 7000);
      speak('Speed camera ahead' + (slow ? ', slow down' : ''));
      try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) {}
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

    lastLatLng = latlng;
    if (firstFix || Date.now() > pauseFollowUntil) {
      var z = (firstFix || resetZoom) ? (routePts ? 16 : 17) : map.getZoom();
      resetZoom = false;
      map.setView(latlng, z, { animate: !firstFix });
    }
    firstFix = false;

    if (gpsStatus) { gpsStatus = false; setStatus(''); }
    lookupLimit(c.latitude, c.longitude);
    fetchCams(c.latitude, c.longitude);
    checkCams(c.latitude, c.longitude, c.speed, kmh);
    checkRoute(c.latitude, c.longitude);
    navUpdate(c.latitude, c.longitude);
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
