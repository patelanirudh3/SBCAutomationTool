"""
traffic/config.py
=================
VMConfig dataclass with ENV VAR -> YAML -> defaults loading priority.

All fields can be supplied via:
  1. Environment variables (e.g. VM_ROLE, SBC_HOST, CPS)
  2. A YAML file (--config path/to/config.yaml)
  3. Hardcoded defaults in the dataclass
"""

from __future__ import annotations

import math
import os
import logging
from dataclasses import dataclass, field, fields
from typing import Any

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Default values
# ---------------------------------------------------------------------------
_DEFAULTS: dict[str, Any] = {
    "vm_role": "UAC",
    "vm_id": "vm-1",
    "uac_ext_start": 1001,
    "uac_ext_end": 1250,
    "uas_ext_start": 2001,
    "uas_ext_end": 2250,
    "sbc_host": "127.0.0.1",
    "sbc_port": 5060,
    "sip_transport": "TCP",
    "domain": "sbc.local",
    "sip_password": "password",
    "cps": 6,
    "hold_time_seconds": 180,
    "ramp_up_seconds": 30,
    "metrics_interval": 10,
    "metrics_port": 8080,
    "coordinator_url": "http://localhost:8080",
    "register_rate": 50,
    "register_expires": 3600,
    "register_retry": 3,
    "register_timeout": 5,
    "max_concurrent_calls": 0,    # 0 = unlimited (derived from CPS × hold_time)
    "local_host": "",             # empty = auto-detect
    "local_port": 0,              # 0 = OS-assigned per extension
    "peer_stop_url": "",          # UAC POSTs here when traffic complete (e.g. UAS /api/test/stop)
    "rtp_burst_seconds": 2,       # duration of start/end burst phases
    "rtp_burst_pps": 50,          # packet rate during bursts (= 1000 / ptime_ms)
    "rtp_keepalive_interval": 5,  # seconds between keepalive packets (must be < SBC inactivity timer)
    "pool_wrap_delay_seconds": 0,  # extra margin beyond auto-computed delay (0 = rely on SIP_BYE_BUFFER)
    "media_enabled": True,           # True = send RTP; False = signaling-only (no RTP)
    "rtp_mode": "3phase",            # "3phase" | "continuous"
    "rtp_ptime": 20,                 # ptime in ms: 20 (50 PPS) or 40 (25 PPS)
    # ── Traffic run control ──────────────────────────────────────────────────
    # The GUI (or YAML) sets exactly ONE of the three modes below.
    # CLI --max-calls overrides all three at launch time.
    "traffic_mode": "unlimited",  # "smoke" | "timed" | "unlimited"
    "call_count": 0,              # smoke: exact number of calls to attempt (> 0)
    "duration_hours": 0.0,        # timed: run duration in hours (decimals ok: 0.25 = 15 min)
    "scenario": "basic_call",     # "basic_call" | "hold_unhold" — future scenarios added here
    "scenario_hold_duration_seconds": 5.0,
    "scenario_pre_hold_rtp_seconds": 3.0,
    "scenario_post_hold_rtp_seconds": 3.0,
}

# ENV VAR name mapping: field_name -> ENV_VAR_NAME
_ENV_MAP: dict[str, str] = {
    "vm_role":            "VM_ROLE",
    "vm_id":              "VM_ID",
    "uac_ext_start":      "UAC_EXT_START",
    "uac_ext_end":        "UAC_EXT_END",
    "uas_ext_start":      "UAS_EXT_START",
    "uas_ext_end":        "UAS_EXT_END",
    "sbc_host":           "SBC_HOST",
    "sbc_port":           "SBC_PORT",
    "sip_transport":      "SIP_TRANSPORT",
    "domain":             "SIP_DOMAIN",
    "sip_password":       "SIP_PASSWORD",
    "cps":                "CPS",
    "hold_time_seconds":  "HOLD_TIME_SECONDS",
    "ramp_up_seconds":    "RAMP_UP_SECONDS",
    "metrics_interval":   "METRICS_INTERVAL",
    "metrics_port":       "METRICS_PORT",
    "coordinator_url":    "COORDINATOR_URL",
    "register_rate":      "REGISTER_RATE",
    "register_expires":   "REGISTER_EXPIRES",
    "register_retry":     "REGISTER_RETRY",
    "register_timeout":   "REGISTER_TIMEOUT",
    "max_concurrent_calls": "MAX_CONCURRENT_CALLS",
    "local_host":         "LOCAL_HOST",
    "local_port":         "LOCAL_PORT",
    "peer_stop_url":      "PEER_STOP_URL",
    "rtp_burst_seconds":  "RTP_BURST_SECONDS",
    "rtp_burst_pps":      "RTP_BURST_PPS",
    "rtp_keepalive_interval": "RTP_KEEPALIVE_INTERVAL",
    "pool_wrap_delay_seconds": "POOL_WRAP_DELAY_SECONDS",
    "media_enabled":      "MEDIA_ENABLED",
    "rtp_mode":           "RTP_MODE",
    "rtp_ptime":          "RTP_PTIME",
    "traffic_mode":       "TRAFFIC_MODE",
    "call_count":         "CALL_COUNT",
    "duration_hours":     "DURATION_HOURS",
    "scenario":           "SCENARIO",
    "scenario_hold_duration_seconds": "SCENARIO_HOLD_DURATION_SECONDS",
    "scenario_pre_hold_rtp_seconds":  "SCENARIO_PRE_HOLD_RTP_SECONDS",
    "scenario_post_hold_rtp_seconds": "SCENARIO_POST_HOLD_RTP_SECONDS",
}

# Fields that should be coerced to int
_INT_FIELDS = {
    "uac_ext_start", "uac_ext_end", "uas_ext_start", "uas_ext_end",
    "sbc_port", "cps", "hold_time_seconds", "ramp_up_seconds",
    "metrics_interval", "metrics_port", "register_rate", "register_expires",
    "register_retry", "register_timeout", "max_concurrent_calls", "local_port",
    "rtp_burst_seconds", "rtp_burst_pps", "rtp_keepalive_interval",
    "pool_wrap_delay_seconds", "call_count", "rtp_ptime",
}

# Fields that should be coerced to float
_FLOAT_FIELDS = {"duration_hours", "scenario_hold_duration_seconds", "scenario_pre_hold_rtp_seconds", "scenario_post_hold_rtp_seconds"}

_BOOL_FIELDS = {"media_enabled"}


@dataclass
class VMConfig:
    """All configuration for one VM's traffic run. Zero hardcoded values."""

    vm_role: str            = field(default="UAC")   # "UAC" or "UAS"
    vm_id: str              = field(default="vm-1")
    uac_ext_start: int      = field(default=1001)
    uac_ext_end: int        = field(default=1250)
    uas_ext_start: int      = field(default=2001)
    uas_ext_end: int        = field(default=2250)
    sbc_host: str           = field(default="127.0.0.1")
    sbc_port: int           = field(default=5060)
    sip_transport: str      = field(default="TCP")    # "TCP" | "TLS" | "UDP"
    domain: str             = field(default="sbc.local")
    sip_password: str       = field(default="password")
    cps: int                = field(default=6)
    hold_time_seconds: int  = field(default=180)
    ramp_up_seconds: int    = field(default=30)
    metrics_interval: int   = field(default=10)
    metrics_port: int       = field(default=8080)
    coordinator_url: str    = field(default="http://localhost:8080")
    register_rate: int      = field(default=50)       # max REGISTER/sec during pre-phase
    register_expires: int   = field(default=3600)
    register_retry: int     = field(default=3)
    register_timeout: int   = field(default=5)        # seconds
    max_concurrent_calls: int = field(default=0)      # 0 = CPS × hold_time
    local_host: str         = field(default="")       # empty = auto-detect
    local_port: int         = field(default=0)        # 0 = OS-assigned per ext
    peer_stop_url: str      = field(default="")       # UAC POSTs here when done (UAS /api/test/stop)
    rtp_burst_seconds: int  = field(default=2)        # burst phase duration (seconds)
    rtp_burst_pps: int      = field(default=50)       # burst packet rate (= 1000/ptime)
    rtp_keepalive_interval: int = field(default=5)    # seconds between keepalive packets
    media_enabled: bool     = field(default=True)   # False = signaling-only (no RTP)
    rtp_mode: str           = field(default="3phase")  # "3phase" | "continuous"
    rtp_ptime: int          = field(default=20)        # ptime in ms: 20 (50 PPS) or 40 (25 PPS)
    pool_wrap_delay_seconds: int = field(default=0)  # extra margin beyond auto-computed delay (0 = SIP_BYE_BUFFER only)
    # Traffic run control — GUI or YAML sets one mode; CLI --max-calls overrides all
    traffic_mode: str       = field(default="unlimited")  # "smoke" | "timed" | "unlimited"
    call_count: int         = field(default=0)            # smoke: exact call total (> 0)
    duration_hours: float   = field(default=0.0)          # timed: hours (0.25 = 15 min)
    # Scenario support (Phase 2 placeholder)
    scenario: str                       = field(default="basic_call")  # "basic_call" | "hold_unhold"
    scenario_hold_duration_seconds: float = field(default=5.0)
    scenario_pre_hold_rtp_seconds: float  = field(default=3.0)
    scenario_post_hold_rtp_seconds: float = field(default=3.0)

    # ------------------------------------------------------------------
    # Derived helpers (not serialised as config)
    # ------------------------------------------------------------------
    @property
    def uac_ext_count(self) -> int:
        return self.uac_ext_end - self.uac_ext_start + 1

    @property
    def uas_ext_count(self) -> int:
        return self.uas_ext_end - self.uas_ext_start + 1

    @property
    def pool_wrap_count(self) -> int:
        """LCM of UAC and UAS extension counts — calls per full pool wrap."""
        uac = self.uac_ext_count
        uas = self.uas_ext_count
        return (uac * uas) // math.gcd(uac, uas) if uac and uas else 0

    @property
    def effective_max_concurrent(self) -> int:
        if self.max_concurrent_calls > 0:
            return self.max_concurrent_calls
        return self.cps * self.hold_time_seconds

    @property
    def is_uac(self) -> bool:
        return self.vm_role.upper() == "UAC"

    @property
    def is_uas(self) -> bool:
        return self.vm_role.upper() == "UAS"

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------
    def validate(self) -> None:
        errors: list[str] = []

        if self.vm_role.upper() not in ("UAC", "UAS"):
            errors.append(f"vm_role must be 'UAC' or 'UAS', got '{self.vm_role}'")

        if self.sip_transport.upper() not in ("TCP", "TLS", "UDP"):
            errors.append(
                f"sip_transport must be TCP/TLS/UDP, got '{self.sip_transport}'"
            )

        if self.uac_ext_start > self.uac_ext_end:
            errors.append(
                f"uac_ext_start ({self.uac_ext_start}) > uac_ext_end ({self.uac_ext_end})"
            )

        if self.uas_ext_start > self.uas_ext_end:
            errors.append(
                f"uas_ext_start ({self.uas_ext_start}) > uas_ext_end ({self.uas_ext_end})"
            )

        if self.cps <= 0:
            errors.append(f"cps must be > 0, got {self.cps}")

        if self.hold_time_seconds <= 0:
            errors.append(f"hold_time_seconds must be > 0, got {self.hold_time_seconds}")

        if self.sbc_port <= 0 or self.sbc_port > 65535:
            errors.append(f"sbc_port out of range: {self.sbc_port}")

        if self.rtp_burst_seconds < 0:
            errors.append(f"rtp_burst_seconds must be >= 0, got {self.rtp_burst_seconds}")

        if self.rtp_burst_pps <= 0:
            errors.append(f"rtp_burst_pps must be > 0, got {self.rtp_burst_pps}")

        if self.rtp_keepalive_interval <= 0:
            errors.append(f"rtp_keepalive_interval must be > 0, got {self.rtp_keepalive_interval}")

        if self.rtp_mode not in ("3phase", "continuous"):
            errors.append(f"rtp_mode must be '3phase' or 'continuous', got '{self.rtp_mode}'")

        if self.rtp_ptime not in (20, 40):
            errors.append(f"rtp_ptime must be 20 or 40, got {self.rtp_ptime}")

        if self.traffic_mode not in ("smoke", "timed", "unlimited"):
            errors.append(
                f"traffic_mode must be 'smoke', 'timed', or 'unlimited', got '{self.traffic_mode}'"
            )

        if self.traffic_mode == "smoke" and self.call_count <= 0:
            errors.append("traffic_mode='smoke' requires call_count > 0")

        if self.traffic_mode == "timed" and self.duration_hours <= 0:
            errors.append("traffic_mode='timed' requires duration_hours > 0")

        if errors:
            raise ValueError("VMConfig validation failed:\n  " + "\n  ".join(errors))

        self.vm_role = self.vm_role.upper()
        self.sip_transport = self.sip_transport.upper()

        concurrent = self.effective_max_concurrent
        log.info(
            "VMConfig OK | role=%s vm_id=%s sbc=%s:%d transport=%s "
            "cps=%d hold=%ds ext=%d-%d concurrent_estimate=%d",
            self.vm_role, self.vm_id, self.sbc_host, self.sbc_port,
            self.sip_transport, self.cps, self.hold_time_seconds,
            self.uac_ext_start, self.uac_ext_end, concurrent,
        )


# ---------------------------------------------------------------------------
# Loader: ENV -> YAML -> defaults
# ---------------------------------------------------------------------------

def load_config(yaml_path: str | None = None) -> VMConfig:
    """
    Build a VMConfig using priority: ENV VARS > YAML file > defaults.

    Args:
        yaml_path: Optional path to a YAML config file.

    Returns:
        A validated VMConfig instance.
    """
    # Start with defaults
    values: dict[str, Any] = dict(_DEFAULTS)

    # Layer 1: YAML file
    if yaml_path:
        values = _apply_yaml(values, yaml_path)

    # Layer 2: Environment variables (highest priority)
    values = _apply_env(values)

    # Coerce types
    for key in _INT_FIELDS:
        if key in values and values[key] is not None:
            values[key] = int(values[key])
    for key in _FLOAT_FIELDS:
        if key in values and values[key] is not None:
            values[key] = float(values[key])
    for key in _BOOL_FIELDS:
        if key in values and values[key] is not None:
            if isinstance(values[key], str):
                values[key] = values[key].lower() in ("true", "1", "yes")

    # Build dataclass (only pass known fields)
    known = {f.name for f in fields(VMConfig)}
    cfg = VMConfig(**{k: v for k, v in values.items() if k in known})
    cfg.validate()
    return cfg


def _apply_yaml(base: dict[str, Any], yaml_path: str) -> dict[str, Any]:
    try:
        import yaml  # type: ignore
    except ImportError:
        raise ImportError(
            "PyYAML is required for YAML config loading: pip install pyyaml"
        )

    if not os.path.isfile(yaml_path):
        raise FileNotFoundError(f"Config file not found: {yaml_path}")

    with open(yaml_path, "r") as fh:
        data = yaml.safe_load(fh) or {}

    if not isinstance(data, dict):
        raise ValueError(f"YAML config must be a mapping, got {type(data)}")

    merged = dict(base)
    for key, value in data.items():
        if key in merged or key in _DEFAULTS:
            merged[key] = value
        else:
            log.warning("Unknown config key in YAML (ignored): %s", key)

    log.debug("Applied YAML config from %s", yaml_path)
    return merged


def _apply_env(base: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    applied: list[str] = []

    for field_name, env_name in _ENV_MAP.items():
        value = os.environ.get(env_name)
        if value is not None:
            merged[field_name] = value
            applied.append(f"{env_name}={value!r}")

    if applied:
        log.debug("Applied env vars: %s", ", ".join(applied))

    return merged


# ---------------------------------------------------------------------------
# Config from dict (API JSON body) and YAML writer
# ---------------------------------------------------------------------------

def config_from_dict(data: dict[str, Any]) -> VMConfig:
    """
    Build a validated VMConfig from a raw dictionary (e.g. API JSON body).
    Starts with defaults, overlays the provided data, coerces types, validates.
    Unknown keys (vm_ip, ssh_user, etc.) are silently ignored.
    """
    values = dict(_DEFAULTS)
    known_keys = {f.name for f in fields(VMConfig)} | set(_DEFAULTS.keys())
    for key, value in data.items():
        if key in known_keys and value is not None:
            values[key] = value

    for key in _INT_FIELDS:
        if key in values and values[key] is not None:
            try:
                values[key] = int(values[key])
            except (ValueError, TypeError):
                pass
    for key in _FLOAT_FIELDS:
        if key in values and values[key] is not None:
            try:
                values[key] = float(values[key])
            except (ValueError, TypeError):
                pass
    for key in _BOOL_FIELDS:
        if key in values and values[key] is not None:
            if isinstance(values[key], str):
                values[key] = values[key].lower() in ("true", "1", "yes")

    known = {f.name for f in fields(VMConfig)}
    cfg = VMConfig(**{k: v for k, v in values.items() if k in known})
    cfg.validate()
    return cfg


def write_config_yaml(config: VMConfig, path: str) -> str:
    """
    Serialize a VMConfig to a YAML file.  Returns the absolute path written.
    """
    try:
        import yaml  # type: ignore
    except ImportError:
        raise ImportError("PyYAML required: pip install pyyaml")

    from dataclasses import asdict
    import datetime as _dt

    data = asdict(config)
    header = (
        f"# Auto-generated by GUI — {config.vm_role} config\n"
        f"# {_dt.datetime.now().isoformat()}\n\n"
    )

    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)

    with open(path, "w", encoding="utf-8") as fh:
        fh.write(header)
        yaml.dump(data, fh, default_flow_style=False, sort_keys=False)

    abs_path = os.path.abspath(path)
    log.info("Config YAML written to %s", abs_path)
    return abs_path
