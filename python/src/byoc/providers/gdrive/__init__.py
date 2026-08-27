"""Google Drive provider for BYOC.

Stores your application's files in the Drive account the user already owns,
using the non-restricted ``drive.file`` scope.
"""

from __future__ import annotations

from ._http import DriveHttpClient
from ._oauth import GoogleDriveScope, GoogleOAuthClient
from ._pkce import generate_code_challenge, generate_code_verifier, generate_oauth_state
from ._resolver import (
    VIRTUAL_PATH_PROPERTY,
    DrivePathResolver,
    LruTtlPathCache,
    escape_drive_query_value,
)
from ._tokens import (
    EncryptedFileTokenStorage,
    InMemoryTokenStorage,
    TokenSession,
    TokenStorage,
)
from .adapter import GoogleDriveProvider

__all__ = [
    "VIRTUAL_PATH_PROPERTY",
    "DriveHttpClient",
    "DrivePathResolver",
    "EncryptedFileTokenStorage",
    "GoogleDriveProvider",
    "GoogleDriveScope",
    "GoogleOAuthClient",
    "InMemoryTokenStorage",
    "LruTtlPathCache",
    "TokenSession",
    "TokenStorage",
    "escape_drive_query_value",
    "generate_code_challenge",
    "generate_code_verifier",
    "generate_oauth_state",
]
