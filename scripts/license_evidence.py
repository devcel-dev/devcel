"""Authenticate original license text while tolerating Git LF/CRLF conversion."""
import hashlib


def authenticated_text_bytes(raw, expected, path):
    """Return original authenticated LF/CRLF bytes; never trim or rewrite text."""
    digest = lambda value: hashlib.sha256(value).hexdigest()
    if digest(raw) == expected:
        return raw
    normalized = raw.replace(b'\r\n', b'\n')
    if b'\r' not in normalized:
        # Recover the recorded original line endings, not an unauthenticated body.
        for candidate in (normalized, normalized.replace(b'\n', b'\r\n')):
            if digest(candidate) == expected:
                return candidate
    raise ValueError('Upstream license SHA-256 mismatch: ' + path +
                       '; expected=' + str(expected) + '; actual=' + digest(raw) +
                       '; LF/CRLF differences are ignored; all other bytes must match')
