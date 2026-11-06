#!/usr/bin/env python3
"""把一条命令放进真终端。父进程用长度帧交换字节，和在终端里打开这条命令一样。"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

STDIN = sys.stdin.fileno()
STDOUT = sys.stdout.fileno()


def write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            n = os.write(fd, view)
        except OSError as e:
            if e.errno == errno.EINTR:
                continue
            return False
        view = view[n:]
    return True


def emit(ftype, payload):
    write_all(STDOUT, struct.pack(">BI", ftype, len(payload)) + payload)


def main():
    cmd = os.environ["PTY_BIN"]
    cwd = os.environ["PTY_CWD"]
    cols = int(os.environ.get("PTY_COLS", "100"))
    rows = int(os.environ.get("PTY_ROWS", "30"))
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(cwd)
        except OSError:
            os._exit(127)
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        try:
            os.execvp(cmd, [cmd])
        except OSError:
            os._exit(127)
        return

    def stop_child(_signum, _frame):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        os._exit(0)

    signal.signal(signal.SIGTERM, stop_child)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass

    acc = b""
    child_done = False
    while not child_done:
        try:
            ready, _, _ = select.select([STDIN, fd], [], [], 0.4)
        except OSError as e:
            if e.errno == errno.EINTR:
                continue
            break
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if data:
                emit(1, data)
            else:
                child_done = True
        if STDIN in ready:
            try:
                chunk = os.read(STDIN, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                child_done = True
            else:
                acc += chunk
                while len(acc) >= 5:
                    ftype = acc[0]
                    length = struct.unpack(">I", acc[1:5])[0]
                    if length > 1_000_000 or len(acc) < 5 + length:
                        break
                    payload = acc[5 : 5 + length]
                    acc = acc[5 + length :]
                    if ftype == 1:
                        write_all(fd, payload)
                    elif ftype == 2 and len(payload) >= 4:
                        c, r = struct.unpack(">HH", payload[:4])
                        try:
                            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
                        except OSError:
                            pass
                    elif ftype == 3:
                        try:
                            os.kill(pid, signal.SIGTERM)
                        except OSError:
                            pass
                        child_done = True
                        break
        try:
            wpid, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            wpid, status = pid, 0
        if wpid:
            code = (status >> 8) & 0xFF
            if os.WIFSIGNALED(status):
                code = 128 + os.WTERMSIG(status)
            emit(2, struct.pack(">I", code))
            return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    try:
        _, status = os.waitpid(pid, 0)
        code = (status >> 8) & 0xFF
    except ChildProcessError:
        code = 0
    emit(2, struct.pack(">I", code))


if __name__ == "__main__":
    main()
