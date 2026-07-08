# INVITE 200 OK Retransmission And ACK Handling Plan

## Objective

Improve INVITE dialog reliability under high load by implementing both sides of the SIP 2xx ACK behavior:

- UAS retransmits `200 OK` to `INVITE` until ACK is received or an ACK timeout expires.
- UAC sends ACK for every retransmitted `200 OK` to `INVITE` for an active dialog.

## Why This Is Needed

TCP/TLS guarantees byte delivery only on the current transport connection. It does not guarantee that:

- the SIP application processed the message,
- a B2BUA or proxy forwarded it correctly,
- downstream hops are also reliable transports,
- ACK generation or delivery succeeded at the SIP layer,
- remote dialog state survived overload conditions.

Therefore, retransmission handling is still useful even when the tool uses TCP/TLS.

## Current Behavior

Current UAS behavior:

1. Send `200 OK` to `INVITE`.
2. Wait for ACK for `uasSIPTimeout` (`20s`).
3. If ACK arrives, start media.
4. If ACK does not arrive, record a generic timeout.

Current UAC behavior:

1. Receive first `200 OK` to `INVITE`.
2. Send ACK once.
3. Start media / hold / BYE flow.
4. Does not actively ACK duplicate retransmitted `200 OK` responses for the same dialog.

## Required UAS Behavior

After sending initial `200 OK` to `INVITE`:

1. Start an ACK wait timer.
2. Start a bounded `200 OK` retransmission loop.
3. Stop retransmission immediately when matching ACK is received.
4. Mark ACK received once.
5. Start media only after ACK is received.
6. If ACK is not received before timeout:
   - stop retransmission,
   - remove/cleanup dialog state,
   - record failed call reason as `No ACK`,
   - register zombie/stale dialog as needed to reject late duplicates.

Suggested retransmission schedule:

```text
initial 200 OK at t=0
retransmit at 500ms
retransmit at 1s
retransmit at 2s
retransmit at 4s
continue at capped interval until ACK timeout
```

The timeout should be configurable eventually, but can initially reuse or derive from the current UAS signaling timeout.

## Required UAC Behavior

After the first `200 OK` to `INVITE` is received:

1. Parse dialog route set and remote target.
2. Send ACK.
3. Mark answered/ACK milestones once.
4. Keep enough active dialog state to recognize duplicate `200 OK` retransmissions.
5. For every duplicate `200 OK` matching the active INVITE dialog:
   - send ACK again,
   - do not restart media,
   - do not create a duplicate call result,
   - do not double-count answered or acknowledged metrics.

Matching should be strict enough to avoid ACKing unrelated responses:

- `Call-ID`,
- CSeq method and number for `INVITE`,
- local/remote tags where available,
- dialog state still active.

## Metrics And Reporting

Add or preserve clear diagnostics:

- `UAS_200_OK_RETRANSMIT`
- `UAS_ACK_RECEIVED`
- `UAS_NO_ACK_TIMEOUT`
- failed call reason: `No ACK`

Do not double-count:

- answered calls,
- acknowledged calls,
- completed calls,
- failed calls.

`No ACK` should be visible as a signaling failure/warning. If the call does not complete cleanly, it should be counted as a failed call with reason `No ACK`.

## Cleanup And Late Messages

If ACK arrives after the no-ACK timeout:

- it should not resurrect the call,
- it should not start media,
- it may be ignored or handled via zombie dialog logic.

If duplicate `200 OK` arrives after the call completed:

- do not create a new call,
- ideally ACK only if valid dialog/zombie state still exists and ACK can be built safely,
- otherwise ignore/log at debug level.

## Risks

Risk level: moderate.

Main risks:

- retransmitting `200 OK` after ACK due to missed stop condition,
- ACKing an unrelated `200 OK` if matching is too loose,
- double-counting metrics on duplicate `200 OK`,
- extra SIP signaling under overload,
- holding dialog state too long after timeout,
- masking real routing/correlation problems if retransmission is overused.

## Risk Mitigation

- Bound retransmission by timeout.
- Stop retransmission on first matching ACK.
- Keep metrics idempotent.
- Match duplicate `200 OK` responses strictly.
- Keep retransmission intervals capped.
- Add focused unit tests before enabling broadly.

## Test Coverage Required

Minimum tests:

1. UAS sends initial `200 OK`, receives ACK, stops retransmission.
2. UAS retransmits `200 OK` when ACK is missing.
3. UAS records failure reason `No ACK` when ACK timeout expires.
4. UAC sends ACK for first `200 OK`.
5. UAC sends ACK again for duplicate `200 OK`.
6. Duplicate `200 OK` does not double-count answered/acknowledged/completed calls.
7. Late ACK after UAS timeout does not resurrect call.
8. Duplicate `200 OK` after call completion does not create a new call.

## Recommended Implementation Order

1. Implement UAC duplicate `200 OK` detection and ACK resend.
2. Add UAC tests to prove duplicate ACK behavior is idempotent.
3. Implement UAS `200 OK` retransmission loop and `No ACK` failure reason.
4. Add UAS tests for retransmission, ACK stop, and no-ACK timeout.
5. Add metrics/reporting for `No ACK` and retransmission count.

