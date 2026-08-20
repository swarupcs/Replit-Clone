package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

const page = `<h1>Hello from your Go playground</h1>
<p>Edit <code>main.go</code> and save, then restart the dev server.</p>`

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Anything that is not the root is a 404, not the home page.
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(page))
	})

	http.HandleFunc("/api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	// 0.0.0.0 so the preview proxy can reach this from outside the container.
	addr := "0.0.0.0:" + port
	log.Printf("Listening on http://%s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}
