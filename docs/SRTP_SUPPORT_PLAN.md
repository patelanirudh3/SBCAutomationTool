# Nexus Traffic Engine SRTP Support Plan

## Goal

Add optional SRTP media support controlled from the GUI Media section while keeping plain RTP as the default behavior.

Recommended target version:

```text
Nexus Traffic Engine 1.4 - SRTP SDES media support
```

Initial scope should focus on SDES-SRTP, not DTLS-SRTP.

## Current State

The current media stack is plain RTP:

- SDP advertises `RTP/AVP`
- RTP endpoint sends and receives unencrypted RTP packets
- SDP parser extracts only media IP and port
- No crypto attributes, SRTP key handling, replay window, auth tag, or SRTP protect/unprotect logic exists

Current SDP example:

```text
m=audio <port> RTP/AVP 0 8 101
```

## Recommended Initial Scope

Implement:

```text
SRTP using SDES a=crypto
AES_CM_128_HMAC_SHA1_80
```

Optional later support:

```text
AES_CM_128_HMAC_SHA1_32
DTLS-SRTP
```

## Why SDES First

SDES-SRTP is simpler and fits the existing SIP/SDP traffic-engine architecture.

DTLS-SRTP would require:

- DTLS handshake over the media socket
- certificates/fingerprints
- setup roles
- DTLS/RTP/RTCP packet demux
- additional state machines and failure handling

SDES-SRTP can be added by extending SDP and wrapping RTP packets with SRTP protection/unprotection.

## GUI Configuration

Add SRTP controls in:

```text
Config -> Media
```

Suggested controls:

```text
Media Security:
  RTP
  SRTP (SDES)

SRTP Crypto Suite:
  AES_CM_128_HMAC_SHA1_80
  AES_CM_128_HMAC_SHA1_32

SRTP Key Mode:
  Auto-generate per call
  Manual key
```

Recommended defaults:

```yaml
media_security: rtp
srtp_crypto_suite: AES_CM_128_HMAC_SHA1_80
srtp_key_mode: auto
```

## Backend Configuration

Suggested fields:

```go
MediaSecurity   string `yaml:"media_security" json:"media_security"` // "rtp" | "srtp_sdes"
SRTPCryptoSuite string `yaml:"srtp_crypto_suite" json:"srtp_crypto_suite"`
SRTPKeyMode     string `yaml:"srtp_key_mode" json:"srtp_key_mode"` // "auto" | "manual"
SRTPMasterKey   string `yaml:"srtp_master_key,omitempty" json:"srtp_master_key,omitempty"`
SRTPMasterSalt  string `yaml:"srtp_master_salt,omitempty" json:"srtp_master_salt,omitempty"`
```

Validation rules:

- `media_security` must be `rtp` or `srtp_sdes`
- SRTP is valid only when media is enabled
- crypto suite must be one of the supported values
- manual key/salt length must match the selected suite
- SRTP key material must not be printed in logs, reports, or GUI summaries

## SDP Changes

Plain RTP currently uses:

```text
m=audio <port> RTP/AVP 0 8 101
```

SRTP SDES should use:

```text
m=audio <port> RTP/SAVP 0 8 101
a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:<base64-key-salt>
```

If RTCP mux is enabled:

```text
a=rtcp-mux
```

Current function:

```go
func BuildSDP(localHost string, rtpPort int, rtcpMux bool) string
```

Suggested replacement:

```go
type SDPOptions struct {
    RTCPMux         bool
    MediaSecurity   string
    SRTPCryptoSuite string
    SRTPCryptoLine  string
}

func BuildSDP(localHost string, rtpPort int, opts SDPOptions) string
```

## SDP Parser Changes

Current `ParseSDPMedia()` returns only:

```go
ip string
port int
```

SRTP requires a richer parsed model:

```go
type SDPMediaInfo struct {
    IP              string
    Port            int
    Proto           string // RTP/AVP or RTP/SAVP
    CryptoSuite     string
    CryptoKeyParams string
}
```

Parser should extract:

- media protocol from `m=audio`
- media IP and port
- `a=crypto` tag
- crypto suite
- inline keying material

## SRTP Key Direction

This is the most important interop rule.

With SDES:

```text
Our offered key = peer uses it to encrypt RTP sent to us
Peer answered key = we use it to encrypt RTP sent to peer
```

In other words:

- The key we place in our SDP is our inbound/decrypt key.
- The peer key from remote SDP is our outbound/encrypt key.

Getting this reversed causes one-way or no-way media.

## RTP Endpoint Changes

Current endpoint sends:

```text
RTP header + payload
```

SRTP mode must do:

Outbound:

```text
RTP packet -> SRTP protect -> UDP send
```

Inbound:

```text
UDP receive -> SRTP unprotect -> RTP validation/stats
```

Use a library instead of implementing SRTP manually.

Recommended Go dependency:

```text
github.com/pion/srtp/v3
```

Suggested endpoint config:

```go
type SRTPSessionConfig struct {
    Enabled     bool
    CryptoSuite string
    LocalKey    []byte // our inbound/decrypt key advertised in local SDP
    LocalSalt   []byte
    RemoteKey   []byte // remote inbound key, used by us for outbound/encrypt
    RemoteSalt  []byte
}
```

## UAC Flow

UAC INVITE flow:

```text
1. Generate local SRTP key/salt.
2. Build SDP with:
   - RTP/SAVP
   - a=crypto with local key/salt
3. Send INVITE.
4. Receive 200 OK.
5. Parse remote SDP a=crypto.
6. Configure RTP endpoint:
   - outbound/encrypt key = remote SDP key
   - inbound/decrypt key = local SDP key
7. Start SRTP media.
```

If remote answer has no `a=crypto` while SRTP is required:

```text
Fail the call or mark media failed.
```

## UAS Flow

UAS INVITE flow:

```text
1. Receive INVITE.
2. Parse caller SRTP crypto.
3. Generate local SRTP key/salt.
4. Build 200 OK SDP with:
   - RTP/SAVP
   - a=crypto with local key/salt
5. Configure RTP endpoint:
   - inbound/decrypt key = caller SDP key
   - outbound/encrypt key = local SDP key
6. Start SRTP media.
```

If SRTP is required and INVITE does not contain usable crypto:

```text
Reject with 488 Not Acceptable Here
```

Optionally allow fallback only if a future config explicitly enables fallback.

## Metrics and Reporting

Add media security fields to metrics and reports:

```json
{
  "media_security": "srtp_sdes",
  "srtp_enabled": true,
  "srtp_crypto_suite": "AES_CM_128_HMAC_SHA1_80",
  "srtp_rx_auth_failures": 0,
  "srtp_replay_failures": 0,
  "srtp_decrypt_failures": 0
}
```

GUI Media/QoS panel should show:

```text
Media Security: SRTP (SDES)
Crypto Suite: AES_CM_128_HMAC_SHA1_80
SRTP auth/decrypt failures: 0
```

Never expose SRTP keys in:

- logs
- GUI
- final reports
- downloaded report JSON

## Testing Plan

### Unit Tests

SDP:

- Plain RTP SDP uses `RTP/AVP`
- SRTP SDP uses `RTP/SAVP`
- SRTP SDP contains valid `a=crypto`
- Parser extracts media protocol
- Parser extracts crypto suite and inline keying material
- Missing crypto in SRTP-required mode fails

SRTP:

- Protect/unprotect roundtrip succeeds with matching keys
- Wrong key causes auth/decrypt failure
- Replay/duplicate packet handling increments proper counters

### Integration Tests

- Local UAC/UAS SRTP call with generated SDES keys
- UAC SRTP INVITE -> UAS SRTP answer -> encrypted RTP both directions
- RTP stats still count packets after unprotect
- Jitter/loss metrics still work on decrypted RTP
- Final report shows SRTP mode

### Negative Tests

- SRTP required but remote SDP has `RTP/AVP`
- SRTP required but remote SDP lacks `a=crypto`
- Unsupported crypto suite
- Bad inline key material
- Auth/decrypt failure due to key mismatch

## Rollout Plan

### Phase 1: Config and SDP

- Add GUI controls
- Add backend config validation
- Add SDP build/parse support
- Do not encrypt media yet
- Use this to verify signaling interop

### Phase 2: SRTP Endpoint

- Add SRTP library
- Protect outbound RTP
- Unprotect inbound RTP
- Add SRTP error counters

### Phase 3: Reporting and Hardening

- Add SRTP metrics to live/final reports
- Update Media/QoS panel
- Add pcap guidance
- Add negative tests

## Open Questions

- Should fallback from SRTP to RTP ever be allowed?
- Which crypto suites are required by the target SBCs?
- Should manual SRTP keys be supported in the first release, or only auto-generated per call?
- Should SRTP be allowed with RTCP SR enabled, and if so, should RTCP also be protected as SRTCP?
- Should DTLS-SRTP be planned as a separate major feature after SDES-SRTP?

