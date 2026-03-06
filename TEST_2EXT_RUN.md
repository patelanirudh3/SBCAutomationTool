# 2-Extension Single-Machine Test

Use these commands from your laptop to test the traffic engine against your lab (SBC 10.133.63.117, Kamailio, extensions 4001000/4001001).

## Step 1: Dry run (validate config, no network)

```bash
python -m callflow_tool.traffic.main --config uas.yaml --dry-run
python -m callflow_tool.traffic.main --config uac.yaml --dry-run
```

## Step 2: Run UAS + UAC (2 terminals)

**Terminal 1 — start UAS first (auto-answers incoming INVITEs):**

```bash
python -m callflow_tool.traffic.main --config uas.yaml --log-level DEBUG
```

**Terminal 2 — start UAC (sends INVITEs to 4001001 via SBC):**

```bash
python -m callflow_tool.traffic.main --config uac.yaml --log-level DEBUG
```

## Step 3: Single-process test (UAC only)

If you only want to test the UAC path against an existing UAS (e.g. J179 emulator):

```bash
python -m callflow_tool.traffic.main --config test_2ext.yaml --skip-subscribe --log-level DEBUG
```

## Config files

| File           | Role | Metrics port |
|----------------|------|--------------|
| `test_2ext.yaml` | UAC  | 8080         |
| `uas.yaml`       | UAS  | 8081         |
| `uac.yaml`       | UAC  | 8082         |

## Stop

Press `Ctrl+C` in each terminal. The engine will unregister and close sockets gracefully.
