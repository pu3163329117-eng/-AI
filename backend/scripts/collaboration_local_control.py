"""Windows console signalling for precisely identified local uvicorn processes.

Never falls back to terminating an existing service. An owned crash-test child
is handled separately by the acceptance supervisor.
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import os
import time


def signal_console(pid: int, *, dry_run: bool = False) -> dict:
    if os.name != "nt":
        raise RuntimeError("WINDOWS_CONSOLE_REQUIRED")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.FreeConsole()
    if not kernel.AttachConsole(pid):
        raise RuntimeError(f"ATTACH_CONSOLE_FAILED:{ctypes.get_last_error()}")
    handler_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)
    handler = handler_type(lambda _event: True)
    kernel.SetConsoleCtrlHandler(handler, True)
    try:
        process_ids = (wintypes.DWORD * 64)()
        count = kernel.GetConsoleProcessList(process_ids, 64)
        members = list(process_ids[:count])
        # Broadcast Ctrl+C is safe only when this helper and the exact backend
        # are the only clients attached to that console.
        if set(members) != {pid, os.getpid()}:
            raise RuntimeError(f"CONSOLE_SHARED_REFUSE_SIGNAL:{members}")
        if not dry_run and not kernel.GenerateConsoleCtrlEvent(0, 0):
            raise RuntimeError(f"CTRL_C_FAILED:{ctypes.get_last_error()}")
        if not dry_run:
            # Deliver the asynchronous control event while our ignore handler
            # is still installed on the attached console.
            time.sleep(0.2)
        return {"target_pid": pid, "console_members": members, "signal": "dry-run" if dry_run else "CTRL_C"}
    finally:
        kernel.FreeConsole()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("pid", type=int)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    print(json.dumps(signal_console(args.pid, dry_run=args.dry_run)), flush=True)
