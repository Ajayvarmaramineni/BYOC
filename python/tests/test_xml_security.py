"""Provider-controlled XML must not expand DTD entities."""

from __future__ import annotations

import httpx
from defusedxml.common import EntitiesForbidden

from byoc.errors import ProviderUnavailableError
from byoc.providers.s3 import S3CompatibleProvider
from byoc.providers.webdav import WebDAVProvider

_ENTITY_XML = """<?xml version="1.0"?>
<!DOCTYPE response [<!ENTITY injected "attacker-controlled">]>
<response>&injected;</response>
"""


async def test_s3_list_rejects_xml_entities() -> None:
    transport = httpx.MockTransport(lambda request: httpx.Response(200, text=_ENTITY_XML))
    async with httpx.AsyncClient(transport=transport) as client:
        provider = S3CompatibleProvider(
            endpoint="https://s3.example.test",
            bucket="bucket",
            region="us-east-1",
            access_key_id="key",
            secret_access_key="secret",
            client=client,
        )
        try:
            await provider.list()
        except ProviderUnavailableError as exc:
            assert isinstance(exc.raw_error, EntitiesForbidden)
        else:
            raise AssertionError("unsafe S3 XML was accepted")


async def test_webdav_list_rejects_xml_entities() -> None:
    transport = httpx.MockTransport(lambda request: httpx.Response(207, text=_ENTITY_XML))
    async with httpx.AsyncClient(transport=transport) as client:
        provider = WebDAVProvider(
            endpoint="https://dav.example.test",
            root_folder="",
            client=client,
        )
        try:
            await provider.list()
        except ProviderUnavailableError as exc:
            assert isinstance(exc.raw_error, EntitiesForbidden)
        else:
            raise AssertionError("unsafe WebDAV XML was accepted")
