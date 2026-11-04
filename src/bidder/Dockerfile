# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0


FROM docker.io/library/golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS builder

WORKDIR /usr/src/app/

COPY ./src/bidder/go.mod go.mod
COPY ./src/bidder/main.go main.go

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags "-s -w" -o bidder main.go

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab

WORKDIR /usr/src/app/

COPY --from=builder /usr/src/app/bidder ./

ARG BIDDER_PORT=8080
EXPOSE ${BIDDER_PORT}
ENTRYPOINT [ "./bidder" ]
