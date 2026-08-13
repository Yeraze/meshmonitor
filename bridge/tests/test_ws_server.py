"""Unit tests for meshmonitor_rns_bridge.ws_server's token comparison.

Security review finding: the bridge binds 0.0.0.0 by default (reachable beyond
loopback in the container deployment), so comparing the shared-secret `hello.token`
with a plain `==` is vulnerable to a same-network timing attack. `_tokens_match()`
uses `hmac.compare_digest()` instead; these tests pin the *behavior* (correct token
authenticates, wrong/missing/malformed token is rejected) which must stay identical
to the old `!=` check -- only the comparison mechanism changed.

Deliberately does not (and cannot, without instrumentation the stdlib doesn't expose)
assert timing itself; that property comes from using `hmac.compare_digest`, which is
exercised here to at least confirm it's actually being called with the right
arguments and that it round-trips both matching and non-matching cases correctly.
"""

from __future__ import annotations

from unittest.mock import patch

from meshmonitor_rns_bridge.ws_server import _tokens_match


def test_correct_token_matches():
    assert _tokens_match("s3cret", "s3cret") is True


def test_wrong_token_does_not_match():
    assert _tokens_match("wrong", "s3cret") is False


def test_missing_token_does_not_match():
    assert _tokens_match(None, "s3cret") is False


def test_non_string_token_does_not_match():
    # A malformed hello could send token as a number/list/dict after JSON decode --
    # the old `!=` comparison rejected these too (no type coercion), preserve that.
    assert _tokens_match(12345, "s3cret") is False
    assert _tokens_match(["s3cret"], "s3cret") is False
    assert _tokens_match({"token": "s3cret"}, "s3cret") is False


def test_empty_token_does_not_match_nonempty_expected():
    assert _tokens_match("", "s3cret") is False


def test_uses_constant_time_compare():
    """Pins the mechanism, not just the outcome: a plain `==` regression would still
    pass every behavioral test above, so assert hmac.compare_digest is actually what
    performs the comparison."""
    with patch("meshmonitor_rns_bridge.ws_server.hmac.compare_digest", return_value=True) as mock_compare:
        assert _tokens_match("anything", "s3cret") is True
        mock_compare.assert_called_once_with(b"anything", b"s3cret")
