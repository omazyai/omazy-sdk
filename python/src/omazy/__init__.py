"""Client for the Omazy Core API and its MCP server."""

from .client import DEFAULT_BASE_URL, VERSION, McpClient, Omazy, ResponseInfo, read_sse
from .errors import OmazyError
from .routes import RETRYABLE, ROUTES
from .signature import sign, verify_signature

__version__ = VERSION
__all__ = [
    "DEFAULT_BASE_URL",
    "McpClient",
    "Omazy",
    "OmazyError",
    "RETRYABLE",
    "ROUTES",
    "ResponseInfo",
    "read_sse",
    "sign",
    "verify_signature",
]
