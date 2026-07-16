# Retranmission and Transactioini layer Design

## Purpose

This document defines the design change needed to move SIP retransmission out of method-specific code and into a common transaction layer.

The goal is to ensure every SIP request and response sent by the traffic tool is handled consistently, without adding one-off retransmission loops inside `Register`, `Subscribe`, `Invite`, `Bye`, `Prack`, `Cancel`, `Notify`, or future methods.

## Design goals

- Use one shared transaction layer for all SIP methods and responses.
- Avoid method-by-method or response-by-response retransmission logic.
- Follow RFC 3261 transaction behavior for when retransmission starts, stops, and times out.
- Apply the same RFC transaction retransmission logic for UDP, TCP, and TLS as a traffic-tool requirement.
- Keep SIP timers, transaction state, matching, retransmission, and cleanup in one place.
- Preserve existing call, registration, subscription, RTP, metrics, and GUI behavior while migrating.
- Preserve existing failover and multizone controller ownership; retransmission must not move an agent or dialog between controllers.
- Avoid double-counting calls, registrations, subscriptions, acknowledgements, or failures.
- Keep the design extensible for future methods such as `OPTIONS`, `INFO`, `UPDATE`, `MESSAGE`, and `REFER`.

## RFC compliance baseline

This design must comply with RFC 3261 transaction rules for request and response retransmission.

For outbound `INVITE` client transactions:

- Send the initial `INVITE`.
- Start Timer A immediately after the initial send.
- Retransmit the same `INVITE` when Timer A fires.
- Double Timer A after each retransmission.
- Stop Timer A when any response is received: `1xx`, `2xx`, or `3xx-6xx`.
- Timer B is the overall INVITE client transaction timeout.

For outbound non-INVITE client transactions:

- Send the initial request.
- Start Timer E immediately after the initial send.
- Retransmit the same request when Timer E fires.
- Double Timer E up to T2.
- Continue Timer E through provisional responses.
- Stop Timer E when a final response is received: `2xx-6xx`.
- Timer F is the overall non-INVITE client transaction timeout.

For this traffic tool only, the active retransmission timers must run for UDP, TCP, and TLS. This differs from the normal RFC transport optimization where reliable transports do not need request retransmission, but it does not change the RFC transaction state machine or timer stop conditions.

## Failover and multizone boundary

The transaction layer must not override existing multi-controller, dual-registration, or multizone failover logic.

Required boundary rules:

- A transaction belongs to the controller/transport selected by the current agent and failover state at the time the transaction is created.
- Retransmission must use the same transaction bytes and the same selected transport/controller unless the higher-level failover engine explicitly terminates or replaces that transport.
- The transaction manager must not independently switch a REGISTER, SUBSCRIBE, INVITE, BYE, or cleanup request from primary to secondary.
- If failover closes or replaces a transport, affected transactions must terminate with a clear reason such as `transport_replaced` or `failover_in_progress`.
- New transactions after failover must be created by existing recovery logic, not by retransmission logic.
- Transaction metrics should include controller/zone labels where available so retransmissions are attributable to the correct path.

## Impact on multi-controller and multizone design

Retransmission is intended to be independent of the multi-controller design. It should operate only inside the SIP transport/controller path that the current `ExtensionAgent` already owns.

The existing multizone model assigns agents to an `AgentGroup`. Each group has:

- a primary controller,
- a secondary controller,
- primary-side agents,
- secondary-side agents,
- an active controller state,
- group-level subscription move and failback logic.

The transaction layer must not duplicate or replace any of that logic. Its responsibility is limited to transaction-local behavior:

- retransmit the same request or response bytes for the same transaction,
- stop timers when RFC stop conditions are met,
- replay cached responses for duplicate requests,
- absorb duplicate responses without double-counting,
- terminate transactions when the owning transport or context is closed.

The transaction layer must not make HA decisions:

- It must not choose primary versus secondary.
- It must not subscribe on the secondary because a primary retransmission timed out.
- It must not re-register an agent on another controller.
- It must not put agents into or remove agents from the traffic pool.
- It must not trigger failback.
- It must not infer controller health from one transaction timeout.

Transaction timeouts can be reported upward as evidence, but only the existing recovery and failover components may decide whether a controller is unhealthy or whether traffic should move.

Recommended ownership boundary:

```text
AgentGroup / recovery layer:
    owns controller selection, failover, failback, pool movement

ExtensionAgent:
    owns one concrete transport path to one selected controller

TransactionManager:
    owns retransmission and duplicate handling for messages on that path
```

When an `AgentGroup` moves an extension from primary to secondary, the old primary-side agent and its transaction manager should terminate in-flight transactions with a reason such as `controller_move` or `transport_replaced`. The secondary-side agent should create new transactions only when the recovery layer explicitly sends REGISTER, SUBSCRIBE, INVITE, BYE, or cleanup requests on that secondary path.

Therefore, the expected impact is low if this boundary is preserved. Retransmission changes SIP reliability inside each selected controller path; it should not change agent distribution, active-controller state, failover trigger behavior, failback timing, or pool membership.

The main multizone risk is accidental coupling: if transaction timeout handling directly calls failover/move code, retransmission could cause premature controller moves during transient SIP loss or overload. The design must avoid that coupling.

## TCP recovery versus SIP retransmission

There are two retry mechanisms and they must remain decoupled.

### TCP/TLS connection-level retry

Connection-level retry is owned by transport, agent recovery, and multizone failover logic.

It applies when the client loses its TCP/TLS connection to the controller, for example:

- TCP reset,
- socket close,
- TLS connection failure,
- read/write failure that marks the transport disconnected.

When this happens:

- SIP transaction retransmission does not apply on that socket because there is no usable socket.
- In-flight SIP transactions on that transport must terminate with a transport-level reason such as `transport_down`, `connection_reset`, or `transport_replaced`.
- Existing failover/recovery logic decides whether the agent should move to secondary.
- Existing recovery logic keeps trying to reconnect and re-register to the primary.
- If the agent is active on secondary, failback to primary can happen only under the existing rule: primary is recovered and the agent is not in an active call on secondary.

The transaction manager must not attempt to reconnect TCP/TLS and must not move the agent between controllers.

### SIP message-level retransmission

SIP retransmission is owned by the transaction manager.

It applies only while the selected transport/controller path is usable. In this tool, that means:

- UDP transport object is available, or
- TCP/TLS socket is currently connected and writable.

Examples:

- Agent moved to secondary and has a live TCP/TLS connection to the secondary.
- Secondary accepts the TCP/TLS connection but does not respond to a `REGISTER`, `SUBSCRIBE`, `INVITE`, `BYE`, or response/ACK flow.
- Transaction manager retransmits the same SIP message according to RFC timer state and stops on the RFC stop condition.

SIP retransmission failure is a SIP transaction outcome, not a controller failover decision by itself. The transaction manager can report `Timer B`, `Timer F`, `Timer H`, or other timer expiry upward, but the failover layer decides whether repeated evidence should affect controller health.

### Boundary rule

```text
No socket:
    TCP/TLS recovery and failover logic applies.
    SIP retransmission for that transport stops.

Socket alive:
    SIP transaction retransmission applies.
    Failover logic does not run unless transport/recovery logic sees connection loss.
```

This boundary protects multizone behavior. A live but SIP-silent secondary controller should exercise SIP retransmission and transaction timeout handling. A dead primary TCP/TLS connection should exercise reconnect/failback logic, not SIP retransmission on the dead socket.

## Recommended architecture

Use one common `TransactionManager` that owns both client and server transactions.

Do not create separate method-specific retransmission handlers. The method-specific code should build SIP messages and drive business flow only. It should not own retransmission timers.

Recommended placement:

- New package: `go/internal/siptx`
- Integrated into `ExtensionAgent`
- The transaction manager sits between `ExtensionAgent` and `sip.Transport`
- The dispatch loop feeds every received SIP message into the transaction manager before routing it to dialog queues and wildcard listeners

High-level flow:

```text
Method helper builds SIP message
        |
        v
ExtensionAgent.SendRequest / SendResponse
        |
        v
TransactionManager
        |
        v
sip.Transport.Send

sip.Transport.RecvChan
        |
        v
TransactionManager.HandleInbound
        |
        v
Existing dispatch loop / dialog queue / wildcard listener
```

## Public API shape

The transaction layer should expose a small API. Method-specific code should not know about timers.

```text
type TransactionManager interface {
    SendRequest(ctx, msg, body, opts) (ClientTransaction, error)
    SendResponse(ctx, request, response, body, opts) (ServerTransaction, error)
    HandleInbound(rawMessage) (action, event, error)
    Shutdown()
}
```

Recommended agent-level wrappers:

```text
ExtensionAgent.SendRequest(ctx, msg, body, options)
ExtensionAgent.SendResponse(ctx, req, resp, body, options)
ExtensionAgent.SendStateless(msg, body) // rare escape hatch, metrics-visible
```

`ExtensionAgent.Send(...)` should remain temporarily for migration compatibility, but new and migrated code should avoid using it directly.

## Transaction types

The manager should support four core transaction classes:

- `InviteClientTransaction`
- `NonInviteClientTransaction`
- `InviteServerTransaction`
- `NonInviteServerTransaction`

All SIP methods map into one of these classes:

- `INVITE`: invite client/server transaction.
- `ACK`: special handling.
- `CANCEL`, `REGISTER`, `SUBSCRIBE`, `NOTIFY`, `PRACK`, `BYE`, `OPTIONS`, `INFO`, `UPDATE`, `MESSAGE`, `REFER`: non-invite transaction.

ACK rules:

- ACK for non-2xx final INVITE response belongs to the INVITE client transaction.
- ACK for 2xx final INVITE response is a separate request and should not be treated as a normal retransmitted request.
- UAC must ACK each matching retransmitted `2xx` to INVITE while dialog state can safely build the ACK.

## Transaction keys

Every transaction must have a stable key. Matching must be strict enough to avoid retransmitting or ACKing the wrong dialog.

Client transaction key:

```text
top Via branch
CSeq method
CSeq number
Call-ID
From tag
Request URI where required by RFC behavior
```

Server transaction key:

```text
top Via branch
CSeq method
CSeq number
Call-ID
From tag
To tag if present
sent-by from top Via
```

Dialog key remains separate:

```text
Call-ID
local tag
remote tag
```

The transaction manager should never use dialog state as its only transaction key. Dialog state is higher level and can be missing during early messages.

## Timer model

Add one timer profile used by all transactions.

```text
T1 default: 500 ms
T2 default: 4 s
T4 default: 5 s
Timer B: 64*T1
Timer D: >= 32 s for unreliable transport equivalent
Timer E: T1, doubling to T2
Timer F: 64*T1
Timer G: T1, doubling to T2
Timer H: 64*T1
Timer I: T4
Timer J: 64*T1
Timer K: T4
```

Because this tool requires retransmission irrespective of transport type, transport should not disable the transaction layer. Instead:

- UDP, TCP, and TLS all use the same transaction state machines.
- RFC timer start, stop, and timeout rules are preserved.
- Active retransmission sends bytes on UDP, TCP, and TLS.
- Metrics must clearly show transport and controller path so results can be interpreted correctly.

Suggested config:

```text
sip_transaction_layer_enabled: true
sip_retransmit_on_reliable_transport: true
t1_ms: 500
t2_ms: 4000
t4_ms: 5000
timer_b_seconds: 32
timer_f_seconds: 32
transaction_cache_max_per_agent: 4096
```

## Request retransmission logic

All outbound requests should be sent through `SendRequest`.

### INVITE client transaction

Required states:

```text
Calling
Proceeding
Completed
Accepted
Terminated
```

RFC behavior:

```text
on Send INVITE:
    send initial INVITE once
    create InviteClientTransaction
    start Timer A immediately
    start Timer B

on Timer A:
    if no response has been received:
        retransmit the same INVITE bytes
        next interval = previous * 2

on inbound 1xx:
    transition to Proceeding
    stop Timer A

on inbound 2xx:
    stop Timer A
    stop Timer B
    transition to Accepted
    deliver 2xx to dialog layer
    keep ACK helper state until dialog cleanup window expires

on inbound duplicate 2xx:
    do not re-run call setup
    do not double-count answered/acknowledged metrics
    ask dialog layer to resend ACK if dialog/zombie state can safely build it

on inbound 3xx-6xx:
    stop Timer A
    stop Timer B
    send ACK for failure through transaction layer
    transition to Completed
    start cleanup timer

on Timer B:
    stop Timer A
    terminate transaction
    report timeout
```

Timer A starts immediately after the initial `INVITE` and stops when the first response arrives. The first response can be `100 Trying`, another `1xx`, `2xx`, or `3xx-6xx`.

### Non-INVITE client transaction

Applies to `REGISTER`, `SUBSCRIBE`, `PRACK`, `BYE`, `CANCEL`, `OPTIONS`, `INFO`, `UPDATE`, `MESSAGE`, and `REFER`.

Required states:

```text
Trying
Proceeding
Completed
Terminated
```

Pseudocode:

```text
on Send non-INVITE request:
    send initial request
    create transaction
    start Timer E
    start Timer F

on Timer E:
    if final response not received:
        retransmit same request bytes
        next interval = min(previous * 2, T2)

on inbound 1xx:
    transition to Proceeding
    continue Timer E with T2 cap

on inbound 2xx-6xx:
    stop Timer E
    stop Timer F
    deliver response to existing wait/dialog code
    start Timer K cleanup

on Timer F:
    stop Timer E
    terminate transaction
    report transaction timeout
```

Auth and semantic retries are not retransmissions:

- `401` / `407` auth retry creates a new transaction with new Via branch and new CSeq where required.
- `423` SUBSCRIBE retry creates a new transaction.
- Application-level pre-phase retry creates a new transaction.
- Retransmission always resends the same transaction bytes.

## Response retransmission logic

All responses should be sent through `SendResponse`.

### INVITE server transaction

Required states:

```text
Proceeding
Completed
Confirmed
Accepted
Terminated
```

Pseudocode:

```text
on inbound INVITE:
    create server transaction if missing
    deliver request to UAS dialog flow

on send 1xx:
    cache latest provisional response
    send response
    remain Proceeding

on duplicate INVITE while Proceeding:
    resend latest provisional response if available

on send non-2xx final:
    cache final response
    send response
    start Timer G
    start Timer H
    transition Completed

on Timer G:
    retransmit cached final response
    next interval = min(previous * 2, T2)

on matching ACK for non-2xx final:
    stop Timer G
    stop Timer H
    transition Confirmed
    start Timer I cleanup

on send 2xx final:
    cache 2xx response
    send response
    transition Accepted
    start 2xx retransmission schedule until matching ACK or timeout

on matching ACK for 2xx:
    stop 2xx retransmission schedule
    keep short duplicate absorption state

on timeout:
    terminate transaction and notify dialog layer
```

The `2xx` to INVITE behavior is dialog-level in RFC terms, but this design should still centralize it in the transaction manager because the tool needs one retransmission mechanism for all sent responses.

### Non-INVITE server transaction

Pseudocode:

```text
on inbound non-INVITE request:
    key transaction by Via branch + CSeq + Call-ID + tags

    if matching transaction has cached final response:
        resend cached final response
        do not deliver duplicate request to business logic
        increment duplicate_request and cached_response_replay metrics
        return handled

    create transaction
    deliver request to existing handler

on send final response:
    cache final response bytes
    send response
    start Timer J cleanup

on Timer J:
    remove transaction
```

This prevents duplicate `NOTIFY`, `BYE`, `PRACK`, `CANCEL`, and future requests from triggering duplicate business logic.

## Inbound dispatch integration

The existing dispatch loop should remain the owner of dialog queues and wildcard listeners, but inbound messages should first pass through the transaction manager.

Pseudocode:

```text
for raw := range transport.RecvChan():
    txAction, event := txManager.HandleInbound(raw)

    switch txAction:
    case HandledByTransaction:
        continue

    case DeliverToApplication:
        dispatch to dialog queue and wildcard listeners

    case DeliverAndTransactionObserved:
        dispatch to dialog queue and wildcard listeners

    case DropMalformed:
        record metric and continue
```

Examples:

- Duplicate non-INVITE request with cached response: handled by transaction manager, not delivered again.
- First INVITE: delivered to UAS flow and tracked by transaction manager.
- 100/180/183/200 response: transaction manager updates state, then delivers to existing wait logic.
- Duplicate `200 OK` to INVITE: transaction manager asks ACK helper to resend ACK, then suppresses duplicate business handling.

## Outbound send migration

Current method helpers should keep building messages. Only the send call changes.

Before:

```text
msg := build REGISTER
a.Send(msg, "")
wait for response
```

After:

```text
msg := build REGISTER
tx, err := a.SendRequest(ctx, msg, "", TxOptions{Method: "REGISTER"})
wait for response through existing dialog queue
tx completes or times out under transaction manager
```

For responses:

```text
resp := build 200 OK to BYE
a.SendResponse(ctx, byeRequest, resp, "", TxOptions{Method: "BYE"})
```

The business flow still waits for events the same way initially. The transaction manager owns retransmission and duplicate handling underneath.

## Metrics and logs

Add transaction-level counters that are independent from call counters.

Recommended counters:

```text
sip_tx_client_created_total{method,type}
sip_tx_server_created_total{method,type}
sip_tx_request_sent_total{method,initial_or_retransmit,transport}
sip_tx_response_sent_total{method,code,initial_or_retransmit,transport}
sip_tx_duplicate_request_total{method}
sip_tx_duplicate_response_total{method,code}
sip_tx_cached_response_replay_total{method,code}
sip_tx_timeout_total{method,timer}
sip_tx_terminated_total{method,reason}
sip_tx_ack_replayed_total{method=INVITE}
```

Do not change existing user-facing call counters until the transaction metrics are proven stable.

Existing counters such as `invites_sent`, `acks_sent`, `byes_sent`, `registered`, `subscribed`, `completed`, and `failed` must continue to represent business events, not raw retransmitted packets.

## No-breakage migration plan

Use a staged implementation with a feature flag.

### Phase 1: Add transaction manager in observe-only mode

- Add transaction key parsing.
- Track inbound and outbound transactions without retransmitting.
- Emit debug metrics only.
- Keep all existing send/wait logic unchanged.
- Validate transaction matching against current traffic.

### Phase 2: Move outbound send wrappers

- Add `SendRequest` and `SendResponse` wrappers.
- Keep `Send` as a raw fallback.
- Migrate one low-risk flow first, such as `NOTIFY` response caching or `BYE` response caching.
- No active retransmission yet unless explicitly enabled.

### Phase 3: Enable non-INVITE client transactions

- Start with `REGISTER` and `SUBSCRIBE`.
- Preserve existing application retries, but ensure they create new transactions.
- Add Timer E/F behavior under the transaction manager.
- Verify no duplicate registered/subscribed counting.

### Phase 4: Enable call-path transactions

- Migrate `PRACK`, `BYE`, and `CANCEL`.
- Migrate INVITE client transaction.
- Replace existing `startTimerA` only after tests prove RFC-equivalent behavior, with the intentional product difference that active retransmission also runs on TCP/TLS.

### Phase 5: Enable server response caching and retransmission

- Cache and replay non-INVITE final responses.
- Add INVITE server non-2xx retransmission.
- Add `200 OK` to INVITE retransmission until ACK.
- Add UAC duplicate `200 OK` ACK replay.

### Phase 6: Enable for TCP/TLS

- Turn on active retransmission for TCP/TLS only after UDP behavior is stable.
- Keep explicit metrics showing retransmission over TCP/TLS.
- Provide a rollback config to disable active retransmission while keeping transaction observation.
- Confirm retransmission stays on the currently assigned controller and does not bypass multizone failover state.

## Safety rules

- Retransmission must resend the same bytes for the same transaction.
- Auth retries must not be treated as retransmissions.
- CSeq changes create a new transaction.
- Via branch changes create a new transaction.
- Duplicate requests must not be delivered twice to business logic once cached response replay is available.
- Duplicate responses must not re-run call setup, media start, cleanup, or reporting.
- A retransmitted request/response must not increment business counters.
- Every transaction must have bounded lifetime.
- Every retransmission loop must stop on final response, matching ACK, timeout, context cancellation, transport shutdown, or agent shutdown.
- Retransmission must not switch controller, zone, or transport ownership; failover logic alone owns those transitions.

## Test plan

Minimum tests before enabling by default:

- Transaction key extraction for every supported request and response.
- Non-INVITE duplicate request replays cached response and suppresses duplicate handler execution.
- `REGISTER` retransmits same bytes under Timer E and times out under Timer F.
- `SUBSCRIBE` retransmits same bytes; `401` / `407` auth retry creates a new transaction.
- `BYE` retransmits same bytes and stops on `200 OK`.
- `PRACK` retransmits same bytes and stops on `200 OK`.
- `CANCEL` retransmits same bytes and handles `200 OK` to CANCEL separately from final INVITE response.
- `INVITE` starts Timer A immediately after initial send and stops Timer A on the first received response.
- `INVITE` Timer B terminates the transaction if no final transaction outcome occurs.
- UAS `200 OK` to INVITE retransmits until matching ACK.
- UAC duplicate `200 OK` to INVITE sends ACK again and does not double-count.
- TCP/TLS active retransmission uses the same RFC timer start and stop rules as UDP.
- Multizone failover tests prove retransmission remains on the assigned controller and terminates cleanly when failover replaces transport ownership.
- High-CPS transaction cache cleanup does not leak memory.
- Existing call success path still completes with the same milestones.
- Existing registration/subscription pre-phase still reports the same business results.

## Open questions for review

- What should be the maximum retransmission duration for `200 OK` to INVITE when ACK never arrives?
- How long should ACK replay state be retained after call completion?
- Should transaction metrics be shown in the GUI immediately, or logged first until validated?

## Recommended conclusion

Implement one common `TransactionManager` for both requests and responses. This is safer than separate request and response handlers because transaction matching, timers, retransmission, duplicate suppression, metrics, and cleanup all share the same keys and lifecycle.

The transaction manager should be introduced in observe-only mode first, then enabled flow by flow behind config flags. This minimizes breakage and gives the team a rollback path while moving toward complete retransmission coverage for all SIP traffic generated by the tool.
