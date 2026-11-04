// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"math"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestBidAmount(t *testing.T) {
	if got := bidAmount(0.0021, 1, 1, 1); math.Abs(got-0.001456) > 1e-6 {
		t.Errorf("w=1: got %f", got)
	}
	if got := bidAmount(0.0021, 1, 25, 1); math.Abs(got-0.006842) > 1e-6 {
		t.Errorf("w=25: got %f", got)
	}
	early := (bidAmount(0.0021, 1, 4, 1) - bidAmount(0.0021, 1, 1, 1)) / 3
	late := (bidAmount(0.0021, 1, 25, 1) - bidAmount(0.0021, 1, 10, 1)) / 15
	if early <= late {
		t.Errorf("expected diminishing returns, early=%f late=%f", early, late)
	}
}

func TestFactorFor(t *testing.T) {
	cases := []struct {
		host string
		keys []string
		want float64
	}{
		{"bidder-astro:8080", []string{"telescopes"}, 1.2},
		{"bidder-astro", []string{"books"}, 1.0},
		{"bidder-generic", nil, 0.8},
		{"localhost", nil, 1.0},
	}
	for _, c := range cases {
		if got := factorFor(c.host, c.keys); got != c.want {
			t.Errorf("factorFor(%q, %v) = %f, want %f", c.host, c.keys, got, c.want)
		}
	}
}

func serve(h http.Handler, host, target string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.Host = host
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func testHandler(sleep func(time.Duration)) http.Handler {
	return newHandler(0.0021, rand.New(rand.NewSource(1)), sleep)
}

func TestHandlerRejectsBadW(t *testing.T) {
	h := testHandler(func(time.Duration) {})
	for _, target := range []string{"/bid", "/bid?w=-1", "/bid?w=abc"} {
		if rec := serve(h, "bidder-astro", target, nil); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d", target, rec.Code)
		}
	}
}

func TestHandlerBids(t *testing.T) {
	h := testHandler(func(time.Duration) {})
	rec := serve(h, "bidder-astro", "/bid?w=10&keys=telescopes", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d", rec.Code)
	}
	got, err := strconv.ParseFloat(rec.Body.String(), 64)
	if err != nil {
		t.Fatal(err)
	}
	ref := bidAmount(0.0021, 1.2, 10, 1)
	if got < 0.8*ref || got > 1.2*ref {
		t.Errorf("bid %f outside [%f, %f]", got, 0.8*ref, 1.2*ref)
	}
}

func TestHandlerSlow(t *testing.T) {
	var slept time.Duration
	h := testHandler(func(d time.Duration) { slept = d })
	slow := map[string]string{"X-Bidder-Slow": "true"}

	serve(h, "bidder-astro", "/bid?w=10", slow)
	if slept < 80*time.Millisecond {
		t.Errorf("astro slept %v", slept)
	}
	serve(h, "bidder-optics", "/bid?w=10", slow)
	if slept > 30*time.Millisecond {
		t.Errorf("optics slept %v", slept)
	}
}
