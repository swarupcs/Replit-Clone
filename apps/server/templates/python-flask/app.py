from flask import Flask, jsonify

app = Flask(__name__)


@app.get("/")
def index():
    return "<h1>Hello from your Python playground</h1><p>Edit app.py and save.</p>"


@app.get("/api/health")
def health():
    return jsonify(status="ok")


if __name__ == "__main__":
    # 0.0.0.0 so the preview proxy can reach this from outside the container.
    #
    # `debug=True` would also switch on the Werkzeug debugger, whose console
    # executes arbitrary Python on any traceback page. Reloading is the part
    # that is actually wanted here, so ask for that alone.
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=True)
