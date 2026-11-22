"""Client for the Omazy Enterprise API: one workspace per customer. Standard library only."""

import json
import time
import urllib.request
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional

from .client import DEFAULT_BASE_URL, VERSION, Omazy, ResponseInfo, _build_url, _drop_none, _request

DEFAULT_ENTERPRISE_BASE_URL = "https://mw.omazy.ai/api/v1/enterprise"

Json = Dict[str, Any]

#: Every Enterprise API route this client covers, keyed by the name the
#: contract gives it (contracts/enterprise-api.routes.json). The tests hold the
#: table to the contract.
ENTERPRISE_ROUTES = {
    "account": ("GET", "/account"),
    "workspaces.list": ("GET", "/workspaces"),
    "workspaces.create": ("POST", "/workspaces"),
    "workspaces.get": ("GET", "/workspaces/{id}"),
    "workspaces.update": ("PATCH", "/workspaces/{id}"),
    "workspaces.close": ("DELETE", "/workspaces/{id}"),
    "workspaces.rotate_install": ("POST", "/workspaces/{id}/install/rotate"),
    "usage": ("GET", "/usage"),
}

#: Routes the client sends again after a 429, a gateway error or a dropped
#: connection. Creating a workspace is one of them: external_id names the
#: customer, so a second request finds the workspace the first one made.
#: Rotating a token is not: each run replaces the token before it.
ENTERPRISE_REPEATABLE = frozenset(
    {
        "account",
        "workspaces.list",
        "workspaces.create",
        "workspaces.get",
        "workspaces.update",
        "workspaces.close",
        "usage",
    }
)


class OmazyEnterprise:
    """Creates and runs the workspaces of your customers, one each.

    >>> account = OmazyEnterprise(os.environ["OMAZY_ACCOUNT_KEY"])
    >>> made = account.workspaces.create(external_id="cust_42", name="Acme Bank")
    >>> if made["token"]:
    ...     save_token_for("cust_42", made["token"])  # shown once
    >>> acme = account.core(token_for("cust_42"))
    >>> acme.knowledge.documents.create(title="Opening hours", content="9 to 5")

    ``token`` is an account key, ``eak_<prefix>.<secret>``. Keep it on a server.
    An account key never calls a model: each workspace has its own install
    token for the Core API, and ``core(token)`` gives you the client for it.
    """

    def __init__(
        self,
        token: str,
        base_url: str = DEFAULT_ENTERPRISE_BASE_URL,
        max_retries: int = 2,
        timeout: float = 60.0,
        opener: Optional[Callable[..., Any]] = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not token:
            raise ValueError("OmazyEnterprise: token is required")
        self._token = token
        self._base = base_url.rstrip("/")
        self._max_retries = max_retries
        self._timeout = timeout
        self._opener = opener
        self._open = opener or urllib.request.urlopen
        self._sleep = sleep
        # The Core API of the same deployment: .../enterprise becomes .../core.
        suffix = "/enterprise"
        self._core_base = self._base[: -len(suffix)] + "/core" if self._base.endswith(suffix) else DEFAULT_BASE_URL
        #: Headers of the most recent response.
        self.last = ResponseInfo()

        self.workspaces = _Workspaces(self)

    def account(self) -> Json:
        """The account behind the key, its limits, how many workspaces it manages, and the key. Needs no scope."""
        return self._json("account")

    def usage(
        self,
        from_: Optional[str] = None,
        to: Optional[str] = None,
        status: Optional[str] = None,
        external_id: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> Json:
        """Usage and cost per UTC day of one page of the account's workspaces,
        with the account's totals over all of them:
        ``{"from", "to", "totals", "workspaces": [...], "next_cursor"}``.
        ``next_cursor`` is absent on the last page. The last 30 days by
        default, at most 90. Needs ``usage:read``."""
        res = self._send(
            "usage",
            query={
                "from": from_,
                "to": to,
                "status": status,
                "external_id": external_id,
                "cursor": cursor,
                "limit": str(limit) if limit else None,
            },
        )
        out: Json = dict(res.get("data") or {})
        next_cursor = (res.get("meta") or {}).get("next_cursor")
        if next_cursor:
            out["next_cursor"] = next_cursor
        return out

    def core(self, install_token: str, **options: Any) -> Omazy:
        """A Core API client for one customer, from that customer's install
        token. It talks to the same deployment as this client. ``options`` are
        those of :class:`Omazy`, such as ``app``."""
        options.setdefault("base_url", self._core_base)
        options.setdefault("opener", self._opener)
        options.setdefault("sleep", self._sleep)
        return Omazy(install_token, **options)

    # -- plumbing -----------------------------------------------------------

    def _send(
        self,
        route: str,
        path: Optional[Mapping[str, str]] = None,
        query: Optional[Mapping[str, Optional[str]]] = None,
        body: Optional[Json] = None,
    ) -> Any:
        method, template = ENTERPRISE_ROUTES[route]
        url = _build_url(self._base, template, path, query)
        headers = {"Authorization": "Bearer " + self._token, "User-Agent": "omazy-sdk-python/" + VERSION}
        data: Optional[bytes] = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        attempts = self._max_retries if route in ENTERPRISE_REPEATABLE else 0
        res = _request(self, method, url, data, headers, attempts, False, "the Enterprise API")
        parsed = json.loads(res.read() or b"{}")
        return parsed if isinstance(parsed, dict) else {"data": parsed}

    def _json(self, route: str, **kw: Any) -> Any:
        return self._send(route, **kw).get("data")


class _Workspaces:
    def __init__(self, client: OmazyEnterprise) -> None:
        self._c = client

    def create(
        self,
        external_id: str,
        name: str,
        handle: Optional[str] = None,
        brand_color: Optional[str] = None,
        logo_url: Optional[str] = None,
    ) -> Json:
        """Creates the workspace of a customer, with its agent, its plan and
        its install.

        ``external_id`` is your own id for the customer. The same id always
        names the same workspace, so the call is safe to repeat: a repeat
        returns ``created: False`` and no token. The install token is in the
        answer once, on the call that minted it. Needs ``workspaces:manage``;
        the install is minted when the key also holds ``installs:manage``.
        """
        return self._c._json(
            "workspaces.create",
            body=_drop_none(
                {"external_id": external_id, "name": name, "handle": handle, "brand_color": brand_color, "logo_url": logo_url}
            ),
        )

    def list(
        self,
        status: Optional[str] = None,
        external_id: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> Json:
        """One page of the account's workspaces, newest first:
        ``{"workspaces": [...], "next_cursor": "..."}``. ``next_cursor`` is
        absent on the last page. Needs ``workspaces:manage``."""
        res = self._c._send(
            "workspaces.list",
            query={"status": status, "external_id": external_id, "cursor": cursor, "limit": str(limit) if limit else None},
        )
        page: Json = {"workspaces": res.get("data") or []}
        next_cursor = (res.get("meta") or {}).get("next_cursor")
        if next_cursor:
            page["next_cursor"] = next_cursor
        return page

    def all(self, status: Optional[str] = None, limit: Optional[int] = None) -> Iterator[Json]:
        """Every workspace of the account, page by page."""
        cursor: Optional[str] = None
        while True:
            page = self.list(status=status, limit=limit, cursor=cursor)
            for w in page["workspaces"]:
                yield w
            cursor = page.get("next_cursor")
            if not cursor:
                return

    def get(self, workspace_id: str) -> Json:
        """One workspace by its id. Needs ``workspaces:manage``."""
        return self._c._json("workspaces.get", path={"id": workspace_id})

    def find_by_external_id(self, external_id: str) -> Optional[Json]:
        """The workspace of a customer by your own id for them, or None."""
        found: List[Json] = self.list(external_id=external_id)["workspaces"]
        return found[0] if found else None

    def update(
        self,
        workspace_id: str,
        name: Optional[str] = None,
        brand_color: Optional[str] = None,
        logo_url: Optional[str] = None,
        status: Optional[str] = None,
    ) -> Json:
        """Rename, rebrand, suspend or resume. ``status`` is ``active`` or
        ``suspended``; ``active`` on a closed workspace reopens it. Needs
        ``workspaces:manage``."""
        return self._c._json(
            "workspaces.update",
            path={"id": workspace_id},
            body=_drop_none({"name": name, "brand_color": brand_color, "logo_url": logo_url, "status": status}),
        )

    def suspend(self, workspace_id: str) -> Json:
        """Stop serving a workspace. Its Core calls are refused within about
        30 seconds; a call in progress finishes."""
        return self.update(workspace_id, status="suspended")

    def resume(self, workspace_id: str) -> Json:
        """Serve a suspended workspace again, or reopen a closed one."""
        return self.update(workspace_id, status="active")

    def close(self, workspace_id: str) -> Json:
        """Close a workspace. Nothing is erased, and ``resume`` reopens it.
        Needs ``workspaces:manage``."""
        return self._c._json("workspaces.close", path={"id": workspace_id})

    def rotate_install(
        self,
        workspace_id: str,
        overlap_hours: Optional[int] = None,
        expires_in_days: Optional[int] = None,
    ) -> Json:
        """A new install token for the workspace: ``{"install": {...},
        "token": "cai_..."}``. The old token keeps working for
        ``overlap_hours`` (24 by default, 0 cuts it off). A workspace with no
        install gets one. The client never sends this twice: each run replaces
        the token before it. Needs ``installs:manage``."""
        return self._c._json(
            "workspaces.rotate_install",
            path={"id": workspace_id},
            body=_drop_none({"overlap_hours": overlap_hours, "expires_in_days": expires_in_days}),
        )
