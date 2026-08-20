from fastapi import FastAPI
from fastapi.responses import HTMLResponse

app = FastAPI()


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return """
    <h1>Hello from your FastAPI playground</h1>
    <p>Edit <code>main.py</code> and save &mdash; uvicorn reloads itself.</p>
    <p>The generated API docs are at <a href="docs">/docs</a>.</p>
    """


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
