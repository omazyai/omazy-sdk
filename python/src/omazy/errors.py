from typing import Optional


class OmazyError(Exception):
    """A refusal or failure from the Core API. Branch on ``code``, log the message.

    ``status`` is the HTTP status, or 0 when no response arrived. ``request_id``
    is the X-Request-Id of the response; quote it when reporting a failure.
    ``retry_after`` is the number of seconds the API asked the caller to wait.
    """

    def __init__(
        self,
        message: str,
        status: int,
        code: str,
        request_id: Optional[str] = None,
        retry_after: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.request_id = request_id
        self.retry_after = retry_after

    def __repr__(self) -> str:
        return f"OmazyError(status={self.status}, code={self.code!r}, message={self.message!r})"
