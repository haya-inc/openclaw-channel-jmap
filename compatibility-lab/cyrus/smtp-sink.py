#!/usr/bin/env python3
"""Local-only SMTP sink used to advertise JMAP Submission in the Cyrus lab."""

from socketserver import StreamRequestHandler, ThreadingTCPServer


class SmtpSinkHandler(StreamRequestHandler):
    def send(self, line: str) -> None:
        self.wfile.write(f"{line}\r\n".encode("ascii"))
        self.wfile.flush()

    def handle(self) -> None:
        self.send("220 cyrus-lab.local ESMTP local-only sink")
        reading_data = False
        while line := self.rfile.readline(1_048_576):
            command = line.rstrip(b"\r\n")
            if reading_data:
                if command == b".":
                    reading_data = False
                    self.send("250 2.0.0 accepted by local-only sink")
                continue

            verb = command.split(b" ", 1)[0].upper()
            if verb in {b"EHLO", b"LHLO"}:
                self.send("250-cyrus-lab.local")
                self.send("250 SIZE 10485760")
            elif verb == b"HELO":
                self.send("250 cyrus-lab.local")
            elif verb in {b"MAIL", b"RCPT", b"RSET", b"NOOP"}:
                self.send("250 2.0.0 ok")
            elif verb == b"DATA":
                reading_data = True
                self.send("354 end with <CRLF>.<CRLF>")
            elif verb == b"QUIT":
                self.send("221 2.0.0 bye")
                return
            else:
                self.send("502 5.5.1 unsupported in compatibility lab")


class SmtpSinkServer(ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with SmtpSinkServer(("127.0.0.1", 1025), SmtpSinkHandler) as server:
        server.serve_forever()
