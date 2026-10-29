"""Per-request child process. No original is persisted, including on failures."""

import contextlib
import json
import sys

from limits import InvalidDocument, MAX_FILE_BYTES, MAX_RESPONSE_BYTES


def main() -> int:
    # RLIMIT_AS is not portable to macOS. Linux cgroup RAM is the primary limit;
    # the virtual-memory and CPU limits additionally stop a runaway native decoder.
    if sys.platform == "linux":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (8 * 1024**3, 8 * 1024**3))
        resource.setrlimit(resource.RLIMIT_CPU, (65, 70))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    data = sys.stdin.buffer.read(MAX_FILE_BYTES + 1)
    try:
        if len(sys.argv) != 2 or not data or len(data) > MAX_FILE_BYTES:
            raise InvalidDocument("Invalid input")
        with contextlib.redirect_stdout(sys.stderr):
            from inference import extract
            result = extract(data, sys.argv[1])
        response = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(response) > MAX_RESPONSE_BYTES:
            raise InvalidDocument("Result too large")
        sys.stdout.buffer.write(response)
        return 0
    except InvalidDocument:
        return 2
    except Exception:
        # No exception values, OCR output or document bytes enter logs.
        return 1


if __name__ == "__main__":
    sys.exit(main())

