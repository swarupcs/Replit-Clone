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
    app.run(host="0.0.0.0", port=5000, debug=True)
