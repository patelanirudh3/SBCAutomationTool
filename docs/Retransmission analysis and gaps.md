# Retransmission analysis and gaps

## Executive summary

The traffic engine partially supports SIP retransmission logic, but it does not currently enforce RFC 3261 transaction retransmission behavior for every SIP request and response sent by the tool.

Implemented coverage is narrow:

- UAC `INVITE` has UDP-only Timer A retransmission and Timer B timeout support in `go/internal/engine/call_engine.go`.
- `INVITE` final failure responses are ACKed by the UAC.
- Non-INVITE flows have some RFC-shaped timeouts, mainly Timer F duration for `SUBSCRIBE`, but they do not retransmit requests.
- UAS-side responses are generally sent once. There is no generic server transaction cache that retransmits or replays prior responses when duplicate requests arrive.
- Methods such as `OPTIONS`, `INFO`, `UPDATE`, `MESSAGE`, and `REFER` are advertised in some `Allow` headers but are not implemented as traffic-generating flows.
- The existing `docs/INVITE_200OK_RETRANSMISSION_PLAN.md` correctly identifies missing `200 OK` retransmission and duplicate-ACK handling for `INVITE`, and that plan is still not implemented in the current code.

The main gap is architectural: SIP send behavior is implemented as per-method helpers calling `ExtensionAgent.Send(...)` directly. There is no shared transaction layer that all methods pass through.

## Relevant implementation map

### Core SIP send path

- `go/internal/agent/agent.go`
  - `ExtensionAgent.Send` serializes and sends one SIP message through the transport.
  - `SendInvite`, `SendPrack`, `SendAck`, `SendAckForFailure`, `SendCancel`, `SendBye`, `Send200Invite`, `SendInviteReject`, `HandlePrack`, `HandleBye`, `respond200ToNotify`, `respond200ToRequest`, and `respond481ToRequest` all eventually call `Send`.
  - There is no transaction object, retransmission scheduler, transaction key, or response cache attached to `Send`.

### UAC INVITE transaction

- `go/internal/engine/call_engine.go`
  - `startTimerA` implements RFC 3261 INVITE client Timer A for UDP only.
  - The call flow uses Timer B via `timer_b_seconds`.
  - Timer A stops when the first response arrives.
  - Timer A doubles the retransmit interval, but there is no explicit T2 cap.
  - `RetransmitInvite` resends the stored `INVITE` message and SDP.
  - Metrics count `invite_retransmits`.

This is the strongest RFC retransmission support in the tool, but it is scoped only to outbound `INVITE`.

### REGISTER

- `go/internal/agent/agent.go`
  - `Register`, `Reregister`, `Unregister`, and `FlushRegister` send REGISTER-family requests once per transaction attempt.
  - They wait for responses using `RegisterTimeout`, not `NonInviteTransactionTimeout`.
  - They do not implement Timer E retransmission for UDP non-INVITE client transactions.
  - Pre-phase retry in `go/internal/prephase/prephase.go` retries the whole registration attempt with backoff, but this is application-level retry, not RFC retransmission of the same client transaction.

### SUBSCRIBE / resubscribe / unsubscribe

- `go/internal/agent/agent.go`
  - `SubscribeEvent`, `resubscribeEvent`, and `unsubscribeEvent` send one `SUBSCRIBE` request and wait under `NonInviteTransactionTimeout`.
  - `NonInviteTransactionTimeout` is `64*T1`, matching Timer F duration, but there is no Timer E retransmission loop for UDP.
  - Auth retries and `423 Interval Too Brief` retries create new transactions, but do not retransmit the same transaction.
  - Incoming `NOTIFY` gets an automatic `200 OK`, but that response is not stored as a server transaction response for duplicate NOTIFY handling.

### PRACK

- `SendPrack` sends one PRACK.
- `Handle401Prack` / `Handle407Prack` retry with auth after challenge.
- Waits use the flat `sipTimeout` constant.
- Missing Timer E/Timer F behavior for UDP non-INVITE client transaction retransmission.
- UAS `HandlePrack` sends `200 OK` once; no response cache for duplicate PRACK.

### BYE

- `SendBye` sends one BYE and waits for `200_BYE` or `407_BYE`.
- `Handle407Bye` sends one authenticated BYE retry.
- Waits use the flat `sipTimeout` constant.
- Missing Timer E/Timer F behavior for UDP non-INVITE client transaction retransmission.
- UAS `HandleBye` sends one `200 OK` and removes the dialog.
- There is limited zombie-dialog handling: late BYE/CANCEL can get `200 OK` or `481`, but this is not a full server transaction cache and is limited to specific methods and dialog states.

### CANCEL

- `SendCancel` builds RFC-correct CANCEL fields from the original INVITE, but sends it once.
- There is no CANCEL Timer E/Timer F client transaction handling.
- There is no explicit wait for `200 OK` to CANCEL in the call engine; cleanup logic mainly sends CANCEL/BYE on timeout and then ends the call.

### OPTIONS / INFO / UPDATE / MESSAGE / REFER

- These methods are either listed in `Allow` headers or referenced in support code, but the Go traffic engine does not implement active traffic scenarios for them.
- Because all send paths currently bypass a shared transaction layer, adding any of these methods today would require method-specific retransmission work unless the architecture is changed first.

### ACK

- `SendAck` correctly keeps the ACK CSeq equal to the INVITE CSeq for `2xx`.
- `SendAckForFailure` handles ACK for non-2xx final responses to INVITE with original INVITE transaction fields.
- Missing: UAC does not continue listening for duplicate `200 OK` to INVITE and ACK each retransmitted `2xx` while the dialog remains active.
- Missing: No zombie/late duplicate `200 OK` ACK strategy after call completion.

### Responses

- UAS provisional responses (`100`, `180`) are sent once.
- UAS `200 OK` to `INVITE` is sent once.
- UAS `200 OK` to `PRACK`, `BYE`, and `NOTIFY` is sent once.
- UAS `488` or other INVITE rejection is sent once.
- No generic response retransmission for INVITE server non-2xx final responses using Timer G/H/I.
- No generic response cache for non-INVITE server transactions using Timer J behavior.
- No duplicate request matching by Via branch, CSeq, method, Call-ID, From tag, and To tag.

### Dispatch and queue behavior

- Incoming messages are routed by the agent dispatch loop to per-dialog queues and wildcard listeners.
- This fixes some back-to-back response races, but it is not transaction-stateful.
- Under high CPS, receive or dialog queue overflow can drop SIP events, which may look like retransmission failures or timeouts even when the peer sent the expected response.

## RFC behavior expected

The RFC 3261 transaction behavior needed for traffic testing should be transport-aware.

For unreliable transports such as UDP:

- `INVITE` client transaction:
  - Timer A retransmits INVITE starting at T1 and doubling.
  - Timer B terminates the transaction at 64*T1 by default.
  - ACK is generated for non-2xx final responses.

- Non-INVITE client transaction (`REGISTER`, `SUBSCRIBE`, `PRACK`, `BYE`, `CANCEL`, `OPTIONS`, `INFO`, `UPDATE`, etc.):
  - Timer E retransmits the same request.
  - Timer F bounds the transaction, normally 64*T1.
  - Timer K retains transaction state briefly after final response.

- `INVITE` server transaction:
  - Provisional responses are sent as needed.
  - Non-2xx final responses are retransmitted with Timer G until ACK or Timer H.
  - Timer I retains state after ACK for unreliable transport.

- Non-INVITE server transaction:
  - Final responses are cached.
  - Duplicate requests matching the same transaction receive the cached final response.
  - Timer J controls transaction state lifetime.

For reliable transports such as TCP/TLS:

- Request retransmission timers are normally disabled.
- Transaction state and duplicate response/request handling are still useful for correctness, diagnostics, and failover/overload behavior.
- `2xx` to `INVITE` remains special because ACK is a separate request and the UAC should ACK each matching `2xx` retransmission.

## Gap matrix

| Area | Current support | Gap |
| --- | --- | --- |
| UAC `INVITE` over UDP | Partial Timer A/B implemented | No duplicate `2xx` ACK loop after first ACK; no explicit T2 cap |
| UAC `INVITE` over TCP/TLS | Sends once, Timer A disabled | No duplicate `2xx` ACK handling |
| UAS `200 OK` to `INVITE` | Sends once | No retransmission until ACK / timeout |
| UAS non-2xx final to `INVITE` | Sends once | No Timer G/H/I retransmission and ACK-driven cleanup |
| `REGISTER` | App-level retries exist | No RFC Timer E/F transaction retransmission |
| `SUBSCRIBE` | Timer F-sized timeout exists | No Timer E retransmission |
| `PRACK` | Sends once, auth retry only | No Timer E/F retransmission |
| `BYE` | Sends once, auth retry only | No Timer E/F retransmission |
| `CANCEL` | Correct construction, sends once | No Timer E/F, no explicit 200-to-CANCEL handling |
| `NOTIFY` response | Auto `200 OK` | No cached response replay for duplicate NOTIFY |
| Any future method (`OPTIONS`, `INFO`, `UPDATE`, `MESSAGE`) | No shared machinery | Would need method-specific retransmission unless a generic layer is added |
| Server transaction state | Limited zombie dialog handling | No branch/CSeq/method transaction cache |
| GUI config | Exposes `t1_ms`, `timer_b_seconds` | Names imply only INVITE timers; no non-INVITE/server transaction controls or metrics |

## Why method-by-method fixes are risky

Adding retransmission separately inside `Register`, `SubscribeEvent`, `SendBye`, `SendPrack`, `SendCancel`, and every response helper would duplicate timer logic and create inconsistent behavior. It would also make future method additions easy to miss.

The safer long-term design is a shared SIP transaction layer below the method helpers and above the transport:

- `ClientTransaction.SendRequest(method, msg, body, options)`
- `ServerTransaction.SendResponse(req, resp, body, options)`
- Transaction keying by Via branch plus CSeq method, Call-ID, and tags as appropriate.
- Timer profiles for INVITE client, non-INVITE client, INVITE server, and non-INVITE server.
- Transport-aware retransmission: UDP retransmits; TCP/TLS usually stores state without request retransmit.
- Metrics for initial sends, retransmits, duplicate receives, cached response replays, timer expiries, and suppressed retransmits on reliable transport.

## Change risk

Risk level: high for a broad "all requests and all responses" change.

Primary risks:

- **Duplicate SIP messages under load:** incorrect stop conditions can amplify traffic during overload and make the traffic tester the source of failures.
- **Bad transaction matching:** loose matching can retransmit or ACK the wrong dialog; overly strict matching can fail to handle valid retransmissions.
- **Digest auth and CSeq regressions:** retransmission must resend the same transaction bytes for a retransmit, while auth retries must create a new transaction with a new Via branch and CSeq where required.
- **Metrics double-counting:** retransmitted requests/responses must not inflate calls attempted, answered, acknowledged, completed, registered, or subscribed counts.
- **State growth:** transaction caches for thousands of agents and high CPS can consume memory unless bounded by timers and capacity limits.
- **TCP/TLS semantics:** enabling UDP-style retransmit over reliable transports would violate normal RFC transaction behavior and could create duplicate calls. Reliable transports should mostly retain transaction state, not retransmit requests.
- **Existing race handling:** current early-response and per-dialog queue logic is fragile but important. A transaction layer must not reintroduce the back-to-back response loss that the dialog queue was added to avoid.
- **UAS auto-answer behavior:** adding `200 OK` retransmission to INVITE must stop exactly on matching ACK and must not start media twice or produce duplicate call results.

## Recommended implementation sequence

1. Add a transaction abstraction and tests before changing all call sites.
2. Move UAC `INVITE` Timer A/B into the transaction abstraction without changing behavior.
3. Add non-INVITE client transactions for `REGISTER` and `SUBSCRIBE` first, since they are pre-phase critical and easy to validate without media.
4. Add `BYE`, `PRACK`, and `CANCEL` client transactions.
5. Add UAS transaction response cache for non-INVITE responses (`PRACK`, `BYE`, `NOTIFY`, future methods).
6. Implement UAS `200 OK` to INVITE retransmission and UAC duplicate-`200 OK` ACK handling from `docs/INVITE_200OK_RETRANSMISSION_PLAN.md`.
7. Add GUI/reporting fields for retransmission counters and timer expiries.
8. Only after the shared layer is stable, route future methods such as `OPTIONS`, `INFO`, `UPDATE`, and `MESSAGE` through it by default.

## Minimum test coverage needed

- UDP `INVITE`: retransmits at T1, doubles, stops on first response, times out at Timer B.
- UDP `REGISTER`: retransmits same request on Timer E, stops on final response, times out on Timer F.
- UDP `SUBSCRIBE`: retransmits same request, handles auth retry as a new transaction, handles `423` retry as a new transaction.
- UDP `BYE` and `PRACK`: retransmit same request and stop on final response.
- `CANCEL`: sends and waits for `200 OK` to CANCEL while still handling final INVITE response.
- UAS non-INVITE duplicate request: cached final response is replayed, metrics are not double-counted.
- UAS INVITE non-2xx final: response retransmits until ACK or Timer H.
- UAS `200 OK` to INVITE: retransmits until ACK or timeout.
- UAC duplicate `200 OK` to INVITE: sends ACK for every duplicate without restarting RTP or double-counting.
- TCP/TLS: request retransmission timers do not send duplicate requests.
- High CPS: transaction caches are bounded and cleanup timers remove state.

## Conclusion

The current tool is not yet RFC-complete for request/response retransmission. It has a useful starting point for outbound `INVITE` over UDP and some timeout values aligned to RFC defaults, but REGISTER, SUBSCRIBE, PRACK, BYE, CANCEL, server responses, and duplicate `2xx` ACK behavior are not covered by a generic retransmission model.

The change is feasible, but should be done as a transaction-layer refactor rather than by patching individual methods. The highest-value first milestone is to generalize the existing `INVITE` Timer A/B code, then add non-INVITE client Timer E/F support for REGISTER/SUBSCRIBE, and then add server-side response caching and INVITE `200 OK` retransmission.
