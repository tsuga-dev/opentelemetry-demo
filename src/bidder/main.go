// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"log"
	"math"
	"math/rand"
	"net"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const baseBid = 0.0021

func bidAmount(base, factor float64, w int, noise float64) float64 {
	return base * factor * math.Log(1+float64(w)) * noise
}

func hostname(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return host
}

func factorFor(host string, keys []string) float64 {
	switch hostname(host) {
	case "bidder-astro":
		if slices.Contains(keys, "telescopes") || slices.Contains(keys, "binoculars") {
			return 1.2
		}
		return 1.0
	case "bidder-generic":
		return 0.8
	default:
		return 1.0
	}
}

func newHandler(base float64, rnd *rand.Rand, sleep func(time.Duration)) http.Handler {
	var mu sync.Mutex
	uniform := func(lo, hi float64) float64 {
		mu.Lock()
		defer mu.Unlock()
		return lo + rnd.Float64()*(hi-lo)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/bid", func(rw http.ResponseWriter, r *http.Request) {
		w, err := strconv.Atoi(r.URL.Query().Get("w"))
		if err != nil || w < 0 {
			http.Error(rw, "invalid w", http.StatusBadRequest)
			return
		}
		var keys []string
		if k := r.URL.Query().Get("keys"); k != "" {
			keys = strings.Split(k, ",")
		}

		latencyMs := uniform(5, 30)
		if r.Header.Get("X-Bidder-Slow") == "true" && hostname(r.Host) == "bidder-astro" {
			latencyMs = uniform(80, 250)
		}
		sleep(time.Duration(latencyMs * float64(time.Millisecond)))

		bid := bidAmount(base, factorFor(r.Host, keys), w, uniform(0.8, 1.2))
		rw.Header().Set("Content-Type", "text/plain")
		fmt.Fprintf(rw, "%.6f", bid)
	})
	return mux
}

func main() {
	port := os.Getenv("BIDDER_PORT")
	if port == "" {
		port = "8080"
	}
	h := newHandler(baseBid, rand.New(rand.NewSource(time.Now().UnixNano())), time.Sleep)
	log.Fatal(http.ListenAndServe(":"+port, h))
}
