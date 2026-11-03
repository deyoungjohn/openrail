# Indexer fixtures

Recorded-shape responses the API will read from the indexer after the hand-off
(S3, #41). The receipt fields match the `booked` event and the K8/pay-report
stored shapes; the statement envelope matches `GET /v1/statements`.

Routes use the `IndexerPort` interface, so replacing this fixture adapter with
the HTTP indexer is a port swap, not a route rewrite.
