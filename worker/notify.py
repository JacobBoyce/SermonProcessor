"""Email the person who started a run when it finishes ("Email me when it's done").

Sends through the Gmail API from the Google account that made NOTIFY_REFRESH_TOKEN
(scope https://www.googleapis.com/auth/gmail.send), using the same OAuth client as Drive.
A problem sending is reported in the log but never fails the run.

Needs: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, NOTIFY_REFRESH_TOKEN.
"""

from __future__ import annotations

import base64
import os
from email.message import EmailMessage

import requests

TOKEN_URL = "https://oauth2.googleapis.com/token"
SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"


class NotifyError(Exception):
    pass


def missing_settings() -> list[str]:
    return [k for k in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "NOTIFY_REFRESH_TOKEN")
            if not os.environ.get(k, "").strip()]


def _token() -> str:
    r = requests.post(TOKEN_URL, timeout=30, data={
        "client_id": os.environ["GOOGLE_CLIENT_ID"].strip(),
        "client_secret": os.environ["GOOGLE_CLIENT_SECRET"].strip(),
        "refresh_token": os.environ["NOTIFY_REFRESH_TOKEN"].strip(),
        "grant_type": "refresh_token",
    })
    if r.status_code != 200:
        raise NotifyError(f"email sign-in failed ({r.text[:120]}). Check the NOTIFY_REFRESH_TOKEN secret.")
    return r.json()["access_token"]


def run_link() -> str:
    server, repo, run = (os.environ.get(k, "") for k in ("GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID"))
    return f"{server}/{repo}/actions/runs/{run}" if server and repo and run else ""


def compose(to: str, label: str, ok: bool, results: dict, error: str = "", app: str = "") -> EmailMessage:
    """Build the message: what finished, what happened in each step, and where to look."""
    what = label or "Your Sermon Processor run"
    lines = [f"{what} {'finished' if ok else 'failed'}.", ""]
    for text in results.values():
        lines.append(("Problem: " + text[1:].strip()) if text.startswith("!") else ("Done: " + text))
    if error:
        lines += ["", f"What went wrong: {error}"]
    lines.append("")
    if app:
        lines.append(f"Open the app: {app}")
    link = run_link()
    if link:
        lines.append(f"Run details: {link}")
    lines += ["", "You asked to be emailed when this was done. Untick “Email me when it's done” in the app to stop."]
    msg = EmailMessage()
    msg["To"] = to
    msg["Subject"] = f"{'Done' if ok else 'Failed'}: {what}"
    msg.set_content("\n".join(lines))
    return msg


def send(to: str, label: str, ok: bool, results: dict, error: str = "", app: str = "") -> None:
    missing = missing_settings()
    if missing:
        raise NotifyError("email sending isn't set up yet (missing GitHub secret " + ", ".join(missing) + ")")
    msg = compose(to, label, ok, results, error, app)
    # No From header: Gmail sends from the account that made the token.
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    r = requests.post(SEND_URL, json={"raw": raw}, timeout=30, headers={"Authorization": f"Bearer {_token()}"})
    if r.status_code not in (200, 202):
        raise NotifyError(f"Gmail said {r.status_code}: {r.text[:200]}")
