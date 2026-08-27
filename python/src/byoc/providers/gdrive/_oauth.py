"""Google OAuth 2.0 client with PKCE.

BYOC defaults to the ``drive.file`` scope, which grants access only to files the
app created or the user explicitly opened with it. That keeps applications out
of Google's Restricted Scope security assessment entirely.
"""

from __future__ import annotations

import time
from urllib.parse import urlencode

import httpx

from ...errors import AuthRequiredError, InvalidInputError, TokenExpiredError
from ._tokens import InMemoryTokenStorage, TokenSession, TokenStorage

AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke"


class GoogleDriveScope:
    """Scopes BYOC supports. ``FILE`` is the default and the safe choice."""

    FILE = "https://www.googleapis.com/auth/drive.file"
    APP_DATA = "https://www.googleapis.com/auth/drive.appdata"
    FILE_READONLY = "https://www.googleapis.com/auth/drive.file.readonly"


class GoogleOAuthClient:
    """Drives the OAuth flow and keeps the access token fresh.

    Args:
        client_id: OAuth client id from the Google Cloud console.
        client_secret: Only for confidential (server-side) clients. Public
            clients use PKCE instead and must not embed a secret.
        redirect_uri: Redirect registered with the OAuth client.
        scopes: Defaults to ``[GoogleDriveScope.FILE]``.
        token_storage: Where sessions persist. Defaults to in-memory.
        session: An existing session, for pre-authenticated callers.
        client: An ``httpx.AsyncClient`` to reuse.
    """

    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str | None = None,
        redirect_uri: str | None = None,
        scopes: list[str] | None = None,
        token_storage: TokenStorage | None = None,
        session: TokenSession | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not client_id:
            raise InvalidInputError(
                "GoogleOAuthClient requires a 'client_id'.", provider="google-drive"
            )

        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri
        self.scopes = scopes or [GoogleDriveScope.FILE]
        self.storage: TokenStorage = token_storage or InMemoryTokenStorage()

        if session is not None:
            self.storage.set(session)

        self._client = client
        self._owns_client = client is None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(30.0))
            self._owns_client = True
        return self._client

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    # -- authorization -----------------------------------------------------

    def get_authorization_url(
        self,
        *,
        state: str | None = None,
        code_challenge: str | None = None,
        code_challenge_method: str = "S256",
        redirect_uri: str | None = None,
        prompt: str = "consent",
        access_type: str = "offline",
        scopes: list[str] | None = None,
    ) -> str:
        """Build the URL to send the user to for consent.

        ``access_type="offline"`` with ``prompt="consent"`` is what makes Google
        return a refresh token; without both, the session dies in an hour and
        cannot be renewed.
        """
        target_redirect = redirect_uri or self.redirect_uri
        if not target_redirect:
            raise InvalidInputError(
                "A 'redirect_uri' is required to build the authorization URL.",
                provider="google-drive",
            )

        params = {
            "client_id": self.client_id,
            "redirect_uri": target_redirect,
            "response_type": "code",
            "scope": " ".join(scopes or self.scopes),
            "access_type": access_type,
            "prompt": prompt,
            "include_granted_scopes": "true",
        }
        if state:
            params["state"] = state
        if code_challenge:
            params["code_challenge"] = code_challenge
            params["code_challenge_method"] = code_challenge_method

        return f"{AUTH_ENDPOINT}?{urlencode(params)}"

    async def exchange_code(
        self, *, code: str, code_verifier: str | None = None, redirect_uri: str | None = None
    ) -> TokenSession:
        """Exchange an authorization code for a session, and store it."""
        target_redirect = redirect_uri or self.redirect_uri
        if not target_redirect:
            raise InvalidInputError(
                "A 'redirect_uri' is required to exchange an authorization code.",
                provider="google-drive",
            )

        form = {
            "client_id": self.client_id,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": target_redirect,
        }
        if self.client_secret:
            form["client_secret"] = self.client_secret
        if code_verifier:
            form["code_verifier"] = code_verifier

        payload = await self._post_token(form, "Authorization code exchange failed")
        session = self._session_from_payload(payload, existing_refresh_token=None)
        self.storage.set(session)
        return session

    async def refresh_access_token(self, refresh_token: str | None = None) -> TokenSession:
        """Mint a fresh access token from the stored refresh token."""
        stored = self.storage.get()
        token = refresh_token or (stored.refresh_token if stored else None)

        if not token:
            raise AuthRequiredError(
                "No refresh token available; the user must authorize again.",
                provider="google-drive",
            )

        form = {
            "client_id": self.client_id,
            "refresh_token": token,
            "grant_type": "refresh_token",
        }
        if self.client_secret:
            form["client_secret"] = self.client_secret

        payload = await self._post_token(form, "Token refresh failed")
        # Google omits refresh_token on refresh responses; keep the existing one.
        session = self._session_from_payload(payload, existing_refresh_token=token)
        self.storage.set(session)
        return session

    async def get_access_token(self) -> str:
        """Return a valid access token, refreshing it if needed."""
        session = self.storage.get()
        if session is None:
            raise AuthRequiredError(
                "No Google Drive session. Complete the OAuth flow first.",
                provider="google-drive",
            )
        if not session.is_expired:
            return session.access_token

        refreshed = await self.refresh_access_token()
        return refreshed.access_token

    async def has_valid_session(self) -> bool:
        """Whether a usable session exists, without raising."""
        session = self.storage.get()
        if session is None:
            return False
        if not session.is_expired:
            return True
        return session.refresh_token is not None

    async def set_session(self, session: TokenSession) -> None:
        self.storage.set(session)

    async def revoke(self) -> None:
        """Revoke the token with Google and clear local storage.

        Storage is cleared even if the remote call fails, so a revoked or
        already-invalid token cannot linger on disk.
        """
        session = self.storage.get()
        token = (session.refresh_token or session.access_token) if session else None
        try:
            if token:
                await self._http().post(REVOKE_ENDPOINT, data={"token": token})
        finally:
            self.storage.clear()

    # -- internals ---------------------------------------------------------

    async def _post_token(self, form: dict[str, str], failure_message: str) -> dict[str, object]:
        response = await self._http().post(TOKEN_ENDPOINT, data=form)
        if response.is_error:
            detail = ""
            try:
                body = response.json()
                detail = f"{body.get('error', '')}: {body.get('error_description', '')}".strip(": ")
            except ValueError:
                detail = response.text[:200]

            # invalid_grant means the refresh token is dead: re-consent required.
            if response.status_code in (400, 401) and "invalid_grant" in detail:
                raise TokenExpiredError(
                    f"{failure_message} (invalid_grant): the user must authorize again.",
                    provider="google-drive",
                    status_code=response.status_code,
                )
            raise AuthRequiredError(
                f"{failure_message} (HTTP {response.status_code}): {detail}",
                provider="google-drive",
                status_code=response.status_code,
            )

        payload: dict[str, object] = response.json()
        return payload

    @staticmethod
    def _session_from_payload(
        payload: dict[str, object], *, existing_refresh_token: str | None
    ) -> TokenSession:
        expires_in = payload.get("expires_in")
        expires_at = time.time() + float(expires_in) if expires_in is not None else None  # type: ignore[arg-type]

        return TokenSession(
            access_token=str(payload["access_token"]),
            refresh_token=str(payload["refresh_token"])
            if payload.get("refresh_token")
            else existing_refresh_token,
            expires_at=expires_at,
            token_type=str(payload.get("token_type") or "Bearer"),
            scope=str(payload["scope"]) if payload.get("scope") else None,
        )
