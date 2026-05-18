#!/usr/bin/env python3
"""
jar_launcher.py  —  Replit backend
────────────────────────────────────────────────────────────────────────────────
Setup on Replit:
  1. Add this file as jar_launcher.py in your Repl
  2. Add index.html in the same directory
  3. In Replit Shell run:  pip install flask flask-cors
  4. Set the Start Command to:  python jar_launcher.py
  5. Copy your Replit public URL into index.html where it says REPLIT_BACKEND_URL

Routes
──────
  GET  /              → serves index.html
  GET  /state         → current status JSON
  GET  /output        → SSE stream of JAR stdout/stderr
  POST /upload        → multipart upload of .jar file, returns {ok, filename}
  POST /launch        → {filename} starts the uploaded JAR
  GET  /kill          → terminate running JAR
  GET  /install_java  → install OpenJDK 21 into the Repl (runs once)

Java
────
  Replit containers are Linux (Debian/Ubuntu).
  On first run this script checks for java in PATH.
  If missing, it installs OpenJDK 21 via apt-get automatically.
  This can take ~30s on first deploy — the UI shows progress.
"""

import os, sys, json, subprocess, threading, tempfile, shutil, time, signal
from flask import Flask, request, jsonify, Response, send_file
from flask_cors import CORS

# ── Config ─────────────────────────────────────────────────────────────────────
PORT       = int(os.environ.get("PORT", 8080))   # Replit sets $PORT automatically
UPLOAD_DIR = os.path.join(tempfile.gettempdir(), "jar_uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

HERE  = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "index.html")

app = Flask(__name__)
CORS(app)   # allow the browser (any origin) to call our API

# ── App state ──────────────────────────────────────────────────────────────────
state: dict = {
    "phase":    "checking",
    "java_ok":  False,
    "java_ver": "",
    "progress": 0,
    "message":  "Checking for Java…",
}

# ── SSE output ring-buffer ─────────────────────────────────────────────────────
_out_lines:   list          = []
_out_lock:    threading.Lock = threading.Lock()
_out_waiters: list          = []   # one threading.Event per open SSE connection
MAX_LINES = 2000

def _push(line: str):
    with _out_lock:
        _out_lines.append(line)
        if len(_out_lines) > MAX_LINES:
            _out_lines.pop(0)
        for ev in _out_waiters:
            ev.set()

# ── Java detection + install ───────────────────────────────────────────────────
def _java_bin() -> str:
    jhome = os.environ.get("JAVA_HOME", "")
    if jhome:
        candidate = os.path.join(jhome, "bin", "java")
        if os.path.isfile(candidate):
            return candidate
    return "java"

def detect_java() -> bool:
    try:
        r = subprocess.run(
            [_java_bin(), "-version"],
            capture_output=True, text=True, timeout=10
        )
        ver = (r.stderr or r.stdout).split("\n")[0].strip()
        if ver:
            state.update({"java_ok": True, "java_ver": ver,
                          "phase": "idle", "message": "Ready."})
            return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    state.update({"java_ok": False, "phase": "idle",
                  "message": "Java not found. Click Install Java."})
    return False

def install_java_apt():
    """Install OpenJDK 21 via apt-get (works on Replit's Debian/Ubuntu container)."""
    state.update({"phase": "installing", "progress": 0,
                  "message": "Installing Java (apt-get update)…"})
    _push("[Install] Running apt-get update…")
    try:
        subprocess.run(
            ["apt-get", "update", "-qq"],
            check=True, capture_output=True, timeout=120
        )
        state["progress"] = 40
        _push("[Install] Installing openjdk-21-jre-headless…")
        state["message"] = "Installing openjdk-21-jre-headless…"
        subprocess.run(
            ["apt-get", "install", "-y", "-qq", "openjdk-21-jre-headless"],
            check=True, capture_output=True, timeout=300
        )
        state["progress"] = 95
        _push("[Install] Done. Verifying…")
        if detect_java():
            _push(f"[Install] Java ready: {state['java_ver']}")
        else:
            state.update({"phase": "error",
                          "message": "Installed but java not found in PATH."})
            _push("[Install] ERROR: java not in PATH after install.")
    except subprocess.CalledProcessError as e:
        err = (e.stderr or b"").decode(errors="replace")
        state.update({"phase": "error", "message": f"apt-get failed: {err[:200]}"})
        _push(f"[Install] FAILED: {err[:300]}")
    except Exception as e:
        state.update({"phase": "error", "message": str(e)})
        _push(f"[Install] FAILED: {e}")

# ── Running process ────────────────────────────────────────────────────────────
_proc:      subprocess.Popen | None = None
_proc_lock: threading.Lock          = threading.Lock()

def _stream_proc(proc: subprocess.Popen, label: str):
    def _drain(stream):
        try:
            for raw in stream:
                _push(raw.decode(errors="replace").rstrip())
        except Exception:
            pass
    t1 = threading.Thread(target=_drain, args=(proc.stdout,), daemon=True)
    t2 = threading.Thread(target=_drain, args=(proc.stderr,), daemon=True)
    t1.start(); t2.start()
    t1.join();  t2.join()
    proc.wait()
    rc = proc.returncode
    _push(f"\n[{label} — process exited with code {rc}]")
    state.update({"phase": "idle", "message": f"{label} exited (code {rc})"})
    global _proc
    with _proc_lock:
        _proc = None

def build_cmd(jar_path: str, manifest: dict) -> list:
    cmd = [_java_bin()]
    for a in manifest.get("jvm_args", []):
        cmd.append(str(a))
    cp = manifest.get("classpath", [])
    if cp:
        cmd += ["-cp", os.pathsep.join([jar_path] + [str(c) for c in cp])]
    main = manifest.get("main_class", "")
    if main:
        cmd.append(str(main))
    else:
        cmd += ["-jar", jar_path]
    for a in manifest.get("args", []):
        cmd.append(str(a))
    return cmd

# ── Routes ─────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_file(INDEX)

@app.route("/state")
def route_state():
    return jsonify(dict(state))

@app.route("/install_java")
def route_install():
    if state.get("phase") in ("installing", "downloading"):
        return jsonify({"ok": False, "error": "Already installing"})
    threading.Thread(target=install_java_apt, daemon=True).start()
    return jsonify({"ok": True})

@app.route("/upload", methods=["POST"])
def route_upload():
    if "jar" not in request.files:
        return jsonify({"ok": False, "error": "No file field named 'jar'"}), 400
    f = request.files["jar"]
    if not f.filename or not f.filename.lower().endswith(".jar"):
        return jsonify({"ok": False, "error": "File must be a .jar"}), 400
    # sanitise filename
    safe_name = os.path.basename(f.filename).replace(" ", "_")
    dest = os.path.join(UPLOAD_DIR, safe_name)
    f.save(dest)
    return jsonify({"ok": True, "filename": safe_name, "size": os.path.getsize(dest)})

@app.route("/launch", methods=["POST"])
def route_launch():
    global _proc
    data     = request.get_json(force=True, silent=True) or {}
    filename = data.get("filename", "").strip()
    manifest = data.get("manifest", {})

    if not filename:
        return jsonify({"ok": False, "error": "No filename provided"})

    jar_path = os.path.join(UPLOAD_DIR, os.path.basename(filename))
    if not os.path.isfile(jar_path):
        return jsonify({"ok": False, "error": f"JAR not found on server: {filename}"})

    if not state.get("java_ok"):
        return jsonify({"ok": False, "error": "Java is not installed on the server yet."})

    with _proc_lock:
        if _proc and _proc.poll() is None:
            return jsonify({"ok": False, "error": "A JAR is already running. Kill it first."})

        with _out_lock:
            _out_lines.clear()

        cmd = build_cmd(jar_path, manifest)
        _push("[Launching] " + " ".join(cmd))
        _push("")

        try:
            _proc = subprocess.Popen(
                cmd,
                cwd=UPLOAD_DIR,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
        except Exception as e:
            state.update({"phase": "error", "message": str(e)})
            return jsonify({"ok": False, "error": str(e)})

    label = os.path.basename(filename)
    state.update({"phase": "running", "message": f"Running {label}"})
    threading.Thread(target=_stream_proc, args=(_proc, label), daemon=True).start()
    return jsonify({"ok": True})

@app.route("/kill")
def route_kill():
    with _proc_lock:
        if _proc and _proc.poll() is None:
            try:
                os.killpg(os.getpgid(_proc.pid), signal.SIGTERM)
            except Exception:
                _proc.terminate()
            return jsonify({"ok": True})
        return jsonify({"ok": False, "error": "No running process"})

@app.route("/output")
def route_output():
    """Server-Sent Events: streams JAR output lines to the browser."""
    def generate():
        waiter = threading.Event()
        sent   = 0
        with _out_lock:
            _out_waiters.append(waiter)
        try:
            while True:
                waiter.wait(timeout=15)
                waiter.clear()
                with _out_lock:
                    batch = _out_lines[sent:]
                    sent += len(batch)
                for line in batch:
                    yield f"data: {json.dumps(line)}\n\n"
                yield ": ping\n\n"   # keepalive
        except GeneratorExit:
            pass
        finally:
            with _out_lock:
                try:
                    _out_waiters.remove(waiter)
                except ValueError:
                    pass

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
        }
    )

# ── Boot ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if not os.path.isfile(INDEX):
        print(f"\n  ERROR: index.html not found at {INDEX}")
        print("  Place index.html in the same folder as jar_launcher.py\n")
        sys.exit(1)

    # Check/detect Java in background so startup is instant
    threading.Thread(target=detect_java, daemon=True).start()

    print(f"\n  ☕  JAR Launcher backend — port {PORT}")
    print(f"  Upload dir: {UPLOAD_DIR}\n")

    # Replit needs host=0.0.0.0 to be reachable from outside
    app.run(host="0.0.0.0", port=PORT, threaded=True)
