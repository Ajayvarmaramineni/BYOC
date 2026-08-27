"""Virtual path normalization and RFC 3986 encoding.

These functions decide which folder bytes land in and what object key they are
stored under, so they are cross-SDK contract. Behaviour is pinned by
``spec/fixtures/path-normalization.json`` and ``spec/fixtures/path-encoding.json``
-- if a change here breaks those, the change is wrong.
"""

from __future__ import annotations

import re

from .errors import InvalidInputError

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
_MULTI_SLASH = re.compile(r"/+")

# RFC 3986 unreserved: ALPHA / DIGIT / "-" / "." / "_" / "~".
# Everything else is percent-encoded with uppercase hex.
_UNRESERVED = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ" "abcdefghijklmnopqrstuvwxyz" "0123456789" "-._~"
)


def normalize_virtual_path(raw_path: str | None = None) -> str:
    """Normalize a virtual path to a clean POSIX-style relative path.

    Converts backslashes to forward slashes, strips control characters, collapses
    duplicate slashes, trims surrounding whitespace and slashes, and drops ``.``
    segments. Returns ``""`` for the storage root.

    Raises:
        InvalidInputError: if the path contains a ``..`` traversal segment.
    """
    if not raw_path or not isinstance(raw_path, str):
        return ""

    # Strip control characters first: they are invisible and would otherwise
    # survive into a provider request.
    path = _CONTROL_CHARS.sub("", raw_path)
    path = path.strip().replace("\\", "/")
    path = _MULTI_SLASH.sub("/", path)
    path = path.strip("/")

    if not path:
        return ""

    clean_segments: list[str] = []
    for segment in path.split("/"):
        trimmed = segment.strip()

        if trimmed in ("", "."):
            continue

        if trimmed == "..":
            raise InvalidInputError(
                f'Invalid virtual path "{raw_path}": Directory traversal ("..") is forbidden.',
                provider="core",
            )

        clean_segments.append(trimmed)

    return "/".join(clean_segments)


def get_basename(path: str) -> str:
    """Return the file or folder name from a path (``a/b/c.txt`` -> ``c.txt``)."""
    normalized = normalize_virtual_path(path)
    if not normalized:
        return ""
    _, _, last = normalized.rpartition("/")
    return last


def get_dirname(path: str) -> str:
    """Return the parent directory of a path (``a/b/c.txt`` -> ``a/b``)."""
    normalized = normalize_virtual_path(path)
    if not normalized:
        return ""
    head, sep, _ = normalized.rpartition("/")
    return head if sep else ""


def split_path(path: str) -> list[str]:
    """Split a path into segments (``a/b/c.txt`` -> ``["a", "b", "c.txt"]``)."""
    normalized = normalize_virtual_path(path)
    return normalized.split("/") if normalized else []


def rfc3986_uri_encode(value: str, encode_slash: bool = False) -> str:
    """Percent-encode a string per RFC 3986.

    Only unreserved characters (``A-Za-z0-9-._~``) pass through; everything else
    becomes uppercase percent-escapes of its UTF-8 bytes.

    This deliberately does not use :func:`urllib.parse.quote`, whose default safe
    set differs -- notably it leaves ``/`` alone and treats different punctuation
    as safe than RFC 3986 does.

    Args:
        value: The string to encode.
        encode_slash: If ``True``, ``/`` is encoded as ``%2F``. If ``False``,
            forward slashes are preserved so path structure survives.
    """
    out: list[str] = []
    for char in value:
        if char in _UNRESERVED or (char == "/" and not encode_slash):
            out.append(char)
        else:
            out.extend(f"%{byte:02X}" for byte in char.encode("utf-8"))
    return "".join(out)


def encode_path_segments(path: str) -> str:
    """Encode each path segment per RFC 3986, preserving the ``/`` hierarchy.

    Safely encodes ``#``, ``?``, ``&``, ``+``, spaces, and unicode without
    breaking the path structure. Leading and trailing slashes are trimmed;
    interior duplicate slashes are preserved, since collapsing them is
    :func:`normalize_virtual_path`'s job and encoding always runs after it.
    """
    clean = path.strip("/")
    if not clean:
        return ""
    return "/".join(rfc3986_uri_encode(segment, True) for segment in clean.split("/"))
