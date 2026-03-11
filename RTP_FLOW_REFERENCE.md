# RTP Flow Reference

**3-Phase Bidirectional G.711 PCMU over SBC — Optimised for 40K BHCC**

> Living document. Update placeholder values once SBC/CM traces are correlated.

---

## Table of Contents

1. [Overview](#overview)
2. [Codec-to-PPS Relationship](#codec-to-pps-relationship)
3. [Pre-Phase](#pre-phase)
4. [RTP Sockets Allocated](#rtp-sockets-allocated)
5. [SDP-Negotiated Media Endpoints](#sdp-negotiated-media-endpoints)
6. [3-Phase RTP Pattern](#3-phase-rtp-pattern)
7. [Scaling Math — BHCC to Per-VM Metrics](#scaling-math)
8. [Correlated Call Timeline](#correlated-call-timeline)
9. [Talk-Path Verification](#talk-path-verification)
10. [Final Metrics](#final-metrics)
11. [VM Host Requirements](#vm-host-requirements)
12. [Code Changes Summary](#code-changes-summary)

---

## Overview

End-to-end SIP + RTP load testing against a Session Border Controller (SBC).
Both UAC and UAS allocate real OS UDP sockets, advertise them in SDP, and
exchange RTP bidirectionally through the SBC media relay.  A 3-phase heartbeat
pattern (BURST → KEEPALIVE → BURST) replaces continuous 50 pps streaming,
reducing per-VM bandwidth by ~97% while fully verifying the media plane.

```
UAC (ext 4001000)            SBC / Kamailio               UAS (ext 4001001)
        |                          |                              |
        |---- REGISTER ----------->|                              |
        |<--- 200 OK -------------|                              |
        |                          |<---- REGISTER ---------------|
        |                          |---- 200 OK ----------------->|
        |                          |                              |
        |---- INVITE (SDP offer)-->|---- INVITE ----------------->|
        |<--- 100 Trying ---------|<--- 100 Trying ---------------|
        |<--- 180 Ringing (rel) --|<--- 180 Ringing (rel) --------|
        |---- PRACK -------------->|---- PRACK ------------------>|
        |<--- 200 PRACK ----------|<--- 200 PRACK ----------------|
        |<--- 200 OK (SDP ans) ---|<--- 200 OK (SDP answer) ------|
        |---- ACK ---------------->|---- ACK -------------------->|
        |                          |                              |
        |==== RTP BURST_START ====>|==== relay ==================>|
        |<==== RTP BURST_START ====|<==== relay ==================|
        |.... RTP KEEPALIVE .......| (both directions) ...........|
        |==== RTP BURST_END ======>|==== relay ==================>|
        |<==== RTP BURST_END ======|<==== relay ==================|
        |                          |                              |
        |---- BYE ---------------->|---- BYE -------------------->|
        |<--- 200 BYE ------------|<--- 200 BYE -----------------|
```

---

## Codec-to-PPS Relationship

```
G.711 MU-law (PCMU, PT=0)
  Sample rate     = 8,000 Hz
  ptime           = 20 ms
  Samples/packet  = 8,000 x 0.020       = 160
  Bytes/sample    = 1  (G.711 = 8-bit)
  Payload         = 160 bytes
  RTP header      = 12 bytes
  Packet size     = 172 bytes
  Full-rate PPS   = 1,000 / 20          = 50 pps
  Silence payload = 0x7F x 160  (MU-law positive zero)
```

| Parameter | Value |
|-----------|-------|
| Codec | G.711 MU-law (PCMU, PT=0) |
| Sample rate | 8,000 Hz |
| Frames per packet | 2 |
| ptime | 20 ms |
| Full-rate PPS | 50 pps |
| Payload | 160 bytes (`0x7F` silence) |
| Total packet | 172 bytes |
| Silence suppression | Off (CM config) |
| SDP codec list | `m=audio <port> RTP/AVP 0 8 18 101` |

> `rtp_burst_pps = 50` is the natural rate derived from ptime.
> Keepalive at 1 pkt/5 s = 0.2 pps — far below codec rate, sufficient for SBC.

### Packet Construction

Each RTP packet is rebuilt per iteration via `_pack_rtp(seq, ts, ssrc)`.
The 160-byte silence payload (`_PCMU_SILENCE`) is a module-level constant — only
the 12-byte header is freshly packed each time.

**Why rebuild:** `seq` and `ts` must increment per packet. The SBC validates
sequence/timestamp continuity and will drop duplicates or flag reordering.

| Aspect | Detail |
|--------|--------|
| Per-packet cost | One `struct.pack` (12 bytes) + reference to constant payload |
| Memory | No per-packet allocation for payload; header is ~12 bytes/cycle |
| At scale (2K calls) | 3,000 pps steady-state -> 3,000 x 12 B = 36 KB/s of header packing |
| Tradeoff | Correctness (unique seq/ts per packet) over reuse; cost is negligible |

---

## Pre-Phase

Both agents complete registration/subscription before calls fire.

| Step | Message | Direction | Result |
|------|---------|-----------|--------|
| 1 | `REGISTER` (Expires: 3600) | -> SBC | `200 OK` |
| 2 | `SUBSCRIBE` (Event: dialog) | -> SBC | `200 OK` + `NOTIFY` |
| 3 | `NOTIFY` ACK | -> SBC | -- |
| -- | **Pre-phase complete** | -- | **All green** |

> For N UAC + N UAS, each extension independently completes its own cycle.
> All extensions must be green before calls are fired.

---

## RTP Sockets Allocated

Each call leg allocates an OS-assigned ephemeral UDP port **before** SDP is built.
If allocation fails, the call continues with port 9 (discard) in SDP.

| Side | Extension | Bind IP | Port | Role |
|------|-----------|---------|------|------|
| UAC | 4001000 | `10.x.x.x` | OS-assigned | `RtpEndpoint` (send + receive) |
| UAS | 4001001 | `10.x.x.x` | OS-assigned | `RtpEndpoint` (send + receive) |

---

## SDP-Negotiated Media Endpoints

### SDP Offer (UAC -> SBC, inside INVITE)

```
v=0
o=- <session-id> <version> IN IP4 10.x.x.x
s=-
c=IN IP4 10.x.x.x
t=0 0
m=audio <UAC-port> RTP/AVP 0 8 18 101
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:18 G729/8000
a=rtpmap:101 telephone-event/8000
a=fmtp:101 0-15
a=ptime:20
a=sendrecv
```

### SDP Answer (SBC -> UAC, inside 200 OK)

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

### Negotiated Endpoints

| Field | UAC (offer) | SBC relay (200 OK) | UAS (answer) |
|-------|-------------|---------------------|--------------|
| IP | `10.x.x.x` | `<SBC-media-IP>` | `10.x.x.x` |
| Port | `<UAC-port>` | `<SBC-media-port>` | `<UAS-port>` |
| Codec | PCMU/8000 | PCMU/8000 | PCMU/8000 |
| ptime | 20 ms | 20 ms | 20 ms |

> **SBC relay confirmed** when packets sent to `<SBC-media-IP>:<SBC-media-port>`
> arrive at the far-end port. Update with actual values from SBC trace.

---

## 3-Phase RTP Pattern

### Configurable Parameters

| Parameter | Default | ENV VAR | Description |
|-----------|---------|---------|-------------|
| `rtp_burst_seconds` | `2` | `RTP_BURST_SECONDS` | Duration of start/end burst phases |
| `rtp_burst_pps` | `50` | `RTP_BURST_PPS` | Packet rate during bursts (= 1000/ptime) |
| `rtp_keepalive_interval` | `5` | `RTP_KEEPALIVE_INTERVAL` | Seconds between keepalive packets |

### Per-Call Pattern (hold_time = 180 s, defaults)

```
  |-- BURST_START --|------------ KEEPALIVE -------------|-- BURST_END --|
  |  50 pps x 2s    |  1 pkt / 5s x 176s                 |  50 pps x 2s  |
  |  100 pkts       |  35 pkts                            |  100 pkts     |
  <-- ACK ----------------------- 180 s hold --------------------------BYE->

  Same pattern runs on BOTH UAC and UAS (bidirectional through SBC)
```

### Per-Call Packet Math

```
BURST_START  = rtp_burst_seconds x rtp_burst_pps   = 2 x 50   = 100 pkts
KEEPALIVE    = (hold - 2 x burst) / keepalive_int  = 176 / 5  =  35 pkts
BURST_END    = rtp_burst_seconds x rtp_burst_pps   = 2 x 50   = 100 pkts
                                                                --------
Per direction per call                                          235 pkts
Bytes per direction  = 235 x 172                              = 40,420 B  ~ 39.5 KB

Bidirectional (UAC sends + UAS sends):
  Packets/call = 235 x 2 = 470
  Bytes/call   = 470 x 172 = 80,840 B  ~ 79 KB
```

### Fallback Behaviour

| Condition | Behaviour |
|-----------|-----------|
| `remote_port == 0` or `== 9` | No packets sent; `asyncio.sleep(hold_time)` |
| `remote_ip` empty | No packets sent; `asyncio.sleep(hold_time)` |
| RTP socket alloc fails | SDP advertises port 9; call continues (signalling-only) |
| `sendto` error mid-stream | Loop breaks; sleeps remaining hold time |
| `CancelledError` | Loop exits cleanly; re-raises for task infrastructure |

---

## Scaling Math

### Step 1 — BHCC to CPS and Concurrent Calls

```
Target              = 40,000 BHCC
Hold time           = 180 s (3 minutes)
Total CPS required  = 40,000 / 3,600 = 11.11 CPS
Concurrent calls    = 11.11 x 180    = 2,000
```

### Step 2 — VM Distribution

**6 CPS scenario (2 UAC VMs + 2 UAS VMs):**

```
CPS per UAC VM        = 6
Concurrent per VM     = 6 x 180 = 1,080
UAC VMs needed        = ceil(11.11 / 6) = 2
Total concurrent      = 2 x 1,080 = 2,160  (8% headroom over 2,000)
UAS mirrors: 2 VMs, each handling 1,080 concurrent.
```

**3 CPS scenario (4 UAC VMs + 4 UAS VMs):**

```
CPS per UAC VM        = 3
Concurrent per VM     = 3 x 180 = 540
UAC VMs needed        = ceil(11.11 / 3) = 4
Total concurrent      = 4 x 540 = 2,160  (same headroom)
UAS mirrors: 4 VMs, each handling 540 concurrent.
```

### Step 3 — Steady-State Phase Distribution per VM

At any instant, calls are distributed across phases:

| | 6 CPS (1,080 concurrent) | 3 CPS (540 concurrent) |
|--|--------------------------|------------------------|
| Calls in BURST_START | 6 x 2 = 12 | 3 x 2 = 6 |
| Calls in BURST_END | 6 x 2 = 12 | 3 x 2 = 6 |
| Calls in KEEPALIVE | 1,080 - 24 = 1,056 | 540 - 12 = 528 |

### Step 4 — Per-VM PPS and Bandwidth

**6 CPS (1,080 concurrent):**

```
BURST pps     = 24 calls x 50 pps     = 1,200.0
KEEPALIVE pps = 1,056 calls x 0.2 pps =   211.2
                                        --------
Send pps (one direction)               = 1,411.2
Bandwidth (send) = 1,411.2 x 172      = 237 KB/s  ~ 1.9 Mbps
Bidirectional    = 1.9 x 2            = 3.8 Mbps per VM
```

**3 CPS (540 concurrent):**

```
BURST pps     = 12 calls x 50 pps   = 600.0
KEEPALIVE pps = 528 calls x 0.2 pps = 105.6
                                      ------
Send pps (one direction)             = 705.6
Bandwidth (send) = 705.6 x 172      = 118 KB/s  ~ 0.97 Mbps
Bidirectional    = 0.97 x 2         = 1.94 Mbps per VM
```

### Step 5 — Per-VM Summary

| Metric | 6 CPS / VM | 3 CPS / VM |
|--------|-----------|-----------|
| Concurrent calls | 1,080 | 540 |
| Steady-state pps (bidir) | 2,822 | 1,412 |
| Steady-state bandwidth | 3.8 Mbps | 1.94 Mbps |
| UDP sockets | 1,080 | 540 |
| Packets/call (bidir) | 470 | 470 |
| Bytes/call (bidir) | 79 KB | 79 KB |

### Step 6 — Aggregated 40K BHCC

| Metric | 6 CPS (2+2 VMs) | 3 CPS (4+4 VMs) |
|--------|-----------------|-----------------|
| Total VMs | 4 | 8 |
| Total concurrent | 2,160 | 2,160 |
| Total pps (all VMs) | **5,644** | **5,648** |
| Total bandwidth | **7.6 Mbps** | **7.8 Mbps** |
| Packets/hour (40K calls) | **18.8 M** | **18.8 M** |
| Bytes/hour | **3.1 GB** | **3.1 GB** |

### Parameter Tuning: 3 CPS vs 6 CPS

| Parameter | 6 CPS (tighter VM) | 3 CPS (more headroom) | Rationale |
|-----------|--------------------|-----------------------|-----------|
| `rtp_burst_seconds` | **2** | **3** | Fewer concurrent bursts overlap at 3 CPS |
| `rtp_burst_pps` | **50** | **50** | Always match ptime (20 ms -> 50 pps) |
| `rtp_keepalive_interval` | **5** | **10** | 540 concurrent is lighter; 10 s < SBC 30 s timer |

| Config | Pkts/call/dir | Steady PPS/VM (send) | VM BW (bidir) |
|--------|--------------|---------------------|---------------|
| 6 CPS: burst=2, keepalive=5 | 235 | 1,411 | 3.8 Mbps |
| 6 CPS: burst=1, keepalive=5 | 185 | 1,161 | 3.2 Mbps |
| 3 CPS: burst=3, keepalive=10 | 168 | 630 | 1.7 Mbps |
| 3 CPS: burst=2, keepalive=10 | 118 | 480 | 1.3 Mbps |

---

## Correlated Call Timeline

Sample single-call (replace timestamps with actual log values).

| Wall Clock | Source | Event | Notes |
|------------|--------|-------|-------|
| 14:56:20.000 | UAS | Pre-phase complete | REGISTER + SUBSCRIBE green |
| 14:56:21.000 | UAC | Pre-phase complete | REGISTER + SUBSCRIBE green |
| 14:56:21.220 | UAC | `RtpEndpoint` bound | UDP socket ready |
| 14:56:21.221 | UAC | `INVITE_SENT` | SDP offer with UAC port |
| 14:56:21.225 | UAS | `UAS_INVITE_RCVD` | -- |
| 14:56:21.226 | UAS | `RtpEndpoint` bound | UDP socket ready |
| 14:56:21.230 | UAC | `100_TRYING` | -- |
| 14:56:21.350 | UAC | `RINGING` (180) | PDD ~ 185 ms |
| 14:56:21.355 | UAC | `PRACK_SENT` | -- |
| 14:56:21.360 | UAS | `UAS_PRACK_RCVD` | -- |
| 14:56:21.365 | UAS | `UAS_200_SENT` | SDP answer with UAS port |
| 14:56:21.370 | UAC | `200_PRACK` | -- |
| 14:56:21.405 | UAC | `200_INVITE` | SDP parsed -> SBC relay addr |
| 14:56:21.410 | UAC | `ACK_SENT` | -- |
| 14:56:21.415 | UAS | `UAS_ACK_RCVD` | -- |
| 14:56:21.416 | Both | RTP BURST_START | 50 pps x 2 s, bidirectional |
| 14:56:23.416 | Both | RTP KEEPALIVE | 1 pkt / 5 s, bidirectional |
| 14:59:19.416 | Both | RTP BURST_END | 50 pps x 2 s, bidirectional |
| 14:59:21.420 | UAC | `BYE_SENT` | -- |
| 14:59:21.425 | UAS | `UAS_BYE_RCVD` | -- |
| 14:59:21.430 | UAC | `200_BYE` | -- |
| 14:59:21.435 | UAC | `MEDIA_VERIFIED` | rx > 0 both directions |
| 14:59:21.440 | UAS | `MEDIA_VERIFIED` | rx > 0 both directions |
| 14:59:21.445 | Both | `CALL_COMPLETE` | -- |

---

## Talk-Path Verification

### Metrics Collected per Call Side

| Field | Type | Source |
|-------|------|--------|
| `rtp_tx_pkts` | int | Sender loop counter |
| `rtp_rx_pkts` | int | `_CountingProtocol.packets_received` |
| `rtp_first_rx_ms` | float | Monotonic ms of first datagram |
| `rtp_last_rx_ms` | float | Monotonic ms of last datagram |

### Decision Logic and Events

| Condition | Event | Verdict |
|-----------|-------|---------|
| `rtp_rx_pkts > 0` on **both** sides | **`MEDIA_VERIFIED`** | Bidirectional talk path confirmed |
| `rtp_rx_pkts == 0` on **either** side | **`MEDIA_FAILED`** | SBC relay broken in one/both directions |
| `rx > 0` but `last_rx - first_rx < hold_time * 0.5` | **`MEDIA_PARTIAL`** | Media interrupted mid-call |

### Sample Log Output

```
CALL_EVENT {"call_id":"369","ext":"4001000","event":"MEDIA_VERIFIED",
  "rtp_tx_pkts":235,"rtp_rx_pkts":228,"direction":"uac"}

CALL_EVENT {"call_id":"369","ext":"4001001","event":"MEDIA_VERIFIED",
  "rtp_tx_pkts":235,"rtp_rx_pkts":231,"direction":"uas"}
```

---

## Final Metrics

### Per-Call Metrics (hold_time = 180 s)

| Metric | Value |
|--------|-------|
| RTP packets sent (per direction) | 235 |
| RTP packets sent (bidirectional) | 470 |
| Bytes per call | 79 KB |
| Media event | `MEDIA_VERIFIED` / `MEDIA_FAILED` / `MEDIA_PARTIAL` |

### Process / Registration Cleanup

| Step | Action |
|------|--------|
| UAC | `max_calls` drain -> engine stop -> process exits |
| UAS | `SIGTERM` -> explicit `REGISTER (Expires: 0)` |
| Verify | `ps aux \| grep python` -> no stale processes |

---

## VM Host Requirements

### Resource Calculations

```
UDP sockets/VM:  6 CPS -> 1,080 | 3 CPS -> 540
File descriptors: RTP + SIP TCP + misc
  6 CPS -> 1,080 + 1,100 + 50 ~ 2,230
  3 CPS ->   540 +   550 + 50 ~ 1,140

Memory:
  Kernel UDP buf   ~ 4 KB/sock  -> 1,080 x 4 = 4.3 MB
  asyncio overhead ~ 2 KB/sock  -> 1,080 x 2 = 2.2 MB
  Dialog objects   ~ 3 KB/call  -> 1,080 x 3 = 3.2 MB
  Python base + libs            ~ 150 MB
  Total (6 CPS)                 ~ 300 MB peak

CPU:
  Timer wakeups/sec (6 CPS) ~ 3,400  (RTP + SIP)
  Timer wakeups/sec (3 CPS) ~ 1,700
  Single asyncio loop -> needs one fast core

Disk (logs):
  ~500 B/event x 12 events/call x 20K calls/hr/VM ~ 120 MB/hr
```

### VM Spec Table

| Resource | 3 CPS (540 concurrent) | 6 CPS (1,080 concurrent) |
|----------|----------------------|-------------------------|
| **vCPU** | 2 min, 4 recommended | 4 min, 8 recommended |
| **RAM** | 512 MB min, 1 GB rec | 1 GB min, 2 GB rec |
| **Disk** | 10 GB | 20 GB |
| **NIC** | 1 Gbps (1.94 Mbps used) | 1 Gbps (3.8 Mbps used) |
| **OS** | Ubuntu 22.04+ / Debian 12+ | same |

### Linux ulimits and sysctl Settings

| Setting | 3 CPS | 6 CPS | How to set |
|---------|-------|-------|------------|
| `ulimit -n` (open files) | 4096 | 8192 | `/etc/security/limits.conf`: `* soft nofile 8192` |
| `net.core.rmem_max` | 2097152 | 4194304 | `sysctl -w net.core.rmem_max=4194304` |
| `net.core.wmem_max` | 2097152 | 4194304 | `sysctl -w net.core.wmem_max=4194304` |
| `net.core.rmem_default` | 262144 | 262144 | `sysctl -w net.core.rmem_default=262144` |
| `net.ipv4.ip_local_port_range` | 10000 65535 | 10000 65535 | `sysctl -w net.ipv4.ip_local_port_range="10000 65535"` |
| `net.core.netdev_max_backlog` | 2000 | 5000 | `sysctl -w net.core.netdev_max_backlog=5000` |
| `fs.file-max` | default | 100000 | `sysctl -w fs.file-max=100000` |

> **Persist:** Add to `/etc/sysctl.d/99-rtp-tool.conf` and run `sysctl --system`.

---

## Code Changes Summary

### `callflow_tool/traffic/rtp_stream.py` — refactored

| Component | Change |
|-----------|--------|
| `_NullProtocol` -> `_CountingProtocol` | Adds `packets_received`, `first_recv_ts`, `last_recv_ts` (int increment per dgram) |
| `RtpStream` + `RtpAbsorber` -> `RtpEndpoint` | Unified class: one UDP socket, bidirectional send+receive |
| `RtpEndpoint.run()` | 3-phase send loop (BURST_START -> KEEPALIVE -> BURST_END) with configurable params |
| `RtpEndpoint.stats` | Returns `(tx_pkts, rx_pkts, first_rx_ms, last_rx_ms)` |

### `callflow_tool/traffic/config.py` — new fields

| Field | Default | Description |
|-------|---------|-------------|
| `rtp_burst_seconds` | 2 | Burst phase duration |
| `rtp_burst_pps` | 50 | Burst packet rate (= 1000/ptime) |
| `rtp_keepalive_interval` | 5 | Seconds between keepalive packets |

### `callflow_tool/traffic/call_engine.py` — updated

| Where | Change |
|-------|--------|
| `CallResult` | Added `rtp_tx_pkts`, `rtp_rx_pkts`, `media_verified` fields |
| `_execute_call()` (UAC) | Uses `RtpEndpoint`; logs `MEDIA_VERIFIED`/`MEDIA_FAILED` after hold |
| `_handle_call()` (UAS) | Uses `RtpEndpoint` as sender+receiver; logs media events after BYE |

### `callflow_tool/traffic/extension_agent.py` — unchanged

Existing `rtp_port` plumbing in `_build_sdp`, `send_invite`, `send_200_invite`,
`parse_200_invite`, `handle_incoming_invite` is reused as-is.

---

*Last updated: 2026-03-10*
