"""Resolve domains from the command line.

Usage:
    python tools/check_domain.py example.com [example.org ...]

Importing this module has no side effects.
"""

from __future__ import annotations

import socket
import sys


def get_domain_info(domain: str) -> str:
    domain = str(domain or "").strip()
    if not domain:
        return "Could not resolve an empty domain"
    try:
        ip = socket.gethostbyname(domain)
    except (socket.gaierror, OSError) as exc:
        return f"Could not resolve {domain}: {exc}"
    return f"Domain: {domain}\nIP Address: {ip}"


def main(argv: list[str] | None = None) -> int:
    domains = list(sys.argv[1:] if argv is None else argv)
    if not domains:
        print("usage: python tools/check_domain.py <domain> [domain ...]", file=sys.stderr)
        return 2
    for index, domain in enumerate(domains):
        if index:
            print()
        print(get_domain_info(domain))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
