/**
 * Phase 9 R2A — Inline HTML page for the read-only dashboard.
 *
 * Phase 9 R2C — Adds Cancel Run button that POSTs /api/cancel.
 *
 * The page polls `/api/events` every 2 seconds and renders the snapshot
 * using `textContent` only (no innerHTML interpolation of event fields)
 * so that user/run-supplied strings cannot inject HTML.
 */

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Review-Loop Dashboard</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 1.5rem; }
  header { display: flex; flex-wrap: wrap; gap: 1.5rem; align-items: baseline; margin-bottom: 1.5rem; }
  header h1 { font-size: 1.25rem; margin: 0; }
  .pill { padding: 0.15rem 0.6rem; border-radius: 999px; background: #eef; font-size: 0.85rem; }
  section { margin-bottom: 1.5rem; }
  h2 { font-size: 1rem; margin: 0 0 0.5rem 0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid #ccc4; vertical-align: top; }
  .muted { color: #888; font-size: 0.8rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  #cancel-btn { padding: 0.25rem 0.75rem; font-size: 0.85rem; }
  #cancel-btn[disabled] { opacity: 0.6; cursor: not-allowed; }
  #cancel-error { color: #b00; font-size: 0.8rem; }
</style>
</head>
<body>
<header>
  <h1>Review-Loop Dashboard</h1>
  <div>Run: <code id="run-id">…</code> <button id="cancel-btn" type="button" disabled>Cancel Run</button></div>
  <div>Phase: <span id="current-phase" class="pill">…</span></div>
  <div class="muted">Updated: <span id="updated-at">never</span></div>
  <div id="cancel-error" role="alert"></div>
</header>

<section>
  <h2>Latest events</h2>
  <table>
    <thead><tr><th>seq</th><th>ts</th><th>kind</th><th>phase</th><th>role</th><th>message</th></tr></thead>
    <tbody id="events-body"></tbody>
  </table>
  <p id="events-empty" class="muted" hidden>No events yet.</p>
</section>

<section>
  <h2>Artifacts</h2>
  <ul id="artifacts-list"></ul>
  <p id="artifacts-empty" class="muted" hidden>No artifacts referenced yet.</p>
</section>

<script>
(function () {
  var runIdEl = document.getElementById('run-id');
  var phaseEl = document.getElementById('current-phase');
  var updatedEl = document.getElementById('updated-at');
  var bodyEl = document.getElementById('events-body');
  var eventsEmpty = document.getElementById('events-empty');
  var artsEl = document.getElementById('artifacts-list');
  var artsEmpty = document.getElementById('artifacts-empty');
  var cancelBtn = document.getElementById('cancel-btn');
  var cancelErr = document.getElementById('cancel-error');

  var TERMINAL = { PASSED: 1, FAILED: 1, BLOCKED: 1, CANCELLED: 1 };
  var cancelInFlight = false;

  function setText(el, value) {
    el.textContent = value == null ? '' : String(value);
  }

  function renderCancelButton(phase) {
    var isTerminal = phase == null || phase === 'unknown' || TERMINAL[phase] === 1;
    if (cancelInFlight) {
      cancelBtn.disabled = true;
      setText(cancelBtn, 'Cancelling…');
      if (isTerminal) {
        cancelInFlight = false;
        setText(cancelBtn, 'Run ended');
      }
      return;
    }
    if (isTerminal) {
      cancelBtn.disabled = true;
      setText(cancelBtn, 'Run ended');
    } else {
      cancelBtn.disabled = false;
      setText(cancelBtn, 'Cancel Run');
    }
  }

  function render(snapshot) {
    setText(runIdEl, snapshot.run_id);
    setText(phaseEl, snapshot.current_phase);
    setText(updatedEl, new Date().toLocaleTimeString());
    renderCancelButton(snapshot.current_phase);

    while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
    var events = Array.isArray(snapshot.latest_events) ? snapshot.latest_events : [];
    eventsEmpty.hidden = events.length !== 0;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var tr = document.createElement('tr');
      var cells = [ev.seq, ev.ts, ev.kind, ev.phase, ev.role || '', ev.message];
      for (var c = 0; c < cells.length; c++) {
        var td = document.createElement('td');
        td.appendChild(document.createTextNode(cells[c] == null ? '' : String(cells[c])));
        tr.appendChild(td);
      }
      bodyEl.appendChild(tr);
    }

    while (artsEl.firstChild) artsEl.removeChild(artsEl.firstChild);
    var arts = Array.isArray(snapshot.artifacts) ? snapshot.artifacts : [];
    artsEmpty.hidden = arts.length !== 0;
    for (var j = 0; j < arts.length; j++) {
      var li = document.createElement('li');
      var label = arts[j].label ? arts[j].label + ' — ' : '';
      li.appendChild(document.createTextNode('[' + arts[j].type + '] ' + label + arts[j].path));
      artsEl.appendChild(li);
    }
  }

  function onCancelClick() {
    if (cancelInFlight || cancelBtn.disabled) return;
    cancelInFlight = true;
    setText(cancelErr, '');
    cancelBtn.disabled = true;
    setText(cancelBtn, 'Cancelling…');
    fetch('/api/cancel', { method: 'POST', cache: 'no-store' })
      .then(function (r) {
        if (r.status >= 200 && r.status < 300) {
          return null;
        }
        return r.text().then(function (txt) {
          var message = 'cancel failed (HTTP ' + r.status + ')';
          try {
            var parsed = JSON.parse(txt);
            if (parsed && typeof parsed.message === 'string') {
              message = parsed.message;
            }
          } catch (e) {
            if (txt) message = txt;
          }
          throw new Error(message);
        });
      })
      .catch(function (err) {
        cancelInFlight = false;
        setText(cancelErr, err && err.message ? err.message : 'cancel failed');
        // Re-enable so the user can retry; tick() will reconcile if state changed.
        cancelBtn.disabled = false;
        setText(cancelBtn, 'Cancel Run');
      });
  }

  cancelBtn.addEventListener('click', onCancelClick);

  function tick() {
    fetch('/api/events', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () {
        setText(updatedEl, 'fetch failed at ' + new Date().toLocaleTimeString());
      });
  }

  // Mode flag ensures the SSE and polling paths are mutually exclusive.
  // 'idle' before start, 'sse' when EventSource is live, 'poll' otherwise.
  var mode = 'idle';
  var pollTimer = null;
  var es = null;

  function startPolling() {
    if (mode === 'poll') return;
    stopSse();
    mode = 'poll';
    if (pollTimer == null) {
      pollTimer = setInterval(tick, 2000);
    }
  }

  function stopPolling() {
    if (pollTimer != null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function stopSse() {
    if (es != null) {
      try { es.close(); } catch (e) { /* ignore */ }
      es = null;
    }
  }

  function startSse() {
    if (typeof EventSource !== 'function') {
      startPolling();
      return;
    }
    try {
      es = new EventSource('/api/events/stream');
    } catch (e) {
      es = null;
      startPolling();
      return;
    }
    mode = 'sse';
    stopPolling();
    es.addEventListener('hello', function () {
      setText(updatedEl, new Date().toLocaleTimeString());
      tick();
    });
    es.onmessage = function () {
      // SSE acts as a freshness signal; the JSON snapshot is the source of
      // truth and keeps artifacts/current_phase accurate.
      tick();
    };
    es.onerror = function () {
      stopSse();
      mode = 'idle';
      startPolling();
    };
  }

  tick();
  startSse();
})();
</script>
</body>
</html>
`;

export function renderDashboardHtml(): string {
  return HTML;
}
