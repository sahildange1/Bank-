# Filters

Global exception filter (consistent `{ error: { code, message, requestId } }`
envelope, no internal stack traces leaked to clients — architecture §14) is
implemented alongside the first real endpoints in Phase 4.
