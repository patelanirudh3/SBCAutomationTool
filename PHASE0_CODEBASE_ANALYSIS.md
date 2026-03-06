# Phase 0 — Codebase Analysis Report: SBCAutomationTool

---

## 1. Architecture Map

```
┌─────────────────────────────────────────────────────────────────────┐
│                        WEB UI (Flask)                               │
│  template/*.html  ←→  callflow/js-sequence-diagrams-master/app.py   │
│                        (port 7000)                                  │
│  template/*.html  ←→  callflow/callflow_Template_Code/app.py        │
│                        (port 8000)                                  │
│  homepage.html    ←→  callflow/homepage/homepage.py                 │
│                        (port 6509)                                  │
└────────────┬───────────────────────────────────┬────────────────────┘
             │ (1) Parse callflow text            │ (2) SBC REST API
             │     Generate JSON per node         │     (config/rollback)
             ▼                                    ▼
┌──────────────────────────┐        ┌──────────────────────────────┐
│  ORCHESTRATOR (app.py)   │        │  ServiceExecutor.py          │
│  ─ find_count_clients()  │        │  ─ ConfigApiExecutor         │
│  ─ processNode()         │        │  ─ HTTPS + Bearer token      │
│  ─ MakeDictionaryWithInfo│        │  ─ JSON → SBC REST config    │
│  ─ copyJsonToVM() [SFTP] │        └──────────────────────────────┘
│  ─ executeApps()  [SSH]  │
└────────────┬─────────────┘
             │ (3) paramiko SSH → each VM
             │     "python3 useragent.py <ip>"
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│            PYTHON SIP USER AGENT  (runs on remote VMs)              │
│                                                                     │
│  callflow_tool/useragent/json/linoxiderepo/                         │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐       │
│  │ useragent.py │→ │ parser&      │→ │ SIP Method Modules   │       │
│  │ (main loop)  │  │ builder.py   │  │ invite.py, bye.py,   │       │
│  │              │  │ (JSON parse, │  │ register.py, prack.py│       │
│  │              │  │  SIP build/  │  │ refer.py, update.py, │       │
│  │              │  │  parse)      │  │ subscribe.py,        │       │
│  │              │  └──────────────┘  │ notify.py, response.py│      │
│  │              │                    └──────────┬───────────┘       │
│  │              │  ┌──────────────┐             │                   │
│  │              │→ │ transport.py │ ← Raw TCP/TLS/UDP sockets       │
│  │              │  └──────────────┘                                  │
│  │              │  ┌──────────────┐                                  │
│  │              │→ │ media.py     │ ← Raw UDP sockets (RTP/SRTP)    │
│  └─────────────┘  └──────────────┘                                  │
│                                                                     │
│  Supporting: uasession.py, sipmessage.py, sipconstants.py,         │
│              sdp.py, messagebuffer.py, listenthread.py,             │
│              authenticate.py, util.py, unexpectedmessage.py,        │
│              registration.py, testreport.py                         │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│            LOADRUNNER  (CLI-driven, high-volume variant)            │
│  LoadRunner/aprilFinalWorkingRTP/uac/ & uas/                        │
│  ─ Same SIP engine (forked copy), CLI args instead of JSON          │
│  ─ useragent.py --uac/-uas, -s <sessions>, --rel                   │
│  ─ uac.py (sendInvite, sendAck, sendBye)                           │
│  ─ uas.py (handleInvite, sendInv200, handleBye)                    │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│            SIPp SCRIPTS  (external SIPp tool scenarios)             │
│  sipp_scripts/test_vijay/XML/  (100+ XML scenarios)                 │
│  ─ UAC & UAS pairs for: basic call, register, PRACK, REFER,        │
│    SIPREC, TEL URI, SIPS/TLS, BFCP, delayed offer, CANCEL,         │
│    error codes (4xx/5xx), media tunnel, re-INVITE                   │
│  ─ Shell scripts to invoke sipp binary with CSV injection           │
│  ─ CSV files for field injection ([field0]..[field5])               │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  INFRA / SUPPORT                                                    │
│  ─ autoDeploy/autoDeployVM.py: govc OVF deploy, IP config, SFTP    │
│  ─ Scripts/db_wrapper_Scripts.py: PostgreSQL via psycopg2           │
│  ─ DBoperation.py: test case + SBC config persistence               │
│  ─ ReportingMechanismFile.py: SSH poll testreport.json on VMs       │
└─────────────────────────────────────────────────────────────────────┘
```

### Who Drives What

| Driver | What it controls |
|--------|-----------------|
| **Flask app (app.py)** | Parses human-readable callflow text, generates JSON, deploys to VMs, triggers execution |
| **useragent.py** | Reads JSON, executes SIP dialog on the wire via raw sockets |
| **LoadRunner useragent.py** | Same engine but CLI-driven for volume/load testing |
| **SIPp XML scripts** | Standalone scenarios run by the `sipp` binary — completely independent of the Python UA |
| **ServiceExecutor** | REST API calls to configure the SBC (Ribbon) before/after tests |

---

## 2. Code Flow: Startup → Registration → Call Setup → Teardown

```
STARTUP
═══════
  Web UI: User types callflow text (e.g. "A_ext->SBC: INVITE ...")
      │
      ▼
  app.py::processCallflow()
      ├── find_count_clients()          # discover nodes: A_ext, B_rw, etc.
      ├── for each node:
      │     processNode() → GetInfo() → MakeDictionaryWithInfo()
      │     writes ext1.json / rw1.json / int1.json / cs1.json
      ├── configsbc()                   # REST API → SBC config
      ├── copyJsonToVM()                # paramiko SFTP to each VM
      └── executeApps()                 # paramiko SSH → "python3 useragent.py <ip>"

  On each VM:
  useragent.py::main()
      ├── parseJson()                   # loads /root/useragent/json/*.json
      ├── parseCallFlow(data)           # builds ordered event map
      ├── SignalingSocket(local, remote, transport)
      │     ├── TCP: socket.connect()
      │     └── TLS: ssl.wrap_socket() + connect()
      ├── Thread: acceptClient()        # server socket for incoming connections
      ├── Thread: startListening()      # recv loop on client socket
      └── Thread: readFromStringBuffer()# parse raw bytes → (event, msg) queue

REGISTRATION (for RW/INT node types only)
═════════════════════════════════════════
  register.py::sendInitialRegister()
      │ REGISTER →  (no auth)
      │         ← 401 Unauthorized (WWW-Authenticate: nonce)
  authenticate.py::recv401Unauthorised()
      │
  register.py::sendFinalRegister()
      │ REGISTER →  (Authorization: Digest response=...)
      │         ← 200 OK
      └── registered, proceed to call flow

CALL SETUP (driven by JSON event map)
══════════════════════════════════════
  Loop over callflow events:
      │
      ├── "INVITE send" → invite.py::sendInvite()
      │     buildOODINVITE() → SipMessage + SDP → buildMessage() → socket.sendall()
      │
      ├── "INVITE recv" → invite.py::recvInvite()
      │     parseHeaders() → update UASession (tags, routes, SDP)
      │
      ├── "100 send"    → invite.py::send100Trying()
      ├── "180/183 send"→ invite.py::sendProvResponse()
      │     (if 100rel: includes Require: 100rel, RSeq)
      ├── "180/183 recv"→ invite.py::recvProvResponse()
      │
      ├── "PRACK send"  → prack.py::sendPrack()  (RAck header)
      ├── "PRACK recv"  → prack.py::recvPrack()
      ├── "200 PRACK"   → prack.py::send200Prack()
      │
      ├── "UPDATE send" → update.py::sendUpdate()
      ├── "UPDATE recv" → update.py::recvUpdate()
      │
      ├── "200 send"    → invite.py::send200InvResp()  (with SDP answer)
      ├── "200 recv"    → invite.py::recv200Invite()
      │
      ├── "ACK send"    → invite.py::sendInvAck()
      ├── "ACK recv"    → invite.py::recvInvACK()
      │
      │── After ACK:
      │     media.py::Media(loc_ip, loc_port, rem_ip, rem_port)
      │     initiateMedia() → Thread: startSendingMedia() (RTP over UDP)
      │                     → Thread: startReceivingMedia()
      │
      ├── "REFER send"  → refer.py::sendRefer()  (blind or attended)
      ├── "REFER recv"  → refer.py::recvRefer()   (extract Replaces)
      ├── "202 recv"    → refer.py::recv202Accepted()
      ├── "NOTIFY recv" → refer.py::recvNotify()
      │
      ├── "SUBSCRIBE send" → subscribe.py::sendSubscribe()
      ├── "NOTIFY send"    → (via refer.py or notify.py)
      │
      └── (407 at any point) → authenticate.py::recv407ProxyAuth()
                               → re-send with Proxy-Authorization

TEARDOWN
════════
  ├── "BYE send"  → bye.py::sendBye()
  ├── "BYE recv"  → bye.py::recvBye() + send200Bye()
  ├── "200 BYE"   → bye.py::recv200Bye()
  │
  ├── media.stopMedia()              # stop RTP threads
  ├── register.sendUnregister()      # REGISTER Expires=0
  ├── transport.closeSocket()        # close TCP/TLS
  └── testreport.getTestReportInJson() → write /root/useragent/testreport.json

  Back on orchestrator:
  ReportingMechanismFile.py::startMonitoring()
      ├── SSH poll each VM for testreport.json
      ├── Wait for status == COMPLETE
      └── Aggregate results → CSV / DB
```

---

## 3. Skeleton Layout

```
SBCAutomationTool/
│
├── callflow_tool/
│   ├── useragent/json/linoxiderepo/   ◄── CORE: Python SIP User Agent
│   │   ├── useragent.py               # Entry point (main loop)
│   │   ├── transport.py               # Raw TCP/TLS/UDP signaling sockets
│   │   ├── listenthread.py            # Receive threads (server + client)
│   │   ├── messagebuffer.py           # SIP message framing & queue
│   │   ├── parserandbuilder.py        # SIP/SDP parse + build + JSON callflow parse
│   │   ├── sipmessage.py              # SipMessage data model
│   │   ├── sipconstants.py            # Enums: methods, headers, states, codecs
│   │   ├── sdp.py                     # SDP parse/build (SDP, SDPMLine)
│   │   ├── uasession.py               # Dialog state (UASession)
│   │   ├── registration.py            # Registration state (UARegistration)
│   │   ├── media.py                   # RTP/SRTP over UDP
│   │   ├── invite.py                  # INVITE/ACK/re-INVITE/Replaces
│   │   ├── register.py                # REGISTER flow
│   │   ├── bye.py                     # BYE flow
│   │   ├── prack.py                   # PRACK (100rel)
│   │   ├── refer.py                   # REFER + NOTIFY (transfer)
│   │   ├── subscribe.py               # SUBSCRIBE
│   │   ├── update.py                  # UPDATE
│   │   ├── notify.py                  # NOTIFY (standalone)
│   │   ├── response.py                # Generic response dispatcher
│   │   ├── authenticate.py            # Digest auth (MD5)
│   │   ├── unexpectedmessage.py       # OPTIONS, OOD, unexpected handling
│   │   ├── util.py                    # Tag/branch/callID generators
│   │   └── testreport.py              # Test result singleton → JSON
│   │
│   ├── callflow/
│   │   ├── js-sequence-diagrams-master/
│   │   │   ├── app.py                 # ORCHESTRATOR: Flask, callflow parser, SSH exec
│   │   │   ├── config.py              # VM IPs, extensions, SBC interfaces
│   │   │   ├── ServiceExecutor.py     # SBC REST API config
│   │   │   ├── DBoperation.py         # PostgreSQL persistence
│   │   │   └── ReportingMechanismFile.py  # SSH-poll test results
│   │   ├── callflow_Template_Code/    # Template-based execution (parallel app)
│   │   └── homepage/                  # Landing page
│   │
│   └── autoDeploy/
│       ├── autoDeployVM.py            # govc OVF deploy
│       └── rootSSH.py                 # SSH root access
│
├── LoadRunner/aprilFinalWorkingRTP/   ◄── FORKED UA for load testing
│   ├── uac/                           # UAC-side (sendInvite, sendBye, etc.)
│   │   ├── useragent.py               # CLI entry: --uac/--uas, -s sessions
│   │   ├── uac.py, uas.py            # Call logic
│   │   └── (same supporting modules as useragent above, forked copies)
│   └── uas/                           # UAS-side (mirror of uac/)
│
├── sipp_scripts/                      ◄── SIPp XML scenarios (100+)
│   ├── test_vijay/XML/                # Main scenario library
│   ├── test_tosif/RTP_traffic/        # RTP/load configs + CSV generator
│   └── Test_Shobhit/, Test_Omkesh/    # Developer sandboxes
│
├── template/                          ◄── Flask HTML templates (UI)
│   ├── index.html, builder.html, executer.html, menu.html, ...
│
└── Scripts/                           ◄── Utilities
    ├── db_wrapper_Scripts.py
    └── rename_file.py
```

---

## 4. SIP Engine: Python Raw Sockets vs SIPp

### Verdict: Two completely independent SIP engines coexist

| Aspect | Python User Agent | SIPp Scripts |
|--------|-------------------|-------------|
| **Location** | `useragent/json/linoxiderepo/` + `LoadRunner/` | `sipp_scripts/test_vijay/XML/` |
| **SIP construction** | 100% Python-native via raw sockets | 100% SIPp XML scenario language |
| **Transport** | `socket.SOCK_STREAM` (TCP), `ssl.wrap_socket` (TLS), `SOCK_DGRAM` (UDP stubbed for signaling, working for RTP) | SIPp binary handles transport |
| **Message building** | `SipMessage` + `buildMessage()` in `parserandbuilder.py` | SIPp `<send>` blocks with variable substitution |
| **Message parsing** | `parseHeaders()` splits on CRLF, Content-Length framing | SIPp `<recv>` with regex extraction |
| **RTP/Media** | `media.py` — raw UDP, `generateRTPpacket()`, optional SRTP via `pylibsrtp` | SIPp `-rtp_echo` or pcap play |
| **Driven by** | JSON callflow (from orchestrator) or CLI args (LoadRunner) | Shell scripts with CSV injection |
| **Integration** | Orchestrator runs UA via SSH on VMs | Run manually via shell scripts, no orchestrator |

### Which SIP Messages Are Python-Native vs SIPp

**Python-native (full build/parse):**

| Method | Send | Receive | Auth | Notes |
|--------|------|---------|------|-------|
| REGISTER | Yes | Yes | Digest (401) | Full reg/unreg cycle |
| INVITE | Yes | Yes | Digest (407) | OOD, with Replaces, re-INVITE |
| ACK | Yes | Yes | — | For 2xx and error responses |
| BYE | Yes | Yes | Digest (407) | — |
| PRACK | Yes | Yes | — | 100rel (RAck) |
| UPDATE | Yes | Yes | Digest (407) | — |
| REFER | Yes | Yes | — | Blind + attended (Replaces) |
| SUBSCRIBE | Yes | Yes | — | Partial (some bugs) |
| NOTIFY | Yes | Yes | — | For REFER and standalone |
| OPTIONS | — | Yes | — | Handled in `unexpectedmessage.py` |
| 100/180/183 | Yes | Yes | — | Provisional, 100rel support |
| 200/202/4xx/5xx | Yes | Yes | — | — |
| CANCEL | — | — | — | **Not implemented** in Python UA |
| INFO | — | — | — | **Not implemented** in Python UA |

**SIPp-only (no Python equivalent):**

| Scenario | SIPp XML |
|----------|----------|
| CANCEL flows | `Basic_call_uac_cancel.xml` |
| INFO method | `Inbound_Basic_call_uac_INFO.xml` |
| SIPREC | `*_SIPREC*.xml` (complex multi-dialog) |
| BFCP | `Bfcp_UAC/UAS.xml` |
| Delayed Offer | `delayed_offer.xml` |
| Media tunnel (RTP↔SRTP re-INVITE) | `UAC_REINVITE_TLS_CONV_CONF.xml` |
| 301 Redirect | `Basic_Register_uas_301.xml` |
| 420 Bad Extension | `Inbound_420_uac.xml` |

**Key observation:** The Python UA and SIPp scripts have **zero integration** — they don't call each other. The Python UA handles the orchestrated test automation (web UI → JSON → SSH → VMs). SIPp scripts are standalone for manual/ad-hoc testing.

---

## 5. Reuse Verdict

### KEEP (worth preserving)

| Component | Why | Condition |
|-----------|-----|-----------|
| **`sipmessage.py`** | Clean SIP message data model: header add/remove/replace, request/response lines, tag/branch extraction. Well-structured. | Refactor to use `__slots__`, add type hints |
| **`sipconstants.py`** | Comprehensive enum coverage: methods, headers, states, codecs, response codes. Good reference data. | Add CANCEL, INFO, MESSAGE enums |
| **`sdp.py`** | SDP data model with `SDP` + `SDPMLine`. Handles audio/video, SRTP keys, direction. | Fix `buildMlineAndAttributes()` — references undefined methods |
| **`parserandbuilder.py` (parse portion)** | `parseHeaders()` and `parseContent()` are battle-tested SIP/SDP parsers. `buildMessage()` serialization works. | Split into `parser.py` + `builder.py`. Fix hardcoded paths in `parseJson()`. |
| **`authenticate.py`** | Correct Digest auth (RFC 2617). MD5 HA1/HA2/response calculation works. | Add SHA-256 support (RFC 7616) |
| **`media.py`** | Working RTP send/recv over raw UDP, G.711 A/μ-law, SRTP via `pylibsrtp`. `generateRTPpacket()` builds valid RTP. | Needs sequence/timestamp management cleanup |
| **`util.py`** | Tag, branch, Call-ID generators follow RFC 3261 format. | Minor — fine as-is |
| **SIPp XML library** | 100+ scenarios covering basic calls, PRACK, REFER, SIPREC, BFCP, TEL URI, SIPS, error codes, delayed offer. Massive test coverage. | Organize into categories, parameterize IPs |
| **`ServiceExecutor.py`** | SBC REST config via HTTPS + Bearer token. Clean and decoupled. | Keep |
| **Callflow text parsing** (`GetInfo`, `MakeDictionaryWithInfo`) | The DSL concept of `A_ext->SBC: INVITE[headers]` is powerful and worth preserving as an interface. | Rewrite parser to be more robust (regex-based currently fragile) |

### REPLACE (technical debt too high)

| Component | Why | Replacement Strategy |
|-----------|-----|---------------------|
| **`transport.py`** | UDP signaling is **stubbed** (`pass`). TCP has no reconnect resilience. No connection pooling. No async. TLS path is fragile. | Rewrite with `asyncio` (UDP + TCP + TLS). Single transport abstraction. |
| **`listenthread.py`** | Blocking `recv(4096)` in threads. No graceful shutdown. No UDP support. Server-side accept is fragile. | Replace with `asyncio.Protocol` / `DatagramProtocol` |
| **`messagebuffer.py`** | Thread-based queue with `time.sleep(0.0001)` spin loops. Splits on CRLF+CRLF but Content-Length handling is brittle for streaming TCP. | Replace with proper `asyncio.StreamReader` framing |
| **`useragent.py` (main loop)** | Giant procedural `main()` with nested if/elif chains for every SIP method. Hardcoded paths (`/root/useragent/json/`). No error recovery. No timeout handling. | Rewrite as async state machine / event-driven FSM |
| **`uasession.py`** | 60+ getter/setter methods (Java-style). No state machine. Dialog state is implicit. | Replace with `@dataclass` + proper SIP dialog FSM |
| **`registration.py`** | Same Java-style getters/setters. Duplicates session concept. | Merge into `uasession.py` as a registration state |
| **LoadRunner `uac/` and `uas/`** | **Forked copy** of the entire useragent codebase with divergent changes. Multiple `*_old*.py` backup files. No shared code. | **Delete.** Merge any unique LoadRunner features (CLI args, multi-session, `--uac/--uas` mode) into the main useragent. |
| **`callflow_Template_Code/`** | Near-duplicate of `js-sequence-diagrams-master/`. Two Flask apps doing the same thing. | **Delete.** Merge any unique template features into the main app. |
| **`notify.py`** | Imports `sendMsgToTransport` from `transport` which **doesn't exist**. Calls `util.buildMessage()` but it's in `parserandbuilder`. Broken. | Rewrite or fold into `refer.py` |
| **`subscribe.py`** | Bug: `recv200Subscribe` uses wrong variable name. `sendSubscribeNotify()` is a placeholder. | Rewrite |
| **`provresponse.py`** | Empty file. | Delete |
| **`messageparser.py`** | Entirely commented out (legacy). | Delete |
| **`transport.py.py`** | Duplicate with different API (`TransportType` vs `Transport`). | Delete |

### Reuse Summary Diagram

```
  ┌─────────────────────────────────────────────┐
  │              KEEP & REFACTOR                 │
  │                                              │
  │  sipmessage.py ──── clean data model         │
  │  sipconstants.py ── comprehensive enums      │
  │  sdp.py ─────────── SDP model (fix bugs)     │
  │  parserandbuilder ─ parse/build core (split)  │
  │  authenticate.py ── digest auth works        │
  │  media.py ───────── RTP/SRTP engine          │
  │  util.py ─────────── ID generators           │
  │  SIPp XMLs ──────── 100+ test scenarios      │
  │  ServiceExecutor ── SBC REST integration     │
  │  Callflow DSL ───── text→JSON concept        │
  └─────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────┐
  │              REPLACE / DELETE                 │
  │                                              │
  │  transport.py ─────── rewrite async          │
  │  listenthread.py ──── replace w/ asyncio     │
  │  messagebuffer.py ─── replace w/ asyncio     │
  │  useragent.py ─────── rewrite as FSM         │
  │  uasession.py ─────── dataclass + FSM        │
  │  registration.py ──── merge into session     │
  │  LoadRunner/*  ─────── DELETE (forked copy)  │
  │  callflow_Template_Code/ ─ DELETE (dupe)     │
  │  notify.py ─────────── broken, rewrite       │
  │  subscribe.py ──────── buggy, rewrite        │
  │  provresponse.py ───── DELETE (empty)        │
  │  messageparser.py ──── DELETE (commented)    │
  │  transport.py.py ───── DELETE (duplicate)    │
  └─────────────────────────────────────────────┘
```

---

## Key Takeaways

1. **The Python UA is the real engine.** It builds every SIP message from scratch — no library, no SIPp. This is both impressive (full control) and dangerous (every RFC edge case is your problem).

2. **SIPp scripts are a separate asset.** They're a gold mine for regression testing but aren't wired into the automation framework. A future win: auto-generate SIPp XML from the same callflow DSL.

3. **The biggest debt is threading + blocking I/O.** The `time.sleep(0.0001)` spin loops, blocking `recv()`, and thread-per-connection model won't scale for load testing. Moving to `asyncio` is the single highest-impact change.

4. **LoadRunner is a fork, not a module.** It copied the entire UA codebase and diverged. The CLI interface (`--uac`, `--uas`, `-s sessions`) is good design — but it should be a mode of the main UA, not a separate copy.

5. **The callflow DSL (`A_ext->SBC: INVITE[...]`) is the crown jewel idea.** A human-readable test definition that auto-generates configs, deploys agents, runs tests, and collects results. This concept is worth building the next generation around.
