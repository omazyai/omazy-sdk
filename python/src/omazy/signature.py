"""Verifying a request Omazy sent to your server.

Every flow, tool, context and callback request is signed:

    X-Omazy-Signature: sha256=<hex hmac-sha256(secret, raw body)>

Verify over the raw bytes you received, before parsing them.
"""

import hashlib
import hmac
from typing import Optional, Union


def sign(secret: str, body: Union[bytes, str]) -> str:
    """The signature header value for a body."""
    raw = body.encode("utf-8") if isinstance(body, str) else body
    return "sha256=" + hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()


def verify_signature(secret: str, body: Union[bytes, str], header: Optional[str]) -> bool:
    """True when ``header`` is the platform's signature over exactly ``body``."""
    got = (header or "").strip()
    if not secret or not got:
        return False
    return hmac.compare_digest(got, sign(secret, body))
