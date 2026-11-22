"""Client for the Omazy Core API and its MCP server."""

from .client import DEFAULT_BASE_URL, UNSET, VERSION, McpClient, Omazy, ResponseInfo, read_sse
from .enterprise import DEFAULT_ENTERPRISE_BASE_URL, ENTERPRISE_REPEATABLE, ENTERPRISE_ROUTES, OmazyEnterprise
from .errors import OmazyError
from .routes import IDEMPOTENT, RETRYABLE, ROUTES, WEBSOCKET
from .signature import sign, verify_signature
from .stt import TranscriptionSession

__version__ = VERSION
__all__ = [
    "DEFAULT_BASE_URL",
    "DEFAULT_ENTERPRISE_BASE_URL",
    "ENTERPRISE_REPEATABLE",
    "ENTERPRISE_ROUTES",
    "IDEMPOTENT",
    "McpClient",
    "Omazy",
    "OmazyEnterprise",
    "OmazyError",
    "RETRYABLE",
    "ROUTES",
    "ResponseInfo",
    "TranscriptionSession",
    "UNSET",
    "read_sse",
    "sign",
    "verify_signature",
    "WEBSOCKET",
]
