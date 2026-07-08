# Nexus Traffic Engine Releases

## 1.1 - RFC Subscription Events

- Replaces the legacy subscription event list with the Avaya/RFC event set used by the traffic automation workflow.
- Requires matching NOTIFY confirmation before an event-package subscription is counted successful.
- Adds per-event subscription progress metrics for the GUI.
- Adds policy-driven subscription refresh and unsubscribe behavior.

## 1.0 - Traffic Automation Baseline

- SIP registration, subscription, call generation, media/RTP verification, final reports, and VM/process health telemetry.
- Strict SIP TCP Content-Length framing and structured SIP/SDP parsing.
- RTP coverage, keepalive, RFC3550 loss tracking, and media quality reporting.
