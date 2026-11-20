#!/usr/bin/env python3
"""
SoundSwitch application server.

Serves the web app, hosts the ONNX models so they are uploaded ONCE (ever),
and records every session + detection event in SQLite so history survives
across sessions, restarts and machines.
"""
import os, sqlite3, json, hashlib, datetime
from flask import Flask, request, jsonify, send_file, render_template, g, Response

ROOT = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(ROOT, "models")
DB = os.path.join(ROOT, "data", "soundswitch.db")
os.makedirs(MODELS, exist_ok=True)
os.makedirs(os.path.dirname(DB), exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024 * 1024  # 2 GB

CLASSES = ["breathing", "clock_ticking", "coughing", "eating",
           "sniffing", "throat_clearing", "typing"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS models(
  slot TEXT PRIMARY KEY, filename TEXT, bytes INTEGER,
  sha256 TEXT, uploaded_at TEXT);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT, ended_at TEXT,
  mic_label TEXT, out_label TEXT,
  gate REAL, strength REAL, hop_ms INTEGER,
  seconds REAL DEFAULT 0, events INTEGER DEFAULT 0,
  mean_db REAL DEFAULT 0, notes TEXT);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER, at TEXT, t_offset REAL,
  class TEXT, confidence REAL, removed_db REAL,
  FOREIGN KEY(session_id) REFERENCES sessions(id));
CREATE TABLE IF NOT EXISTS prefs(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS selftests(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT,
  passed INTEGER, det_ms REAL, sep_ms REAL,
  burst_db REAL, tone_db REAL, top_class TEXT, top_p REAL);
CREATE INDEX IF NOT EXISTS ix_ev_sess ON events(session_id);
"""


def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB)
        g.db.row_factory = sqlite3.Row
        g.db.executescript(SCHEMA)
    return g.db


@app.teardown_appcontext
def _close(e):
    d = g.pop("db", None)
    if d:
        d.close()


def now():
    return datetime.datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------- pages
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/history")
def history_page():
    return render_template("history.html")


# ---------------------------------------------------------------- models
def find_model(slot):
    """Locate a model file in models/ tolerantly.

    Accepts detector.onnx, detector_int8.onnx, separator_.onnx, sep.onnx,
    any casing, any extra underscores or suffixes. Exact name wins; otherwise
    the largest matching .onnx is used.
    """
    exact = os.path.join(MODELS, slot + ".onnx")
    if os.path.exists(exact):
        return exact
    key = "det" if slot == "detector" else "sep"
    hits = []
    for fn in os.listdir(MODELS):
        if not fn.lower().endswith(".onnx"):
            continue
        base = fn.lower().replace("-", "_")
        other = "sep" if key == "det" else "det"
        if key in base and other not in base:
            hits.append(os.path.join(MODELS, fn))
    if not hits:
        return None
    return max(hits, key=os.path.getsize)


@app.route("/api/models")
def api_models():
    """Scan the models/ folder. Files copied in by hand count exactly the same
    as files uploaded through the browser, and the name need not be perfect."""
    d = db()
    known = {r["slot"]: dict(r) for r in d.execute("SELECT * FROM models")}
    out, dirty = {}, False
    for slot in ("detector", "separator"):
        p = find_model(slot)
        if not p:
            if slot in known:
                d.execute("DELETE FROM models WHERE slot=?", (slot,)); dirty = True
            continue
        size = os.path.getsize(p)
        fn = os.path.basename(p)
        rec = known.get(slot)
        if not rec or rec["bytes"] != size or rec["filename"] != fn:
            rec = {"slot": slot, "filename": fn, "bytes": size,
                   "sha256": "", "uploaded_at": now()}
            d.execute("INSERT OR REPLACE INTO models VALUES(?,?,?,?,?)",
                      (slot, fn, size, "", rec["uploaded_at"]))
            dirty = True
        out[slot] = rec
    if dirty:
        d.commit()
    missing = [s for s in ("detector", "separator") if s not in out]
    present = sorted(f for f in os.listdir(MODELS) if f.lower().endswith(".onnx"))
    return jsonify({"ready": len(out) == 2, "models": out,
                    "missing": missing, "folder": MODELS,
                    "onnx_files_found": present})


@app.route("/api/models/<slot>", methods=["POST"])
def api_upload(slot):
    if slot not in ("detector", "separator"):
        return jsonify(error="bad slot"), 400
    f = request.files.get("file")
    if not f:
        return jsonify(error="no file"), 400
    path = os.path.join(MODELS, slot + ".onnx")
    f.save(path)
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    d = db()
    d.execute("INSERT OR REPLACE INTO models VALUES(?,?,?,?,?)",
              (slot, f.filename, os.path.getsize(path), h.hexdigest(), now()))
    d.commit()
    return jsonify(ok=True, slot=slot, bytes=os.path.getsize(path))


@app.route("/models/<slot>.onnx")
def serve_model(slot):
    if slot not in ("detector", "separator"):
        return "no", 404
    p = find_model(slot)
    if not p:
        return "not uploaded", 404
    r = send_file(p, mimetype="application/octet-stream", conditional=True)
    r.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return r


@app.route("/api/models", methods=["DELETE"])
def api_clear_models():
    for s in ("detector", "separator"):
        p = find_model(s)
        if p and os.path.exists(p):
            os.remove(p)
    d = db()
    d.execute("DELETE FROM models")
    d.commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- sessions
@app.route("/api/session", methods=["POST"])
def api_session_start():
    j = request.get_json(force=True, silent=True) or {}
    d = db()
    c = d.execute(
        "INSERT INTO sessions(started_at,mic_label,out_label,gate,strength,hop_ms)"
        " VALUES(?,?,?,?,?,?)",
        (now(), j.get("mic", ""), j.get("out", ""), j.get("gate", 0.3),
         j.get("strength", 1.0), j.get("hop_ms", 1024)))
    d.commit()
    return jsonify(session_id=c.lastrowid)


@app.route("/api/session/<int:sid>/events", methods=["POST"])
def api_events(sid):
    j = request.get_json(force=True, silent=True) or {}
    rows = [(sid, now(), e.get("t", 0), e.get("class", "?"),
             e.get("p", 0), e.get("db", 0)) for e in j.get("events", [])]
    if rows:
        d = db()
        d.executemany(
            "INSERT INTO events(session_id,at,t_offset,class,confidence,removed_db)"
            " VALUES(?,?,?,?,?,?)", rows)
        d.commit()
    return jsonify(ok=True, n=len(rows))


@app.route("/api/session/<int:sid>", methods=["PATCH"])
def api_session_end(sid):
    j = request.get_json(force=True, silent=True) or {}
    d = db()
    d.execute("UPDATE sessions SET ended_at=?,seconds=?,events=?,mean_db=? WHERE id=?",
              (now(), j.get("seconds", 0), j.get("events", 0),
               j.get("mean_db", 0), sid))
    d.commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- history
@app.route("/api/history")
def api_history():
    d = db()
    sess = [dict(r) for r in d.execute(
        "SELECT * FROM sessions ORDER BY id DESC LIMIT 100")]
    for s in sess:
        s["breakdown"] = [dict(r) for r in d.execute(
            "SELECT class,COUNT(*) n,AVG(confidence) p,AVG(removed_db) db"
            " FROM events WHERE session_id=? GROUP BY class ORDER BY n DESC",
            (s["id"],))]
    tot = dict(d.execute(
        "SELECT COUNT(*) sessions,COALESCE(SUM(seconds),0) seconds,"
        "COALESCE(SUM(events),0) events FROM sessions WHERE ended_at IS NOT NULL"
    ).fetchone())
    tot["by_class"] = [dict(r) for r in d.execute(
        "SELECT class,COUNT(*) n,AVG(confidence) p FROM events"
        " GROUP BY class ORDER BY n DESC")]
    tests = [dict(r) for r in d.execute(
        "SELECT * FROM selftests ORDER BY id DESC LIMIT 20")]
    return jsonify(sessions=sess, totals=tot, selftests=tests)


@app.route("/api/history", methods=["DELETE"])
def api_clear_history():
    d = db()
    d.executescript("DELETE FROM events;DELETE FROM sessions;DELETE FROM selftests;")
    d.commit()
    return jsonify(ok=True)


@app.route("/api/export.csv")
def api_export():
    d = db()
    out = ["session_id,started_at,at,t_offset,class,confidence,removed_db"]
    for r in d.execute(
            "SELECT e.session_id,s.started_at,e.at,e.t_offset,e.class,"
            "e.confidence,e.removed_db FROM events e"
            " JOIN sessions s ON s.id=e.session_id ORDER BY e.id"):
        out.append(",".join(str(x) for x in tuple(r)))
    return Response("\n".join(out), mimetype="text/csv",
                    headers={"Content-Disposition":
                             "attachment;filename=soundswitch_events.csv"})


# ---------------------------------------------------------------- prefs
@app.route("/api/prefs", methods=["GET", "POST"])
def api_prefs():
    d = db()
    if request.method == "POST":
        j = request.get_json(force=True, silent=True) or {}
        for k, v in j.items():
            d.execute("INSERT OR REPLACE INTO prefs VALUES(?,?)",
                      (k, json.dumps(v)))
        d.commit()
        return jsonify(ok=True)
    return jsonify({r["k"]: json.loads(r["v"])
                    for r in d.execute("SELECT * FROM prefs")})


@app.route("/api/selftest", methods=["POST"])
def api_selftest():
    j = request.get_json(force=True, silent=True) or {}
    d = db()
    d.execute("INSERT INTO selftests(at,passed,det_ms,sep_ms,burst_db,tone_db,"
              "top_class,top_p) VALUES(?,?,?,?,?,?,?,?)",
              (now(), 1 if j.get("passed") else 0, j.get("det_ms", 0),
               j.get("sep_ms", 0), j.get("burst_db", 0), j.get("tone_db", 0),
               j.get("top_class", ""), j.get("top_p", 0)))
    d.commit()
    return jsonify(ok=True)


if __name__ == "__main__":
    sqlite3.connect(DB).executescript(SCHEMA)
    print("SoundSwitch on http://0.0.0.0:7860")
    app.run(host="0.0.0.0", port=7860, threaded=True, debug=False)
