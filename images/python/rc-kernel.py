#!/usr/bin/env python3
"""Drives a real Jupyter kernel and speaks one line of JSON at a time.

plan.md §12.3. This runs INSIDE the project's container, exec'd by the kernel
gateway exactly as `pylsp` is, and it exists so that nothing outside the
container has to speak Jupyter's wire protocol.

**Why a driver rather than a ZeroMQ client in the Node server.** Jupyter's
protocol is five ZeroMQ sockets with HMAC-SHA256 signing on every frame, and
speaking it from Node means a native `zeromq` build in the server image and a
reimplementation of the signing scheme. The Python side already has all of it
-- `jupyter_client` is what Jupyter itself uses -- and it is already in the
container. So the complicated half stays where the library is, and what
crosses the container boundary is newline-delimited JSON.

**Why a real kernel rather than `InteractiveShell` in this process.** Three
things that a notebook is expected to do need the kernel to be a separate
process: interrupting a runaway cell (SIGINT to something that is not us),
restarting after somebody exhausts the memory limit, and surviving a C
extension that segfaults. In-process, each of those takes the driver with it
and the connection dies with no message.

Protocol, both directions, one JSON object per line:

    in   {"type":"execute","cellId":"...","code":"..."}
         {"type":"interrupt"}
         {"type":"restart"}

    out  {"type":"ready","kernel":"python3","language":"python"}
         {"type":"status","state":"busy"|"idle"|"starting"}
         {"type":"output","cellId":"...","output":{nbformat output}}
         {"type":"count","cellId":"...","count":3}
         {"type":"done","cellId":"...","ok":true}
         {"type":"fatal","message":"..."}

Outputs are emitted in nbformat's own shape, so what the renderer draws and
what gets written back into the `.ipynb` are the same object.
"""

import json
import queue
import sys
import threading

# Imported inside main() so that a missing dependency becomes a `fatal` line
# the editor can show, rather than a traceback on stderr that the gateway logs
# and nobody ever reads.


def emit(message):
    """One JSON object, one line, flushed.

    Flushing matters: this is a pipe, not a terminal, so Python would buffer
    4 KB of it -- and a cell that prints a progress line every second would
    show nothing for a minute and then everything at once.
    """
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


#: Messages that jump the queue instead of joining it. An interrupt that
#: waited its turn behind the cell it is meant to interrupt would never
#: arrive, which is the entire point of it.
CONTROL = ("interrupt", "restart")


def reader(commands, control):
    """Stdin, on its own thread.

    Separate because an interrupt has to arrive WHILE a cell is running, and
    the main thread is blocked on the kernel's iopub channel at that moment.

    **Two queues, and the split is not decoration.** The first version drained
    ONE queue from inside the execute loop looking for interrupts, which meant
    every other message it passed on the way -- the rest of a Run All -- was
    read and thrown away. Running it found that: three cells went in and one
    ran, and the sentinel that ends this process was eaten the same way, so it
    then hung for ever. Control messages go to `control`, executes stay in
    order on `commands`, and neither has to rummage through the other.
    """
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            # A line that is not JSON is the gateway's bug, not the user's.
            # Dropped rather than allowed to kill the kernel.
            continue
        if message.get("type") in CONTROL:
            control.put(message)
        else:
            commands.put(message)
    # End of stream: the gateway let go. The sentinel is what stops the main
    # loop, and it goes on `commands` because that is the queue the main loop
    # takes from.
    commands.put(None)


def as_output(msg):
    """A kernel iopub message as an nbformat output, or None to ignore it."""
    kind = msg["header"]["msg_type"]
    content = msg["content"]

    if kind == "stream":
        return {
            "output_type": "stream",
            "name": content.get("name", "stdout"),
            "text": content.get("text", ""),
        }

    if kind == "execute_result":
        return {
            "output_type": "execute_result",
            "data": content.get("data", {}),
            "metadata": content.get("metadata", {}),
            "execution_count": content.get("execution_count"),
        }

    if kind == "display_data":
        return {
            "output_type": "display_data",
            "data": content.get("data", {}),
            "metadata": content.get("metadata", {}),
        }

    if kind == "error":
        return {
            "output_type": "error",
            "ename": content.get("ename", "Error"),
            "evalue": content.get("evalue", ""),
            "traceback": content.get("traceback", []),
        }

    # update_display_data, clear_output, comm_* and the widget traffic. Not
    # rendered, and deliberately not half-rendered: a `clear_output` that
    # arrives without the display machinery behind it would erase outputs the
    # user can still see.
    return None


def run_cell(manager, client, cell_id, code, control):
    """Execute one cell and pump its messages until the kernel goes idle.

    Returns False if the cell errored, was interrupted, or was cut short by a
    restart. Only `control` is consulted here -- queued executes are the main
    loop's business and must still be there when this returns.
    """
    parent = client.execute(code, store_history=True, allow_stdin=False)
    ok = True
    idle = False

    while not idle:
        # Interrupts are the reason this loop polls rather than blocks
        # forever. A cell in `while True: pass` produces no messages at all,
        # so waiting for one would mean the interrupt is never read.
        while not control.empty():
            command = control.get_nowait()
            if command.get("type") == "interrupt":
                manager.interrupt_kernel()
                ok = False
            else:
                # A restart. Put back for the main loop, which owns the
                # channels this function is reading from.
                control.put(command)
                return False

        try:
            msg = client.get_iopub_msg(timeout=0.2)
        except Exception:
            # queue.Empty, and only that in practice. Loop back round so the
            # command queue gets another look.
            if not client.is_alive():
                emit({"type": "fatal", "message": "The kernel stopped."})
                return False
            continue

        # Messages from an EARLIER cell can still be in flight. Attributing
        # them to this one would put the previous cell's output under it.
        if msg.get("parent_header", {}).get("msg_id") != parent:
            continue

        kind = msg["header"]["msg_type"]

        if kind == "status":
            state = msg["content"].get("execution_state")
            emit({"type": "status", "state": state})
            if state == "idle":
                idle = True
            continue

        if kind == "execute_input":
            count = msg["content"].get("execution_count")
            if count is not None:
                emit({"type": "count", "cellId": cell_id, "count": count})
            continue

        if kind == "error":
            ok = False

        output = as_output(msg)
        if output is not None:
            emit({"type": "output", "cellId": cell_id, "output": output})

    return ok


def main():
    try:
        from jupyter_client.manager import KernelManager
    except ImportError as error:
        emit(
            {
                "type": "fatal",
                "message": "This image has no Jupyter kernel installed (%s)."
                % error,
            }
        )
        return 1

    kernel_name = "python3"
    emit({"type": "status", "state": "starting"})

    manager = KernelManager(kernel_name=kernel_name)
    try:
        manager.start_kernel()
    except Exception as error:  # noqa: BLE001 - reported, not swallowed
        emit({"type": "fatal", "message": "The kernel would not start: %s" % error})
        return 1

    client = manager.client()
    client.start_channels()

    try:
        client.wait_for_ready(timeout=60)
    except RuntimeError as error:
        emit({"type": "fatal", "message": "The kernel never became ready: %s" % error})
        return 1

    emit({"type": "ready", "kernel": kernel_name, "language": "python"})

    commands = queue.Queue()
    control = queue.Queue()
    threading.Thread(target=reader, args=(commands, control), daemon=True).start()

    try:
        while True:
            # Control first, and polled rather than blocked on, so a restart
            # sent while nothing is running is acted on now instead of when
            # the next cell happens to arrive.
            if not control.empty():
                if control.get_nowait().get("type") == "restart":
                    client.stop_channels()
                    manager.restart_kernel(now=True)
                    client = manager.client()
                    client.start_channels()
                    client.wait_for_ready(timeout=60)
                    emit(
                        {
                            "type": "ready",
                            "kernel": kernel_name,
                            "language": "python",
                        }
                    )
                # An interrupt outside a cell has nothing to interrupt, and
                # sending SIGINT anyway can kill an idle kernel.
                continue

            try:
                command = commands.get(timeout=0.2)
            except Exception:
                # queue.Empty. Round again, so control gets another look.
                continue

            if command is None:
                break

            if command.get("type") == "execute":
                cell_id = command.get("cellId", "")
                ok = run_cell(
                    manager, client, cell_id, command.get("code", ""), control
                )
                emit({"type": "done", "cellId": cell_id, "ok": ok})
    finally:
        client.stop_channels()
        manager.shutdown_kernel(now=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
