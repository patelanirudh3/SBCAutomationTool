# RTP Flow Reference

**Phase 1 — G.711 PCMU Silence Streaming over SBC**

> This document is a living reference. Update the tables and timelines below after each test run once SBC/CM traces are correlated.

---

## Table of Contents

1. [Overview](#overview)
2. [Pre-Phase](#pre-phase)
3. [RTP Sockets Allocated](#rtp-sockets-allocated)
4. [SDP-Negotiated Media Endpoints (SBC Relay Confirmed)](#sdp-negotiated-media-endpoints-sbc-relay-confirmed)
5. [Correlated Call Timeline](#correlated-call-timeline)
6. [RTP Stream](#rtp-stream)
7. [Final Metrics](#final-metrics)
8. [Code Changes Summary](#code-changes-summary)

---

## Overview

The tool performs end-to-end SIP + RTP load testing against a Session Border Controller (SBC).
Each call leg allocates a real OS UDP socket before SIP negotiation so the port can be
advertised in the SDP offer/answer.  After the call is established (ACK received), the UAC
streams G.711 MU-law silence to the SBC's media relay address for `hold_time_seconds`, then
tears down with BYE.  The UAS side binds a real UDP port and silently discards all arriving
RTP datagrams (Phase 1 minimal).

```
UAC (ext 4001000)            SBC / Kamailio               UAS (ext 4001001)
        │                          │                              │
        │──── REGISTER ───────────>│                              │
        │<─── 200 OK ─────────────│                              │
        │                          │<──── REGISTER ───────────────│
        │                          │──── 200 OK ─────────────────>│
        │                          │                              │
        │──── INVITE (SDP offer)──>│──── INVITE ─────────────────>│
        │<─── 100 Trying ─────────│<─── 100 Trying ──────────────│
        │<─── 180 Ringing (rel) ──│<─── 180 Ringing (rel) ───────│
        │──── PRACK ──────────────>│──── PRACK ──────────────────>│
        │<─── 200 PRACK ──────────│<─── 200 PRACK ───────────────│
        │<─── 200 OK (SDP answr)──│<─── 200 OK (SDP answer) ─────│
        │──── ACK ────────────────>│──── ACK ────────────────────>│
        │                          │                              │
        │════ RTP (50 pps, 10s) ==>│════ RTP relay =============>│
        │                          │                              │
        │──── BYE ────────────────>│──── BYE ────────────────────>│
        │<─── 200 BYE ────────────│<─── 200 BYE ─────────────────│
```

---

## Pre-Phase

Both agents complete registration and subscription before any call is attempted.
The table below shows a sample run (single UAC + single UAS extension).

### UAS Pre-Phase (ext 4001001)

| Step | Message | Direction | Result |
|------|---------|-----------|--------|
| 1 | `REGISTER` (Expires: 3600) | → SBC | `200 OK` |
| 2 | `SUBSCRIBE` (Event: dialog) | → SBC | `200 OK` + `NOTIFY` |
| 3 | `NOTIFY` ACK | → SBC | — |
| — | **Pre-phase complete** | — | **All green** |

### UAC Pre-Phase (ext 4001000)

| Step | Message | Direction | Result |
|------|---------|-----------|--------|
| 1 | `REGISTER` (Expires: 3600) | → SBC | `200 OK` |
| 2 | `SUBSCRIBE` (Event: dialog) | → SBC | `200 OK` + `NOTIFY` |
| 3 | `NOTIFY` ACK | → SBC | — |
| — | **Pre-phase complete** | — | **All green** |

> **N-extension note:** For N UAC + N UAS, each extension independently completes its own
> REGISTER/SUBSCRIBE cycle. All extensions must be green before calls are fired.

---

## RTP Sockets Allocated

Each call leg allocates an OS-assigned ephemeral UDP port **before** SDP is built.
If socket allocation fails the call continues with port 9 (discard) in SDP so
signalling tests are never blocked.

### Sample Run — 1 UAC + 1 UAS call

| Side | Extension | Bind IP | Allocated UDP Port | Role |
|------|-----------|---------|-------------------|------|
| UAC | 4001000 | `10.x.x.x` | `54321` *(e.g.)* | RTP sender (`RtpStream`) |
| UAS | 4001001 | `10.x.x.x` | `54322` *(e.g.)* | RTP absorber (`RtpAbsorber`) |

> Actual ports are OS-ephemeral and vary per run. Check the `DEBUG` log lines:
> ```
> RtpStream: bound 10.x.x.x:54321
> RtpAbsorber: bound 10.x.x.x:54322
> ```

### Codec Parameters (CM Codec Set — confirmed)

| Parameter | Value |
|-----------|-------|
| Codec | G.711 MU-law (PCMU, PT=0) |
| Sample rate | 8 000 Hz |
| Frames per packet | 2 |
| Packet time (ptime) | 20 ms |
| Packets per second | 50 pps |
| Payload size | 160 bytes (silence: `0x7F × 160`) |
| Total packet size | 172 bytes (12-byte RTP header + 160-byte payload) |
| Silence suppression | Off (matches CM config) |
| SDP codec list | `m=audio <port> RTP/AVP 0 8 18 101` |

---

## SDP-Negotiated Media Endpoints (SBC Relay Confirmed)

After SDP offer/answer exchange the UAC reads the `c=` and `m=audio` lines from the
`200 OK` to discover where the SBC wants to receive media.  The UAS reads the same fields
from the inbound INVITE to learn where to expect media from.

### SDP Offer (UAC → SBC, inside INVITE)

```
v=0
o=- <session-id> <version> IN IP4 10.x.x.x
s=-
c=IN IP4 10.x.x.x
t=0 0
m=audio 54321 RTP/AVP 0 8 18 101
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:18 G729/8000
a=rtpmap:101 telephone-event/8000
a=fmtp:101 0-15
a=ptime:20
a=sendrecv
```

### SDP Answer (SBC → UAC, inside 200 OK)

```
v=0
o=- <session-id> <version> IN IP4 <SBC-media-IP>
s=-
c=IN IP4 <SBC-media-IP>
t=0 0
m=audio <SBC-media-port> RTP/AVP 0
a=rtpmap:0 PCMU/8000
a=ptime:20
a=sendrecv
```

> `<SBC-media-IP>` and `<SBC-media-port>` are the SBC's media relay address.
> These are extracted by `_parse_sdp_media()` in `extension_agent.py` and stored in
> `dialog.rtp_remote_ip` / `dialog.rtp_remote_port`.  Update with actual values
> from SBC trace once available.

### Negotiated Endpoints Table

| Field | UAC (offer) | SBC relay (from 200 OK) | UAS (answer in 200 OK) |
|-------|-------------|------------------------|------------------------|
| IP | `10.x.x.x` | `<SBC-media-IP>` | `10.x.x.x` |
| Port | `54321` | `<SBC-media-port>` | `54322` |
| Codec | PCMU/8000 | PCMU/8000 | PCMU/8000 |
| ptime | 20 ms | 20 ms | 20 ms |

> **SBC relay confirmed** when RTP packets sent to `<SBC-media-IP>:<SBC-media-port>`
> arrive at the UAS absorber port.  Verify via Wireshark / SBC media trace.

---

## Correlated Call Timeline

Sample single-call run. Timestamps are wall-clock (log timestamps).
`call_id` and extensions are illustrative; replace with actual values from logs.

| Wall Clock | Log Source | Event | Notes |
|------------|------------|-------|-------|
| 14:56:20.000 | UAS | Pre-phase started | REGISTER + SUBSCRIBE |
| 14:56:20.100 | UAS | `200 OK` REGISTER | ext 4001001 registered |
| 14:56:20.200 | UAS | `200 OK` SUBSCRIBE | event:dialog |
| 14:56:20.210 | UAS | Pre-phase complete | Listening for INVITEs |
| 14:56:21.000 | UAC | Pre-phase started | REGISTER + SUBSCRIBE |
| 14:56:21.100 | UAC | `200 OK` REGISTER | ext 4001000 registered |
| 14:56:21.200 | UAC | `200 OK` SUBSCRIBE | event:dialog |
| 14:56:21.210 | UAC | Pre-phase complete | — |
| 14:56:21.220 | UAC | `RtpStream` bound `:54321` | UDP socket ready |
| 14:56:21.221 | UAC | `INVITE_SENT` | SDP offer with port 54321 |
| 14:56:21.225 | UAS | `UAS_INVITE_RCVD` | — |
| 14:56:21.226 | UAS | `RtpAbsorber` bound `:54322` | UDP socket ready |
| 14:56:21.230 | UAC | `100_TRYING` | — |
| 14:56:21.350 | UAC | `RINGING` (180) | PDD = ~185 ms |
| 14:56:21.355 | UAC | `PRACK_SENT` | reliable provisional |
| 14:56:21.360 | UAS | `UAS_PRACK_RCVD` | — |
| 14:56:21.365 | UAS | `UAS_200_SENT` | SDP answer with port 54322 |
| 14:56:21.370 | UAC | `200_PRACK` | — |
| 14:56:21.405 | UAC | `200_INVITE` | SDP answer parsed → SBC relay addr |
| 14:56:21.410 | UAC | `ACK_SENT` | call established on UAC side |
| 14:56:21.415 | UAS | `UAS_ACK_RCVD` | RTP absorber task started |
| 14:56:21.416 | UAC | RTP stream started | 50 pps → `<SBC-media-IP>:<port>` |
| 14:56:31.416 | UAC | RTP stream ended | 500 pkts / 10.0 s |
| 14:56:31.420 | UAC | `BYE_SENT` | — |
| 14:56:31.425 | UAS | `UAS_BYE_RCVD` | absorber task cancelled |
| 14:56:31.430 | UAC | `200_BYE` | — |
| 14:56:31.435 | UAC | `CALL_COMPLETE` | — |
| 14:56:31.440 | UAS | `UAS_CALL_COMPLETE` | — |

> **PDD** = time from `INVITE_SENT` to first `180 Ringing`.
> Replace placeholder timestamps with actual log values for each run.

---

## RTP Stream

### Packet Format — RFC 3550 RTP Header (12 bytes)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|V=2|P|X|  CC   |M|   PT = 0   |       Sequence Number          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                           Timestamp                            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                             SSRC                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                     Payload (160 × 0x7F)                       |
|                   G.711 MU-law silence ...                     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Field | Value | Notes |
|-------|-------|-------|
| V (version) | `2` | RFC 3550 |
| P (padding) | `0` | no padding |
| X (extension) | `0` | no header extension |
| CC (CSRC count) | `0` | no contributing sources |
| M (marker) | `0` | no marker |
| PT (payload type) | `0` | G.711 MU-law (PCMU), RFC 3551 |
| Sequence number | random start, +1/pkt | wraps at 65535 |
| Timestamp | random start, +160/pkt | 8 000 Hz clock |
| SSRC | random per call | per RFC 3550 §8 |
| Payload | `0x7F × 160` | MU-law positive zero (silence) |

### RTP Stream Statistics — Sample Run (hold_time = 10 s)

| Metric | Value |
|--------|-------|
| Duration | 10.0 s |
| Packets sent (UAC) | 500 |
| Packet rate | 50 pps |
| Packet size | 172 bytes (header + payload) |
| Total bytes sent | 86 000 bytes (~84 KB) |
| Timing method | Deadline-based pacing (drift-correcting) |
| Remote endpoint | `<SBC-media-IP>:<SBC-media-port>` (from SDP answer) |
| UAS absorber | `_NullProtocol` — all datagrams discarded, no RTCP |

### Fallback Behaviour

| Condition | Behaviour |
|-----------|-----------|
| `remote_port == 0` | No packets sent; `asyncio.sleep(hold_time)` |
| `remote_port == 9` | No packets sent; `asyncio.sleep(hold_time)` (RFC 4566 discard) |
| `remote_ip` empty | No packets sent; `asyncio.sleep(hold_time)` |
| RTP socket alloc fails | SDP advertises port 9; call continues (signalling-only) |
| `sendto` error mid-stream | Loop breaks; sleeps remaining hold time |
| `CancelledError` | Loop exits, exception re-raised cleanly |

---

## Final Metrics

### Call Metrics — Sample Run (1 call)

| Metric | Value |
|--------|-------|
| Calls attempted | 1 |
| Calls completed | 1 |
| Calls failed | 0 |
| ASR (Answer Seizure Ratio) | 100% |
| PDD (Post-Dial Delay) | ~185 ms |
| Hold time (ACK → BYE) | ~10 000 ms |
| Total call duration | ~10 250 ms |
| RTP packets sent (UAC) | 500 |
| RTP packet loss observed | 0 (pending SBC trace confirmation) |

### Process / Registration Cleanup

| Step | Action |
|------|--------|
| UAC completion | `max_calls` drain → engine stop → process exits cleanly |
| UAS teardown | `SIGTERM` → `os.kill(PID, SIGTERM)` |
| UAS de-registration | `REGISTER (Expires: 0)` sent explicitly after SIGTERM |
| Verification | `tasklist \| grep python` → no stale processes |

> **Important:** On Windows, `SIGTERM` does not allow Python's `atexit` / signal handler to
> run.  Always send an explicit `REGISTER (Expires: 0)` after killing the UAS process to
> ensure the SBC removes the registration.

---

## Code Changes Summary

Four files were modified or created to add RTP support.  All changes are additive and
backwards-compatible — if the RTP socket cannot be allocated the call continues with
port 9 in SDP, preserving all signalling tests.

### 1. `callflow_tool/traffic/rtp_stream.py` *(new file)*

Encapsulates all RTP media logic.

| Class / Function | Role |
|-----------------|------|
| `_pack_rtp(seq, ts, ssrc)` | Builds a 172-byte RFC 3550 RTP packet (PCMU silence) |
| `_NullProtocol` | `asyncio.DatagramProtocol` that silently discards all datagrams |
| `RtpStream.create(local_ip)` | Binds a UDP socket on an OS-assigned port; returns instance |
| `RtpStream.run(remote_ip, remote_port, duration)` | Sends 50 pps PCMU silence with deadline-based pacing |
| `RtpStream.close()` | Idempotently closes the UDP transport |
| `RtpAbsorber.create(local_ip)` | Same as above for the UAS receive socket |
| `RtpAbsorber.run()` | Keeps the absorber alive until externally cancelled |
| `RtpAbsorber.close()` | Idempotently closes the UDP transport |

### 2. `callflow_tool/traffic/extension_agent.py` *(modified)*

SDP construction and media-endpoint parsing.

| Change | Detail |
|--------|--------|
| `DialogState` — two new fields | `rtp_remote_ip: str` and `rtp_remote_port: int` store the far-end media address extracted from SDP |
| `_parse_sdp_media(sdp_body)` | New module-level helper; extracts `(ip, port)` from `c=IN IP4` and `m=audio` lines; handles CRLF/LF, trailing whitespace, port 0/9 edge cases |
| `_build_sdp(rtp_port=9)` | Accepts the allocated UDP port; inserts it into `m=audio`; adds `a=ptime:20` |
| `send_invite(callee, rtp_port=9)` | Passes `rtp_port` through to `_build_sdp` |
| `parse_200_invite(raw, dialog)` | Calls `_parse_sdp_media` on the SDP body; populates `dialog.rtp_remote_ip/port` |
| `send_200_invite(dialog, rtp_port=9)` | Passes `rtp_port` through to `_build_sdp` |
| `handle_incoming_invite(raw)` | Calls `_parse_sdp_media` on the INVITE SDP offer; populates `dialog.rtp_remote_ip/port` |

### 3. `callflow_tool/traffic/call_engine.py` — `_execute_call()` (UAC)

| Where | Change |
|-------|--------|
| Before INVITE | `rtp_stream = await RtpStream.create(agent._local_host)`; port passed to `send_invite(rtp_port=...)` |
| After ACK | `await rtp_stream.run(dialog.rtp_remote_ip, dialog.rtp_remote_port, hold_time_seconds)` replaces bare `asyncio.sleep` |
| `finally` block | `await rtp_stream.close()` — always runs, prevents socket leaks |

### 4. `callflow_tool/traffic/call_engine.py` — `_handle_call()` (UAS)

| Where | Change |
|-------|--------|
| Before 200 OK | `rtp_absorber = await RtpAbsorber.create(agent._local_host)`; port passed to `send_200_invite(rtp_port=...)` |
| After ACK received | `absorb_task = asyncio.create_task(rtp_absorber.run())` started |
| `finally` block | `absorb_task.cancel()` + `await rtp_absorber.close()` — always runs on BYE, timeout, or cancellation |

---

*Last updated: 2026-03-10 — awaiting SBC/CM trace correlation.*
