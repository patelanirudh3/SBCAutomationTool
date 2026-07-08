# RTP Traffic Tool Discussion - 2026-05-17

## Summary

This discussion focused on RTP media behavior in the SIP traffic tool, including whether the tool sends media, how RTP packets are counted, how 3-phase RTP should work, how to keep media alive during long calls, how to distinguish packet loss from TX/RX volume differences, and how to validate RTP with PCAP/tcpdump.

## Current RTP Behavior

The traffic tool sends RTP media when media is enabled. The sender uses G.711 PCMU with RTP payload type 0.

Continuous RTP mode is intended to send RTP for the entire call hold time and should not be altered.

The existing 3-phase RTP mode was considered too light for longer calls because it sends only short start/end bursts and sparse keepalive packets. It was therefore kept for backward compatibility and renamed conceptually as 3-phase lite.

## 3-Phase Coverage Mode

A new 3-phase coverage mode was designed and implemented to make RTP volume proportional to call hold time.

The core idea is:

- Calculate full continuous RTP volume from hold time and packetization time.
- Apply a configured media coverage percentage.
- Divide the RTP-active budget into start burst, mid-call bursts, and end burst.
- Spread mid-call bursts across the call using auto-calculated spacing.

Example discussed:

- Hold time: 180 seconds
- Packetization: 20 ms, which is 50 packets per second
- Media coverage: 25%
- RTP-active duration: 45 seconds
- Start burst share: 20%
- End burst share: 20%
- Mid-call RTP duration: remaining 60%

This results in about 2,250 RTP packets per direction instead of about 9,000 packets per direction for full continuous mode.

## Coverage Keepalive RTP

A concern was raised that long silent intervals between mid-call bursts could cause SBCs, media relays, NAT devices, or RTP watchdogs to assume the call is inactive.

To address this, coverage-mode RTP keepalive was added.

Design:

- Applies only to 3-phase coverage mode.
- Sends low-rate RTP during idle gaps between full-rate bursts.
- Default keepalive rate is 3 packets per second.
- Keeps RTP visible during the entire call without turning coverage mode into full continuous RTP.

This separates two concepts:

- Full-rate RTP bursts for meaningful media-plane exercise.
- Low-rate RTP keepalive for media path liveness.

## RTP Stop Behavior

The intended behavior is:

- RTP should flow for the configured hold time.
- If BYE is received before the hold time completes, RTP should stop immediately.

Current behavior:

- UAC starts RTP after sending ACK.
- UAC runs RTP for the hold time.
- UAC sends BYE after RTP completes.
- UAS starts RTP after receiving ACK.
- UAS stops RTP when BYE is received, or when its RTP schedule naturally completes.

This was considered acceptable for the current test model.

## Reporting Improvements

The Media & QoS panel was extended to include RTP flow information.

The desired information includes:

- Configured RTP packets per direction per call
- Average RTP TX per direction per call
- Average RTP RX per direction per call
- Total RTP TX
- Total RTP RX
- RTP loss percentage
- TX/RX asymmetry
- RX SSRC count
- Expected packet count

The important design decision is to keep RTP concepts separate:

- RTP sequence loss
- RTP volume gap
- RTP source mismatch

## RTP Loss vs TX/RX Asymmetry

RTP loss and TX/RX asymmetry are different.

RTP loss means packets are missing inside a received RTP stream, based on RTP sequence-number gaps.

TX/RX asymmetry means the number of packets transmitted differs from the number of packets received.

A run can have:

- Zero RTP sequence loss
- High TX/RX asymmetry

This can happen when the received stream is sequence-complete, but the remote side or SBC sends fewer packets, relays fewer packets, changes packetization, applies silence suppression, or sends from a source that does not match the expected SDP media address.

## RFC3550 RTP Measurement Direction

The RFC3550-style approach discussed was:

- Track receive state per SSRC.
- Track base sequence number.
- Track highest sequence number.
- Track wraparound cycles.
- Track received packet count.
- Calculate expected packets using extended sequence numbers.
- Calculate loss as expected packets minus received packets.

This avoids treating TX/RX volume difference as packet loss.

The implementation direction was:

- Move beyond dominant-SSRC-only sequence tracking.
- Add per-SSRC expected/lost receive tracking.
- Keep existing counters for compatibility.
- Add expected packet and SSRC count reporting.

## PCAP and tcpdump Validation

GUI PCAP capture:

- Captures RTP packets seen by the application RTP socket.
- Writes Wireshark-readable pcap files.
- Is useful for application-level RTP validation.
- Is not the same as full NIC-level capture.

tcpdump capture:

- A tcpdump helper script was added for traffic-engine VM capture.
- tcpdump showed UDP packets arriving on the VM.
- Kernel reported zero packet drops during the capture.

This suggests the VM/kernel was not dropping UDP packets globally during that capture.

## Key Finding From Latest Run

Latest reported values included:

- Total RTP TX: 62,814
- Total RTP RX all sources: 62,502
- RTP RX from expected SBC source: 39,960
- RTP expected packets: 62,502
- RTP lost packets: 0

Interpretation:

- RTP packets were not missing overall from the tool's receive perspective.
- The received streams were sequence-complete.
- The apparent large RX gap came from source classification.
- Many packets were counted as other-source RTP rather than expected-SBC RTP.

This means the earlier visible RX value was not all received RTP. It was the count from the exact expected SBC IP and port.

## UAC vs UAS RTP TX Observation

The latest run showed:

- UAS RTP TX: 42,744 packets
- UAC RTP TX: 20,070 packets
- Total RTP TX: 62,814 packets

UAS was not sending less RTP than UAC. UAS sent most of the RTP.

A notable finding was that many UAC call legs had zero RTP TX while still receiving RTP. Those UAC records also had empty RTP remote IP/port. This suggests the UAC did not have a valid remote RTP destination from SDP for those call legs.

This should be investigated separately.

## Open Investigation

The main open issue is identifying why some RTP is classified as other source and why some UAC call legs have no remote RTP destination.

Recommended Wireshark checks:

- Open the tcpdump pcap.
- Use UDP conversations.
- Compare source IP and source port against expected SBC media IP and port.
- Check whether other-source RTP is from the same SBC IP but a different UDP source port.
- Check whether multiple SBC/media relay ports are used.
- Check UAC call legs with empty RTP remote IP/port.

## Current Design Direction

The report should clearly show these as separate items:

- RTP sequence loss: based on per-SSRC expected vs received sequence progression.
- RTP volume gap: based on total TX vs total RX.
- RTP source mismatch: based on expected SBC source vs other RTP source.

This avoids confusing true RTP packet loss with relay behavior, source-port mismatch, or bidirectional volume differences.
