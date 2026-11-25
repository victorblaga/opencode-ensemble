#!/usr/bin/env python3
"""Wait in the lead's background shell until its Ensemble team needs attention."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import os
from pathlib import Path
import signal
import sqlite3
import time


POLL_SECONDS = 2
BATCH_SECONDS = 15


def pid_alive(path):
    try:
        pid = int(path.read_text())
        if pid <= 0:
            return False
        os.kill(pid, 0)
    except PermissionError:
        return True
    except (ValueError, FileNotFoundError, ProcessLookupError, OverflowError):
        return False
    return True


@contextmanager
def pid_lock(path):
    """Serialize stale-file removal and exclusive creation across waiters."""
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def acquire(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with pid_lock(path):
        if pid_alive(path):
            return False
        path.unlink(missing_ok=True)
        with path.open("x") as stream:
            stream.write(f"{os.getpid()}\n")
        return True


def log(state, message):
    try:
        with (state / "ensemble.log").open("a") as stream:
            stream.write(f"{datetime.now(timezone.utc).isoformat()} pid={os.getpid()} {message}\n")
    except OSError:
        pass


def poll(db, team_id, max_minutes):
    started = time.monotonic()
    messages_since = quiet_since = None
    first = True
    while True:
        now = time.monotonic()
        team = db.execute("SELECT status FROM team WHERE id = ?", (team_id,)).fetchone()
        if not team or team["status"] != "active":
            return "closed"
        if now - started >= max_minutes * 60:
            return "timeout"
        working = db.execute(
            "SELECT 1 FROM team_member WHERE team_id = ? AND status IN ('busy', 'shutdown_requested') LIMIT 1",
            (team_id,),
        ).fetchone()
        messages = db.execute(
            """SELECT 1 FROM team_message WHERE team_id = ? AND to_name = 'lead'
               AND read = 0 AND delivered = 0 AND wake_suppressed = 0 LIMIT 1""",
            (team_id,),
        ).fetchone()
        if first and not working and not messages:
            return "quiet (no working teammates or unseen messages)"
        first = False
        messages_since = (messages_since or now) if messages else None
        quiet_since = (quiet_since or now) if not working else None
        if messages_since is not None and now - messages_since >= BATCH_SECONDS:
            return "messages"
        if quiet_since is not None and now - quiet_since >= BATCH_SECONDS:
            return "quiet"
        deadlines = [now + POLL_SECONDS, started + max_minutes * 60]
        deadlines.extend(since + BATCH_SECONDS for since in (messages_since, quiet_since) if since is not None)
        time.sleep(max(0, min(deadlines) - now))


def digest(db, team, reason):
    print(f'Team {team["name"]}: {reason}.')
    now = time.time()
    for member in db.execute(
        "SELECT name, status, time_updated FROM team_member WHERE team_id = ? ORDER BY name", (team["id"],)
    ):
        minutes = max(0, int((now - member["time_updated"] / 1000) / 60))
        print(f'  {member["name"]}: {member["status"]}, updated {minutes}m ago')
    senders = db.execute(
        """SELECT from_name, COUNT(*) AS count FROM team_message
           WHERE team_id = ? AND to_name = 'lead' AND read = 0 GROUP BY from_name ORDER BY from_name""",
        (team["id"],),
    ).fetchall()
    summary = ", ".join(f'{row["from_name"]}: {row["count"]}' for row in senders)
    print(f'Unread messages: {sum(row["count"] for row in senders)}' + (f" ({summary})" if summary else ""))
    print("If teammates are still working when this turn ends, start the waiter again in the background.")


def stop(_signum, _frame):
    raise SystemExit(0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--team")
    parser.add_argument("--max-minutes", type=float, default=180)
    parser.add_argument("--db", type=Path, default=Path.home() / ".config" / "opencode" / "ensemble.db")
    args = parser.parse_args()
    state = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / "opencode-ensemble"
    key = "id" if args.team else "lead_session_id"
    identity = args.team or os.environ.get("OPENCODE_SESSION_ID")
    try:
        db = sqlite3.connect(f"{args.db.resolve().as_uri()}?mode=ro", uri=True)
        db.row_factory = sqlite3.Row
        team = db.execute(f"SELECT id, name FROM team WHERE {key} = ? AND status = 'active'", (identity,)).fetchone()
        if not team:
            print("This session leads no active Ensemble team.")
            return 2
        pid_file = state / "waiters" / team["id"]
        if not acquire(pid_file):
            print(f'A waiter is already running for team {team["name"]}.')
            return 0
        try:
            signal.signal(signal.SIGTERM, stop)
            log(state, f'waiter:start team={team["id"]}')
            reason = poll(db, team["id"], args.max_minutes)
            digest(db, team, reason)
            log(state, f'waiter:exit team={team["id"]} reason={reason}')
        finally:
            with pid_lock(pid_file):
                pid_file.unlink(missing_ok=True)
        return 0
    except (OSError, sqlite3.Error) as err:
        print(f"Cannot wait for Ensemble: {err}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
