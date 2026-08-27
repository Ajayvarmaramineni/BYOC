"""Path conformance: this SDK against the shared cross-SDK fixtures."""

from __future__ import annotations

from typing import Any

import pytest
from conftest import load_fixture

from byoc.errors import ERROR_CLASS_BY_CODE, BYOCErrorCode, StorageError
from byoc.paths import (
    encode_path_segments,
    get_basename,
    get_dirname,
    normalize_virtual_path,
    rfc3986_uri_encode,
    split_path,
)

_NORM = load_fixture("path-normalization.json")
_ENC = load_fixture("path-encoding.json")

_NORM_CASES = _NORM["normalize"]["cases"]
_ERR_CASES = _NORM["normalize_errors"]["cases"]
_BASE_CASES = _NORM["basename"]["cases"]
_DIR_CASES = _NORM["dirname"]["cases"]
_SPLIT_CASES = _NORM["split"]["cases"]
_URI_CASES = _ENC["rfc3986_uri_encode"]["cases"]
_SEG_CASES = _ENC["encode_path_segments"]["cases"]


def _ids(cases: list[dict[str, Any]], key: str = "name") -> list[str]:
    return [str(c.get(key, c.get("input"))) for c in cases]


@pytest.mark.parametrize("case", _NORM_CASES, ids=_ids(_NORM_CASES))
def test_normalize(case: dict[str, Any]) -> None:
    raw = case["input"]
    actual = normalize_virtual_path() if raw is None else normalize_virtual_path(raw)
    assert actual == case["expected"]


@pytest.mark.parametrize("case", _ERR_CASES, ids=_ids(_ERR_CASES))
def test_normalize_rejects(case: dict[str, Any]) -> None:
    expected_code = BYOCErrorCode(case["error_code"])
    expected_cls = ERROR_CLASS_BY_CODE[expected_code]

    with pytest.raises(StorageError) as excinfo:
        normalize_virtual_path(case["input"])

    assert excinfo.value.code == expected_code
    assert isinstance(excinfo.value, expected_cls)


@pytest.mark.parametrize("case", _BASE_CASES, ids=_ids(_BASE_CASES, "input"))
def test_basename(case: dict[str, Any]) -> None:
    assert get_basename(case["input"]) == case["expected"]


@pytest.mark.parametrize("case", _DIR_CASES, ids=_ids(_DIR_CASES, "input"))
def test_dirname(case: dict[str, Any]) -> None:
    assert get_dirname(case["input"]) == case["expected"]


@pytest.mark.parametrize("case", _SPLIT_CASES, ids=_ids(_SPLIT_CASES, "input"))
def test_split(case: dict[str, Any]) -> None:
    assert split_path(case["input"]) == case["expected"]


@pytest.mark.parametrize("case", _URI_CASES, ids=_ids(_URI_CASES, "input"))
def test_rfc3986_uri_encode(case: dict[str, Any]) -> None:
    assert rfc3986_uri_encode(case["input"], case["encode_slash"]) == case["expected"]


@pytest.mark.parametrize("case", _SEG_CASES, ids=_ids(_SEG_CASES, "input"))
def test_encode_path_segments(case: dict[str, Any]) -> None:
    assert encode_path_segments(case["input"]) == case["expected"]
