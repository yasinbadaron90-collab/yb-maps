(function () {
  'use strict';

  var DEFAULT_CENTER = [-33.9249, 18.4241]; // Cape Town
  var OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  var LIMIT_REFETCH_M = 150;     // re-fetch the road list after moving this far from where it was fetched
  var LIMIT_MIN_INTERVAL_MS = 3000;
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
  var rotOn = false;     // map turned so the road ahead is at the top (see "Heading-up map")

  function setHeading(deg) {
    // keep rotation continuous (avoid spinning 350 -> 10 the long way)
    var diff = ((deg - shownHeading) % 360 + 540) % 360 - 180;
    shownHeading += diff;
    heading = deg;
    if (marker) {
      var svg = marker.getElement() && marker.getElement().querySelector('svg');
      if (svg) svg.style.transform = 'rotate(' + shownHeading + 'deg)';
    }
    if (rotOn) setMapRot();
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
    // "ZA:urban" etc: the legal default for that kind of road, written instead of a number (same table CoMaps uses)
    var imp = { 'za:urban': 60, 'za:rural': 100, 'za:motorway': 120 };
    if (imp[s] != null) return imp[s];
    var m = s.match(/^(\d+)\s*(mph|km\/h|kmh|kph)?$/);
    if (!m) return null; // "none", "signals" etc -> unknown, never guess
    var n = parseInt(m[1], 10);
    if (m[2] === 'mph') n = Math.round(n * 1.609344);
    return n;
  }

  var lastQuery = { time: 0 };
  var queryBusy = false;
  var currentLimit;                // undefined until the first limit is known

  function showLimit(val) {
    currentLimit = val;
    if (val == null) {
      limitValEl.textContent = '?';
      limitEl.classList.add('unknown');
      limitEl.classList.remove('three');
    } else {
      limitValEl.textContent = val;
      limitEl.classList.remove('unknown');
      limitEl.classList.toggle('three', String(val).length > 2);
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

  // The limits of every road within 500 m are fetched in one go and kept; each GPS fix then just picks the nearest
  // road from that list (instant), so a new limit shows as soon as you turn into a road. Re-fetched every ~200 m.
  // Second opinion from TomTom (posted limit "where available") for roads OpenStreetMap has no limit for.
  var ttLimit = null;               // {lat, lon, way, val} last answer (val null = TomTom doesn't know either)
  var ttBusy = false, ttLastTry = 0, ttFails = 0;
  var TT_REUSE_M = 300;             // an answer holds for this far along the same OSM road
  function parseTtLimit(s) {
    var m = String(s || '').match(/^([\d.]+)\s*(MPH|KPH)?/i);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(/MPH/i.test(m[2] || '') ? n * 1.609344 : n);
  }
  // number = TomTom's limit, null = no limit known / no key, undefined = asking right now (keep what the sign shows)
  function ttFallback(lat, lon, moving, wayId) {
    var key = getKey();
    if (!key) return null;
    var near = ttLimit && ttLimit.way === wayId && distM(ttLimit.lat, ttLimit.lon, lat, lon) < (wayId == null ? 120 : TT_REUSE_M);
    if (near) return ttLimit.val;
    var wait = Math.min(60000, 5000 * Math.pow(2, ttFails));
    if (!ttBusy && Date.now() - ttLastTry > wait) {
      ttBusy = true; ttLastTry = Date.now();
      var url = 'https://api.tomtom.com/search/2/reverseGeocode/' + lat.toFixed(6) + ',' + lon.toFixed(6) +
        '.json?key=' + encodeURIComponent(key) + '&returnSpeedLimit=true&radius=30' +
        (moving ? '&heading=' + Math.round(heading) : '');
      fetch(url).then(function (r) { if (!r.ok) throw new Error('TomTom ' + r.status); return r.json(); })
        .then(function (d) {
          ttFails = 0;
          var ad = d && d.addresses && d.addresses[0] && d.addresses[0].address;
          ttLimit = { lat: lat, lon: lon, way: wayId, val: ad ? parseTtLimit(ad.speedLimit) : null };
          var at = lastLatLng || { lat: lat, lng: lon };
          if (limitCache && distM(limitCache.lat, limitCache.lon, at.lat, at.lng) < 450) pickLimit(at.lat, at.lng, moving);
          else if (!limitCache && ttLimit.val != null) showLimit(ttLimit.val);
        })
        .catch(function () { ttFails = Math.min(ttFails + 1, 4); })
        .then(function () { ttBusy = false; });
    }
    return ttBusy ? undefined : null;
  }

  var limitCache = null;           // {lat, lon, ways}
  var limitFails = 0, limitPend = undefined, limitPendN = 0;
  var ROAD_RE = '^(' + Object.keys(DRIVABLE).join('|') + ')$';
  // moving = true: ignore roads running across our heading (side streets, junction crossings)
  // The number for a road: maxspeed, else the direction-specific one, else the legal default named in
  // maxspeed:type / source:maxspeed (e.g. "ZA:urban"). forward: true/false = travelling with/against the way's drawn direction.
  function wayLimit(t, forward) {
    var v = parseMaxspeed(t.maxspeed);
    if (v == null && forward != null) v = parseMaxspeed(forward ? t['maxspeed:forward'] : t['maxspeed:backward']);
    if (v == null && forward == null && (t['maxspeed:forward'] || t['maxspeed:backward'])) {
      // standing still: direction unknown. Same number both ways is fine; otherwise keep what the sign shows
      var fv = parseMaxspeed(t['maxspeed:forward']), bv = parseMaxspeed(t['maxspeed:backward']);
      return fv != null && fv === bv ? fv : undefined;
    }
    if (v == null) v = parseMaxspeed(t['maxspeed:type']);
    if (v == null) v = parseMaxspeed(t['source:maxspeed']);
    return v;
  }
  function pickLimit(lat, lon, moving) {
    var p = { lat: lat, lon: lon }, best = null, bestD = 30, bestB = 0;
    limitCache.ways.forEach(function (w) {
      for (var i = 0; i < w.geometry.length - 1; i++) {
        var g0 = w.geometry[i], g1 = w.geometry[i + 1];
        var d = distToSegM(p, g0, g1);
        if (d >= bestD) continue;
        var b = bearing({ lat: g0.lat, lng: g0.lon }, { lat: g1.lat, lng: g1.lon });
        if (moving && Math.min(angDiff(b, heading), angDiff(b + 180, heading)) > 50) continue;
        bestD = d; best = w; bestB = b;
      }
    });
    if (!best) return;                       // no road close by (GPS drift): keep what is showing
    var val = wayLimit(best.tags, moving ? angDiff(bestB, heading) < 90 : null);
    if (val === undefined) return;                           // one-way-only limits and we are not moving: keep the sign
    if (val == null) {                                       // OSM has no limit here: ask TomTom (once per road stretch)
      val = ttFallback(lat, lon, moving, best.id);
      if (val === undefined) return;                         // answer pending: keep the sign as it is
    }
    if (currentLimit === undefined || val === currentLimit) { limitPend = val; limitPendN = 0; showLimit(val); return; }
    // a different value must win two fixes in a row before the sign changes (no flicker at junctions)
    if (val === limitPend) limitPendN++; else { limitPend = val; limitPendN = 1; }
    if (limitPendN >= 2) showLimit(val);
  }
  function lookupLimit(lat, lon, moving) {
    var now = Date.now();
    var off = limitCache ? distM(limitCache.lat, limitCache.lon, lat, lon) : Infinity;
    if (limitCache && off < 450) pickLimit(lat, lon, moving);
    else if (limitCache ? off >= 480 : limitFails > 0) {          // road list stale, or OSM servers failing: TomTom or "?"
      var tv = ttFallback(lat, lon, moving, undefined);
      if (tv !== undefined && (tv != null || limitCache)) showLimit(tv);
    }
    var wait = Math.min(30000, LIMIT_MIN_INTERVAL_MS * Math.pow(2, limitFails));
    if (queryBusy || off < LIMIT_REFETCH_M || now - lastQuery.time < wait) return;
    queryBusy = true;
    lastQuery = { time: now };

    var q = '[out:json][timeout:10];way(around:500,' + lat.toFixed(6) + ',' + lon.toFixed(6) +
            ')[highway~"' + ROAD_RE + '"];out tags geom;';
    overpass(q, 8000)
      .then(function (data) {
        limitFails = 0;
        limitCache = {
          lat: lat, lon: lon,
          ways: (data.elements || []).filter(function (w) {
            return w.geometry && w.tags && DRIVABLE[w.tags.highway];
          })
        };
        var at = lastLatLng || { lat: lat, lng: lon };
        pickLimit(at.lat, at.lng, moving);
      })
      .catch(function () {
        limitFails = Math.min(limitFails + 1, 4);   // back off: 3, 6, 12, 24, 30 s
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
  // While a route is showing, fold the From/To boxes away (like Google) so the map stays visible; ✎ opens them again
  var barEl = document.getElementById('bar');
  var editingTrip = false;
  function syncBarMode() {
    barEl.classList.toggle('driving', !tripEl.classList.contains('hidden') && !editingTrip);
  }
  document.getElementById('edit-trip').addEventListener('click', function () {
    editingTrip = !editingTrip;
    syncBarMode();
  });

  var MY_LOC = 'My location';
  var hereEl = document.getElementById('here');
  var lastLatLng = null;       // latest GPS fix
  var fromPt = null;           // null = use my GPS position
  var toPt = null;
  var routeLine = null, endMarker = null, startMarker = null;
  var altLayers = L.layerGroup().addTo(map);   // alternative routes + time labels
  var routeOpts = [], routeSel = 0;            // routes on offer, and which one is blue
  var routeBaseAt = 0, routeBaseDur = 0, lastTrafficCheck = 0;
  var routePts = null;         // [{lat, lon}]
  var routeCum = null;         // metres along the route at each point
  var routeIdx = 0;            // where we are along routePts
  var tripFrac = 1;            // share of the route still to drive (1 = all)
  var routeFromGps = true;
  var offSince = 0, lastReroute = 0, routing = false;
  var pauseFollowUntil = 0;
  var resetZoom = false;

  var endIcon = L.divIcon({
    className: 'end-icon', html: '<div></div>', iconSize: [22, 22], iconAnchor: [11, 11]
  });

  // ---------- Stops (pickups on the way). Order = the order listed ----------
  var stopsEl = document.getElementById('stops');
  var stops = [];                 // [{row, input, pt, done}]
  var MAX_STOPS = 8;
  var stopLayer = L.layerGroup().addTo(map);

  function viaList() {            // stops still to do, in order
    return stops.filter(function (s) { return s.pt && !s.done; });
  }
  function drawStopMarkers() {
    stopLayer.clearLayers();
    stops.forEach(function (s, i) {
      if (!s.pt) return;
      L.marker(s.pt, {
        icon: L.divIcon({
          className: 'stop-icon' + (s.done ? ' done' : ''),
          html: '<div>' + (s.done ? '✓' : (i + 1)) + '</div>',
          iconSize: [26, 26], iconAnchor: [13, 13]
        }),
        interactive: false, keyboard: false
      }).addTo(stopLayer);
    });
  }
  function renumberStops() {
    stops.forEach(function (s, i) { s.num.textContent = i + 1; });
  }
  function resetStops() {
    stops.forEach(function (s) { s.row.remove(); });
    stops.length = 0;
    stopLayer.clearLayers();
  }
  function setTripText() {
    var rt = routeOpts[routeSel];
    if (!rt) return;
    var n = viaList().length;
    var dur = rt.duration * tripFrac;
    var eta = new Date(Date.now() + dur * 1000);
    var hh = ('0' + eta.getHours()).slice(-2) + ':' + ('0' + eta.getMinutes()).slice(-2);
    tripTextEl.textContent = fmtTrip(rt.distance * tripFrac, dur, (rt.delay || 0) * tripFrac) +
      ' · ' + hh + (n ? ' · 📍' + n : '');
  }

  var leftDest = false;           // with stops: only "arrived" once we have moved away from where we started or from the destination
  var routeStartPt = null;
  var routeViaS = [];             // stops this route was built with (legs match these, in order)
  function markStopDone(s) {
    if (!s || s.done) return;
    s.done = true;
    drawStopMarkers();
    setTripText();
    var nm = s.input.value.trim();
    flash('Stop reached' + (nm ? ': ' + nm : ''), false, 4000);
    if (steps) speak('Stop reached' + (nm ? ', ' + nm : ''));
  }

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
      '<div class="srow"><button id="keytoggle" type="button" class="btn2">🔑 Business search key ▸</button></div>' +
      '<div id="keypanel" class="hidden">' +
        '<p>Finds shops and businesses like Google Maps. Get a free key at developer.tomtom.com, then paste it here. It stays on this phone.</p>' +
        '<div class="srow"><input id="keyin" type="password" placeholder="Paste key" autocomplete="off">' +
        '<button id="keysave" type="button">Save</button></div>' +
        (has ? '<div class="srow" style="margin-top:8px"><button id="keyoff" type="button" class="btn2">Turn off and remove key</button></div>' : '') +
      '</div>' +
      '<div class="srow" style="margin-top:8px"><button id="refresh" type="button" class="btn2">🔄 Refresh app (get latest version)</button></div>' +
      '<p class="state" style="margin-top:8px;font-size:13px;font-weight:400">App version 37</p>';
    resultsEl.appendChild(box);
    var kp = document.getElementById('keypanel'), kt = document.getElementById('keytoggle');
    kt.addEventListener('click', function () {
      var open = kp.classList.toggle('hidden') === false;
      kt.textContent = '🔑 Business search key ' + (open ? '▾' : '▸');
    });
    document.getElementById('keysave').addEventListener('click', function () {
      var v = document.getElementById('keyin').value.trim();
      if (!v) return;
      setKey(v);
      updateTrafficUi();
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
      updateTrafficUi();
      resultsEl.innerHTML = '<div class="msg">Removed. Using free map data.</div>';
      setTimeout(function () { if (!resultsEl.querySelector('.settings')) resultsEl.innerHTML = ''; }, 2500);
    });
  }
  document.getElementById('cog').addEventListener('click', showSettings);
  // tapping the map hides the settings panel
  map.on('click', function () { if (resultsEl.querySelector('.settings')) resultsEl.innerHTML = ''; });

  // Press and hold the map to drop a pin: then choose to save it as a place or drive there
  var pinMarker = null, pinPt = null, pinWasEditing = false;
  var pinIcon = L.divIcon({ className: 'pin-icon', html: '<div>📍</div>', iconSize: [34, 34], iconAnchor: [17, 32] });
  function clearPin() { if (pinMarker) { map.removeLayer(pinMarker); pinMarker = null; } pinPt = null; }
  function closePin(restoreBar) {          // pin and its panel away; a running route is left alone
    var had = !!pinMarker;
    clearPin();
    if (had && resultsEl.querySelector('.pin-panel')) resultsEl.innerHTML = '';
    if (had && restoreBar) { editingTrip = pinWasEditing; syncBarMode(); }
  }
  map.on('contextmenu', function (e) {
    if (!pinMarker) pinWasEditing = editingTrip;
    clearPin();
    pinPt = e.latlng;                       // toPt (the live destination) is only set when Go here is tapped
    pinMarker = L.marker(e.latlng, { icon: pinIcon, interactive: false, keyboard: false }).addTo(map);
    editingTrip = true; syncBarMode();      // the choices show in the results area, which is folded while a route shows
    resultsEl.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'namer pin-panel';
    box.innerHTML =
      '<p class="state">Dropped pin · ' + e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5) + '</p>' +
      '<div class="srow pin-acts"><button id="pin-save" type="button">⭐ Save place</button>' +
      '<button id="pin-go" type="button">🧭 Go here</button>' +
      '<button id="pin-x" type="button" class="btn2" aria-label="Cancel">✕</button></div>';
    resultsEl.appendChild(box);
    var at = e.latlng;
    document.getElementById('pin-save').addEventListener('click', function () {
      showNamePicker(at.lat, at.lng, '', function () { closePin(true); });
    });
    document.getElementById('pin-go').addEventListener('click', function () {
      toPt = at; toEl.value = 'Dropped pin';
      go();
    });
    document.getElementById('pin-x').addEventListener('click', function () { closePin(true); });
  });
  toEl.addEventListener('input', function () { closePin(false); });

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
  function showNamePicker(lat, lon, hint, onSaved) {
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
      if (onSaved) onSaved();
      placeSaved(name);
    });
  }

  document.getElementById('save-place').addEventListener('click', function () {
    if (!toPt) return;
    editingTrip = true; syncBarMode();     // the name picker shows in the results area, which is folded while driving
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

  // Saved places (favourites) to pick a stop from
  function showStopPlaces(s) {
    resultsEl.innerHTML = '';
    var places = getPlaces();
    if (!places.length) {
      var m = document.createElement('div');
      m.className = 'msg';
      m.textContent = 'No saved places yet. Type an address, then tap ⭐ on the stop to save it.';
      resultsEl.appendChild(m);
      return;
    }
    places.forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'res';
      var left = document.createElement('span');
      left.className = 'res-name';
      var t = document.createElement('b');
      t.textContent = '⭐ ' + p.name;
      left.appendChild(t);
      d.appendChild(left);
      if (lastLatLng) {
        var dist = document.createElement('span');
        dist.className = 'res-dist';
        dist.textContent = fmtDist(distM(lastLatLng.lat, lastLatLng.lng, p.lat, p.lon));
        d.appendChild(dist);
      }
      d.addEventListener('click', function () {
        s.pt = L.latLng(p.lat, p.lon);
        s.done = false;
        s.input.value = p.name;
        resultsEl.innerHTML = '';
        go();
      });
      resultsEl.appendChild(d);
    });
  }

  function addStop() {
    if (stops.length >= MAX_STOPS) { flash('Up to ' + MAX_STOPS + ' stops', true, 3000); return; }
    var row = document.createElement('div');
    row.className = 'row stop-row';
    row.innerHTML =
      '<span class="stopnum"></span>' +
      '<input type="text" placeholder="Stop (pickup)" autocomplete="off" enterkeyhint="search">' +
      '<button type="button" class="icon-btn s-save" aria-label="Save this stop">⭐</button>' +
      '<button type="button" class="icon-btn s-del" aria-label="Remove this stop">✕</button>';
    stopsEl.appendChild(row);
    var s = { row: row, input: row.querySelector('input'), num: row.querySelector('.stopnum'), pt: null, done: false };
    stops.push(s);
    renumberStops();
    s.input.addEventListener('input', function () { s.pt = null; s.done = false; });
    s.input.addEventListener('focus', function () { if (!s.input.value.trim()) showStopPlaces(s); });
    s.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { s.input.blur(); go(); } });
    row.querySelector('.s-save').addEventListener('click', function () {
      if (!s.pt) { flash('Pick the place first, then tap ⭐', true, 3000); return; }
      showNamePicker(s.pt.lat, s.pt.lng, s.input.value.trim());
    });
    row.querySelector('.s-del').addEventListener('click', function () {
      var i = stops.indexOf(s);
      if (i >= 0) stops.splice(i, 1);
      row.remove();
      renumberStops();
      drawStopMarkers();
      resultsEl.innerHTML = '';
      if (routePts && toPt) go();   // redo the route without it
    });
    s.input.focus();
  }
  document.getElementById('add-stop').addEventListener('click', addStop);

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
    clearPin();
    unlockSpeech();
    var fromText = fromEl.value.trim();
    var toText = toEl.value.trim();
    if (fromText && fromText !== MY_LOC && !fromPt) return search(fromText, pickFrom);
    for (var i = 0; i < stops.length; i++) {
      var st = stops[i], txt = st.input.value.trim();
      if (txt && !st.pt) {
        return search(txt, (function (s) {
          return function (r) {
            s.pt = L.latLng(parseFloat(r.lat), parseFloat(r.lon));
            s.done = false;
            s.input.value = shortName(r);
            go();
          };
        })(st));
      }
    }
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

  function fmtDur(s) {
    var min = Math.round(s / 60);
    return min >= 60 ? Math.floor(min / 60) + ' h ' + (min % 60) + ' min' : Math.max(1, min) + ' min';
  }
  function fmtTrip(m, s, delay) {
    var km = m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
    var t = km + ' · ' + fmtDur(s);
    if (delay >= 60) t += ' (+' + Math.round(delay / 60) + ' min traffic)';
    return t;
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
    if (st.type === 'stop') return '📍';
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
    if (st.type === 'stop') return 'Stop at ' + (st.name || 'your stop');
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
    // stops: a leg end is a stop, not the destination; later legs need no "depart"
    list = list.filter(function (s, i) { return !(i > 0 && s.type === 'depart'); });
    var vi = 0;
    list.forEach(function (s, i) {
      if (s.type === 'arrive' && i < list.length - 1) {
        s.type = 'stop';
        s.ref = routeViaS[vi] || null;
        s.name = s.ref ? s.ref.input.value.trim() : '';
        vi++;
      }
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
    // reached this manoeuvre: move on (a stop also counts as done once we drive past it)
    var reached = false;
    if (!isLast) {
      if (st.type === 'stop') {
        if (st._min == null || d < st._min) st._min = d;
        reached = d < 40 || (st._min < 150 && d > st._min + 80);
      } else {
        reached = d < 25;
      }
    }
    if (reached) {
      if (st.type === 'stop' && (d < 40 || st._min < 100)) markStopDone(st.ref);  // drove past but never got close: leave it on the list
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

  var keepTraffic = false;        // set while a new route replaces the old one (no tile flicker)
  function clearRoute() {
    if (routeLine && routeLine._label) map.removeLayer(routeLine._label);
    if (routeLine && routeLine._extra) map.removeLayer(routeLine._extra);
    [routeLine, endMarker, startMarker].forEach(function (l) { if (l) map.removeLayer(l); });
    routeLine = endMarker = startMarker = null;
    altLayers.clearLayers();
    routeOpts = [];
    routePts = null;
    offSince = 0;
    navReset();
    tripEl.classList.add('hidden');
    resultsEl.innerHTML = '';
    if (!keepTraffic) { editingTrip = false; syncBarMode(); updateTrafficUi(); applyRotation(); }
  }

  var routeCtl = null;

  // Ask the route servers in turn (each gets 10 s). Returns the first good route.
  function fetchOsrm(a, b, signal, via) {
    var pts = [a].concat(via || [], [b]);
    var tail = pts.map(function (p) { return p.lng + ',' + p.lat; }).join(';') +
      '?overview=full&geometries=geojson&steps=true';
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
          var r0 = data.routes[0];
          r0.delay = 0;
          return r0;
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

  // ---------- TomTom routing: live traffic, fastest route, alternatives ----------
  function mapTT(i) {
    var m = i.maneuver, t = i.instructionType, p = i.point;
    if (p && (t === 'LOCATION_WAYPOINT' || m === 'WAYPOINT_REACHED')) {
      return { maneuver: { type: 'arrive', location: [p.longitude, p.latitude] }, name: '' };
    }
    if (!p || t === 'DIRECTION_INFO') return null;
    var ang = i.turnAngleInDecimalDegrees || 0;
    var side = ang < -10 ? 'left' : ang > 10 ? 'right' : 'straight';
    var o = { type: 'turn', modifier: 'straight', exit: i.roundaboutExitNumber, location: [p.longitude, p.latitude] };
    switch (m) {
      case 'DEPART': o.type = 'depart'; break;
      case 'ARRIVE': case 'ARRIVE_LEFT': case 'ARRIVE_RIGHT': o.type = 'arrive'; break;
      case 'TURN_LEFT': o.modifier = 'left'; break;
      case 'TURN_RIGHT': o.modifier = 'right'; break;
      case 'SHARP_LEFT': o.modifier = 'sharp left'; break;
      case 'SHARP_RIGHT': o.modifier = 'sharp right'; break;
      case 'BEAR_LEFT': o.modifier = 'slight left'; break;
      case 'BEAR_RIGHT': o.modifier = 'slight right'; break;
      case 'KEEP_LEFT': o.type = 'fork'; o.modifier = 'left'; break;
      case 'KEEP_RIGHT': o.type = 'fork'; o.modifier = 'right'; break;
      case 'MAKE_UTURN': case 'TRY_MAKE_UTURN': o.modifier = 'uturn'; break;
      case 'ROUNDABOUT_CROSS': case 'ROUNDABOUT_RIGHT': case 'ROUNDABOUT_LEFT': case 'ROUNDABOUT_BACK':
        o.type = 'roundabout'; o.modifier = side; break;
      case 'MOTORWAY_EXIT_LEFT': o.type = 'fork'; o.modifier = 'left'; break;
      case 'MOTORWAY_EXIT_RIGHT': o.type = 'fork'; o.modifier = 'right'; break;
      case 'ENTER_MOTORWAY': case 'ENTER_FREEWAY': case 'ENTER_HIGHWAY': case 'TAKE_EXIT':
      case 'ENTRANCE_RAMP': case 'SWITCH_PARALLEL_ROAD': case 'SWITCH_MAIN_ROAD':
        o.type = 'fork'; o.modifier = side; break;
      default: return null; // straight on / follow the road: nothing to announce
    }
    var name = i.street || (i.roadNumbers && i.roadNumbers[0]) || '';
    return { maneuver: o, name: name };
  }

  // TomTom answer -> same shape the OSRM route has, so drawing + voice are shared
  function fromTomTom(r) {
    var coords = [];
    (r.legs || []).forEach(function (l) {
      (l.points || []).forEach(function (p) { coords.push([p.longitude, p.latitude]); });
    });
    var steps = [];
    ((r.guidance && r.guidance.instructions) || []).forEach(function (i) {
      var st = mapTT(i);
      if (st) steps.push(st);
    });
    if (coords.length && (!steps.length || steps[0].maneuver.type !== 'depart')) {
      steps.unshift({ maneuver: { type: 'depart', location: coords[0] }, name: '' });
    }
    if (coords.length && steps[steps.length - 1].maneuver.type !== 'arrive') {
      steps.push({ maneuver: { type: 'arrive', location: coords[coords.length - 1] }, name: '' });
    }
    var tsec = [];
    (r.sections || []).forEach(function (x) {
      if (x.sectionType === 'TRAFFIC' && x.magnitudeOfDelay > 0) {
        tsec.push({ s: x.startPointIndex, e: x.endPointIndex, mag: x.magnitudeOfDelay });
      }
    });
    var sm = r.summary || {};
    return {
      tsec: tsec,            // jam stretches along the route (TomTom only); [] = flowing
      geometry: { coordinates: coords },
      distance: sm.lengthInMeters,
      duration: sm.travelTimeInSeconds,
      delay: sm.trafficDelayInSeconds || 0,
      legs: [{ steps: steps }]
    };
  }

  function fetchTomTomRoutes(a, b, signal, alts, key, via) {
    via = via || [];
    var path = [a].concat(via, [b]).map(function (p) { return p.lat + ',' + p.lng; }).join(':');
    var url = 'https://api.tomtom.com/routing/1/calculateRoute/' + path +
      '/json?key=' + encodeURIComponent(key) +
      '&traffic=true&routeType=fastest&travelMode=car&computeTravelTimeFor=all&sectionType=traffic&instructionsType=text&language=en-GB' +
      '&maxAlternatives=' + (alts && !via.length ? 2 : 0);
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 10000);
    signal.addEventListener('abort', function () { ctl.abort(); });
    return fetch(url, { signal: ctl.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('TomTom ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (!d.routes || !d.routes.length) throw new Error('no route');
        return d.routes.map(fromTomTom).filter(function (x) { return x.geometry.coordinates.length > 1; });
      })
      .catch(function (e) { clearTimeout(timer); throw e; });
  }

  // Routes to offer. With a TomTom key: live-traffic fastest + alternatives. Otherwise (or if TomTom fails): free OSRM.
  function fetchRoutes(a, b, signal, alts, via) {
    var key = getKey();
    var free = function () { return fetchOsrm(a, b, signal, via).then(function (r) { return [r]; }); };
    if (!key) return free();
    return fetchTomTomRoutes(a, b, signal, alts, key, via).then(function (rs) {
      if (!rs.length) throw new Error('no route');
      return rs;
    }).catch(function (err) {
      if (signal.aborted) throw err;
      return free();
    });
  }

  function flash(text, isError, ms) {
    setStatus(text, isError);
    setTimeout(function () { if (statusEl.textContent === text) setStatus(''); }, ms || 6000);
  }

  function routeTag(rt) {
    return fmtDur(rt.duration) + (rt.delay >= 60 ? ' · +' + Math.round(rt.delay / 60) : '');
  }

  function drawTrafficParts(group, latlngs, tsec, from) {
    tsec.forEach(function (x) {
      if (x.e <= from) return;
      var part = latlngs.slice(Math.max(x.s, from), x.e + 1);
      if (part.length < 2) return;
      var col = x.mag === 1 ? '#eab308' : x.mag === 2 ? '#f97316' : x.mag === 3 ? '#dc2626' : '#7f1d1d';
      L.polyline(part, { color: col, weight: 8, opacity: 1 }).addTo(group);
    });
  }
  // the part of the route already driven is not drawn any more
  var lastTrimIdx = 0;
  function trimRouteLine() {
    var ln = routeLine;
    if (!ln || !ln._ll) return;
    ln.setLatLngs(ln._ll.slice(routeIdx));
    if (ln._extra) { ln._extra.clearLayers(); drawTrafficParts(ln._extra, ln._ll, ln._tsec, routeIdx); }
    lastTrimIdx = routeIdx;
  }
  function addRouteLine(i, sel) {
    var rt = routeOpts[i];
    var latlngs = rt.geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
    // with live traffic: the chosen route is green where it flows, yellow/orange/red where it is slow
    var live = sel && trafficOn && !!rt.tsec;
    var line = L.polyline(latlngs, {
      color: sel ? (live ? '#16a34a' : '#2563eb') : '#94a3b8', weight: sel ? 7 : 6, opacity: sel ? 0.95 : 0.85
    });
    line._ll = latlngs;
    line._tsec = rt.tsec || [];
    if (live && rt.tsec.length) {
      var extra = L.layerGroup();
      drawTrafficParts(extra, latlngs, rt.tsec, 0);
      line._extra = extra;
    }
    if (routeOpts.length > 1) {
      var mid = latlngs[Math.floor(latlngs.length / 2)];
      var label = L.marker(mid, {
        icon: L.divIcon({
          className: 'route-label',
          html: '<div class="' + (sel ? 'sel' : '') + '">' + routeTag(rt) + '</div>',
          iconSize: [80, 26], iconAnchor: [40, 13]
        }),
        keyboard: false
      });
      label.on('click', function () { selectRoute(i); });
      if (sel) label.addTo(map); else label.addTo(altLayers);
      line._label = label;
    }
    if (sel) { line.addTo(map); if (line._extra) line._extra.addTo(map); }
    else { line.addTo(altLayers); line.on('click', function () { selectRoute(i); }); }
    return line;
  }

  function renderRoutes() {
    altLayers.clearLayers();
    if (routeLine) {
      if (routeLine._label) map.removeLayer(routeLine._label);
      if (routeLine._extra) map.removeLayer(routeLine._extra);
      map.removeLayer(routeLine);
      routeLine = null;
    }
    routeOpts.forEach(function (rt, i) { if (i !== routeSel) addRouteLine(i, false); });
    routeLine = addRouteLine(routeSel, true);
    lastTrimIdx = 0;
    if (routeIdx > 0) trimRouteLine();
    updateTrafficUi();
  }

  // Make the chosen route the active one: path for off-route checks, voice steps, trip text
  function applyRoute() {
    var rt = routeOpts[routeSel];
    routePts = rt.geometry.coordinates.map(function (c) { return { lat: c[1], lon: c[0] }; });
    routeCum = [0];
    for (var k = 1; k < routePts.length; k++) {
      routeCum.push(routeCum[k - 1] + distM(routePts[k - 1].lat, routePts[k - 1].lon, routePts[k].lat, routePts[k].lon));
    }
    routeIdx = 0;
    tripFrac = 1;
    navStart(rt);
    setTripText();
    tripEl.classList.remove('hidden');
    syncBarMode();
    routeBaseAt = Date.now();
    routeBaseDur = rt.duration;
  }

  function selectRoute(i) {
    if (i === routeSel || !routeOpts[i]) return;
    routeSel = i;
    routeIdx = 0;
    renderRoutes();
    applyRoute();
  }

  // mode: 'new' (fit map), 'reroute', 'faster' (traffic found a quicker way)
  function showRoutes(routes, a, b, mode, savedSec, viaS) {
    routes.sort(function (x, y) { return x.duration - y.duration; });
    keepTraffic = true;
    clearRoute();
    keepTraffic = false;
    routeViaS = viaS || [];
    if (mode === 'new') { leftDest = false; routeStartPt = lastLatLng || a; editingTrip = false; }
    routeOpts = routes;
    routeSel = 0;
    endMarker = L.marker(b, { icon: endIcon, interactive: false, keyboard: false }).addTo(map);
    drawStopMarkers();
    if (!routeFromGps) {
      startMarker = L.circleMarker(a, { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(map);
    }
    routeIdx = 0;
    renderRoutes();
    applyRoute();
    if (mode === 'new') {
      previewUntil = Date.now() + 8000;      // overview is north-up; turning starts when it ends
      applyRotation();
      var bnds = routeLine.getBounds();
      altLayers.eachLayer(function (l) { if (l.getBounds) bnds.extend(l.getBounds()); });
      map.fitBounds(bnds, { padding: [40, 40] });
      pauseFollowUntil = Date.now() + 8000;
      resetZoom = true;
      setStatus('');
    } else if (mode === 'faster') {
      var mins = Math.max(1, Math.round(savedSec / 60));
      flash('Faster route found · saves ' + mins + ' min', false, 6000);
      speak('Faster route found, saving ' + mins + (mins === 1 ? ' minute' : ' minutes'));
    } else {
      flash('Rerouted', false, 2000);
    }
  }

  function drawRoute(a, b, isReroute) {
    if (routing) {
      if (isReroute) return;          // let the running request finish
      if (routeCtl) routeCtl.abort(); // a new destination replaces a stuck one
    }
    var viaS = viaList();
    var via = viaS.map(function (s) { return s.pt; });
    if (!isReroute && !via.length && distM(a.lat, a.lng, b.lat, b.lng) < 40) {
      flash('You are already here');
      return;
    }
    routing = true;
    var ctl = new AbortController();
    routeCtl = ctl;
    if (!isReroute) setStatus('Finding route…');
    fetchRoutes(a, b, ctl.signal, !isReroute, via)
      .then(function (routes) {
        if (ctl.signal.aborted) return;
        showRoutes(routes, a, b, isReroute ? 'reroute' : 'new', 0, viaS);
      })
      .catch(function (err) {
        if (ctl.signal.aborted) return;
        flash((isReroute ? 'Reroute failed: ' : 'No route: ') + ((err && err.message) || 'unknown'), true, 7000);
      })
      .then(function () { if (routeCtl === ctl) { routing = false; routeCtl = null; } });
  }

  // Every 5 min on a TomTom route: if live traffic now has a clearly quicker way, switch to it
  function trafficRefresh(lat, lon) {
    var key = getKey();
    var now = Date.now();
    if (!key || !routePts || !toPt || !routeFromGps || routing) return;
    if (now - routeBaseAt < 300000 || now - lastTrafficCheck < 300000) return;
    lastTrafficCheck = now;
    var ctl = new AbortController();
    var here = L.latLng(lat, lon), dest = toPt;
    var viaNowS = viaList();
    var viaNow = viaNowS.map(function (s) { return s.pt; });
    fetchTomTomRoutes(here, dest, ctl.signal, false, key, viaNow).then(function (rs) {
      if (!routePts || toPt !== dest || routing || !rs.length) return;
      var left = Math.max(0, routeBaseDur - (Date.now() - routeBaseAt) / 1000);
      var saved = left - rs[0].duration;
      if (saved >= 120) showRoutes(rs, here, dest, 'faster', saved, viaNowS);
    }).catch(function () {});
  }

  clearEl.addEventListener('click', function () {
    clearRoute();
    closePin(false);
    resetStops();
    toPt = null; toEl.value = '';
    fromPt = null; fromEl.value = MY_LOC;
  });

  // km and time left shrink as we drive (nearest point ahead of where we last were)
  function updateProgress(lat, lon) {
    if (!routePts || !routeCum || routePts.length < 2) return;
    var best = -1, bestD = Infinity;
    function scan(from, to) {
      for (var i = from; i <= to; i++) {
        var d = distM(lat, lon, routePts[i].lat, routePts[i].lon);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    scan(Math.max(0, routeIdx - 10), Math.min(routePts.length - 1, routeIdx + 400));
    if (bestD > 200) scan(0, routePts.length - 1);   // after a GPS gap we may be far ahead: look at the whole route
    if (best < 0 || bestD > 200) return;          // off the route: a reroute will reset this
    routeIdx = best;
    if (routeIdx - lastTrimIdx >= 3 || routeIdx < lastTrimIdx) trimRouteLine();
    var total = routeCum[routeCum.length - 1];
    var frac = total > 0 ? (total - routeCum[best]) / total : 0;
    if (Math.abs(frac - tripFrac) < 0.0005 && Date.now() - tripTick < 20000) return;
    tripFrac = frac;
    tripTick = Date.now();
    setTripText();
  }
  var tripTick = 0;
  function checkRoute(lat, lon) {
    if (!routePts || !toPt) return;
    // reached the next stop?
    var nx = viaList()[0];
    if (nx && routeFromGps && distM(lat, lon, nx.pt.lat, nx.pt.lng) < 50) markStopDone(nx);
    // arrived: not while stops are still to do (unless nav is already on the final leg)
    if (distM(lat, lon, toPt.lat, toPt.lng) > 100 || (routeStartPt && distM(lat, lon, routeStartPt.lat, routeStartPt.lng) > 150)) leftDest = true;
    var onFinal = (leftDest || !routeViaS.length) && (!viaList().length || !steps || (steps[stepIdx] && steps[stepIdx].type === 'arrive'));
    if (onFinal && distM(lat, lon, toPt.lat, toPt.lng) < 30) {
      setStatus('You have arrived');
      setTimeout(function () { setStatus(''); }, 4000);
      var wasNav = !!steps;
      clearRoute();
      resetStops();
      if (wasNav) speak('You have arrived');
      return;
    }
    if (!routeFromGps) return; // custom start: no rerouting
    updateProgress(lat, lon);
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

  // ---------- Live traffic overlay (TomTom flow tiles) ----------
  var TRAFFIC_KEY = 'yb-maps-traffic';
  var trafficOn = true;
  try { trafficOn = localStorage.getItem(TRAFFIC_KEY) !== '0'; } catch (e) {}
  var trafficLayer = null;
  var trafficBtn = document.getElementById('traffic');
  function updateTrafficUi() {
    var key = getKey();
    trafficBtn.classList.toggle('hidden', !key);
    trafficBtn.classList.toggle('on', trafficOn && !!key);
    // road-by-road traffic tiles only when there is no route; with a route the line itself shows traffic
    var rt = routeOpts[routeSel];
    var want = !!key && trafficOn && !(rt && rt.tsec);
    if (trafficLayer && (!want || trafficLayer._ybKey !== key)) { map.removeLayer(trafficLayer); trafficLayer = null; }
    if (want && !trafficLayer) {
      trafficLayer = L.tileLayer('https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=' + encodeURIComponent(key), {
        maxZoom: 19, opacity: 0.85
      }).addTo(map);
      trafficLayer._ybKey = key;
    }
  }
  trafficBtn.addEventListener('click', function () {
    trafficOn = !trafficOn;
    try { localStorage.setItem(TRAFFIC_KEY, trafficOn ? '1' : '0'); } catch (e) {}
    updateTrafficUi();
    if (routeOpts.length) renderRoutes();
  });
  updateTrafficUi();

  // Touching the map (drag / pinch) pauses auto-follow for 10 s so the map stops snapping back.
  var recenterBtn = document.getElementById('recenter');
  function holdFollow() {
    pauseFollowUntil = Math.max(pauseFollowUntil, Date.now() + 10000);
    if (previewUntil > Date.now()) previewUntil = pauseFollowUntil;   // still reading the overview: don't turn it yet
    recenterBtn.classList.remove('hidden');
  }
  var mapBox = map.getContainer();
  ['touchstart', 'touchmove', 'touchend', 'wheel', 'mousedown'].forEach(function (ev) {
    mapBox.addEventListener(ev, holdFollow, { passive: true });
  });
  recenterBtn.addEventListener('click', function () {
    pauseFollowUntil = 0;
    recenterBtn.classList.add('hidden');
    if (lastLatLng) map.setView(lastLatLng, map.getZoom(), { animate: true });
  });
  setInterval(function () { if (Date.now() > pauseFollowUntil) recenterBtn.classList.add('hidden'); }, 1000);

  // ---------- Heading-up map: while driving a route the road ahead is at the top ----------
  // The map box is made bigger than the screen (so no corners show) and turned with CSS; the arrow's own
  // rotation then cancels out and it points up. Not used while previewing a route or when north-up is chosen.
  var HEADUP_KEY = 'yb-maps-headup';   // '1' = turn the map to the driving direction (default: north-up, labels always upright)
  var northLock = true;
  try { northLock = localStorage.getItem(HEADUP_KEY) !== '1'; } catch (e) {}
  var mapEl = document.getElementById('map');
  var compassEl = document.getElementById('compass');
  var compassSvg = compassEl.querySelector('svg');
  var previewUntil = 0;           // route overview showing (north-up) until this time
  var rotBox = 0;
  var PIVOT_Y = 0.6;              // arrow sits 60% down the screen (45% sideways) so more road shows ahead

  function wantRot() { return !!(routePts && routeFromGps && lastLatLng && !northLock && Date.now() > previewUntil); }
  function setRotBox() {
    var vw = window.innerWidth, vh = window.innerHeight, px = vw / 2, py = vh * (vw > vh ? 0.45 : PIVOT_Y);
    rotBox = Math.ceil(2 * Math.hypot(Math.max(px, vw - px), Math.max(py, vh - py)));
    mapEl.style.width = rotBox + 'px';
    mapEl.style.height = rotBox + 'px';
    mapEl.style.left = (px - rotBox / 2) + 'px';
    mapEl.style.top = (py - rotBox / 2) + 'px';
    mapEl.style.right = 'auto';
    mapEl.style.bottom = 'auto';
  }
  function setMapRot() {
    mapEl.style.setProperty('--mr', shownHeading);   // markers use it to stay upright
    mapEl.style.transform = 'rotate(' + (-shownHeading) + 'deg)';
    compassSvg.style.transform = 'rotate(' + (-shownHeading) + 'deg)';
  }
  function applyRotation() {
    var want = wantRot();
    compassEl.classList.toggle('hidden', !routePts);
    compassEl.classList.toggle('on', !northLock);
    compassEl.setAttribute('aria-pressed', northLock ? 'false' : 'true');
    document.getElementById('attrib').classList.toggle('hidden', !want);
    if (want === rotOn) return;
    var ctr = map.getCenter(), z = map.getZoom();
    rotOn = want;
    compassSvg.style.transition = 'none';      // needle jumps, never spins several turns
    if (want) {
      setRotBox();
      setMapRot();
      void mapEl.offsetWidth;
      mapEl.classList.add('rot');
      map.dragging.disable();
      map.options.touchZoom = 'center';
      map.options.doubleClickZoom = 'center';
    } else {
      mapEl.classList.remove('rot');
      ['width', 'height', 'left', 'top', 'right', 'bottom', 'transform'].forEach(function (k) { mapEl.style[k] = ''; });
      mapEl.style.setProperty('--mr', 0);
      compassSvg.style.transform = '';
      map.dragging.enable();
      map.options.touchZoom = true;
      map.options.doubleClickZoom = true;
    }
    void compassSvg.offsetWidth;
    compassSvg.style.transition = '';
    map.invalidateSize({ animate: false });
    map.setView(want && Date.now() > pauseFollowUntil && lastLatLng ? lastLatLng : ctr, z, { animate: false });
  }
  compassEl.addEventListener('click', function () {
    northLock = !northLock;
    try { localStorage.setItem(HEADUP_KEY, northLock ? '0' : '1'); } catch (e) {}
    applyRotation();
  });
  window.addEventListener('resize', function () {
    if (!rotOn) return;
    setRotBox();
    map.invalidateSize({ animate: false });
  });
  // a turned map: Leaflet's own drag and tap maths assume north is up, so pan by hand and un-turn taps
  var panLast = null;
  mapEl.addEventListener('touchstart', function (e) {
    panLast = (rotOn && e.touches.length === 1) ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  mapEl.addEventListener('touchmove', function (e) {
    if (!rotOn || !panLast) return;
    if (e.touches.length !== 1) { panLast = null; return; }
    var t = e.touches[0], dx = t.clientX - panLast.x, dy = t.clientY - panLast.y;
    var a = shownHeading * Math.PI / 180;
    map.panBy([-(dx * Math.cos(a) - dy * Math.sin(a)), -(dx * Math.sin(a) + dy * Math.cos(a))], { animate: false });
    panLast = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  ['touchend', 'touchcancel'].forEach(function (ev) {
    mapEl.addEventListener(ev, function () { panLast = null; }, { passive: true });
  });
  var origMouseToPoint = map.mouseEventToContainerPoint;
  map.mouseEventToContainerPoint = function (e) {
    if (!rotOn) return origMouseToPoint.call(map, e);
    var r = mapEl.getBoundingClientRect(), a = shownHeading * Math.PI / 180;
    var dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    return L.point(dx * Math.cos(a) - dy * Math.sin(a) + rotBox / 2, dx * Math.sin(a) + dy * Math.cos(a) + rotBox / 2);
  };
  setInterval(applyRotation, 1000);

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
    applyRotation();
    if (firstFix || Date.now() > pauseFollowUntil) {
      var z = (firstFix || resetZoom) ? (routePts ? 16 : 17) : map.getZoom();
      resetZoom = false;
      map.setView(latlng, z, { animate: !firstFix });
    }
    recenterBtn.classList.toggle('hidden', !firstFix && Date.now() > pauseFollowUntil);
    firstFix = false;

    if (gpsStatus) { gpsStatus = false; setStatus(''); }
    lookupLimit(c.latitude, c.longitude, moving);
    fetchCams(c.latitude, c.longitude);
    checkCams(c.latitude, c.longitude, c.speed, kmh);
    checkRoute(c.latitude, c.longitude);
    trafficRefresh(c.latitude, c.longitude);
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
  // the screen follows the phone (portrait or sideways). Drop any lock an older version set.
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
  try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch (e) {}

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  // exposed for tests
  window.__ybmaps = { onPosition: onPosition, showLimit: showLimit, map: map };
})();
