"""Operational boundary; independent of the frozen V8/V10 research machinery."""
# Preserve the current research restriction until independent live monitoring
# is explicitly authorized. Implementation/testing alone does not release it.
# No CLI or HTTP option bypasses this boundary.
LIVE_TECHNICAL_FEED_ALLOWED = False
LIVE_BOUNDARY_MESSAGE = (
    "Live BTC/ETH monitoring is blocked by the current V8/V10 data restriction. "
    "Offline fixture mode remains available."
)
