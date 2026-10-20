/**
 * Protocol-level regression suite.
 *
 * Every case here drives the real server over a real pipe and checks what
 * comes back. The rule the suite enforces is simple: a request that the
 * server understood must always produce a response, and a message it cannot
 * understand must produce an error rather than silence. Silence is the
 * failure that hurts most — the caller waits for a reply that never comes.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "server.js");

let passed = 0;
let failed = 0;

function ok(name: string, detail = "") {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}

function bad(name: string, detail: string) {
  failed++;
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
}

interface Exchange {
  lines: string[];
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

function exchange(
  payload: string,
  options: { endStdin?: boolean; waitMs?: number } = {},
): Promise<Exchange> {
  const waitMs = options.waitMs ?? 4000;
  // The server is expected to let go once the peer closes stdin, so every
  // probe closes it. That keeps the suite fast and exercises the shutdown
  // path on every single case.
  const shouldEnd = options.endStdin ?? true;
  return new Promise((resolve) => {
    const child = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        lines: out.split("\n").filter((l) => l.trim().length > 0),
        stderr: err,
        exitCode,
        signal,
      });
    };

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("exit", (code, signal) => finish(code, signal));
    child.on("error", () => finish(null, null));
    // The server may drop the connection while a payload is still going out —
    // that is exactly what the oversized-line case does. The write error is
    // the expected outcome there, not a failure of the probe.
    child.stdin.on("error", () => {});

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null, "SIGKILL");
    }, waitMs);

    if (payload) child.stdin.write(payload.endsWith("\n") ? payload : payload + "\n");
    if (shouldEnd) child.stdin.end();
  });
}

function parse(lines: string[]): any[] {
  return lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { __unparsable: l };
    }
  });
}

/** Asserts the number of responses and, optionally, what each one says. */
function expect(
  name: string,
  result: Exchange,
  expectedCount: number,
  check?: (messages: any[]) => string | null,
) {
  const messages = parse(result.lines);
  if (messages.length !== expectedCount) {
    bad(
      name,
      `expected ${expectedCount} response(s), got ${messages.length}` +
        (result.stderr ? `\n      stderr: ${result.stderr.trim().slice(0, 200)}` : ""),
    );
    return;
  }
  if (check) {
    const problem = check(messages);
    if (problem) {
      bad(name, problem);
      return;
    }
  }
  ok(name);
}

function isErrorResult(messages: any[]): string | null {
  const result = messages[0]?.result;
  if (!result || result.isError !== true) {
    return `expected a tool error, got ${show(messages[0]).slice(0, 220)}`;
  }
  const text = String(result.content?.[0]?.text ?? "");
  if (!text.startsWith("Invalid arguments")) {
    return `expected an argument complaint, got "${text.slice(0, 160)}"`;
  }
  return null;
}

/**
 * Finds the answer to a request by its id.
 *
 * The replies are correlated by id, not by position: the handlers run
 * concurrently, so a refused call can answer before a slower call that was
 * sent first. A client that reads the replies in order would apply the
 * wrong result to the wrong request.
 */
function byId(messages: any[], id: number): any {
  return messages.find((m) => m?.id === id);
}

/**
 * Renders a value for an error message.
 *
 * `JSON.stringify(undefined)` is undefined, not a string, so a missing
 * answer has to be handled — otherwise the suite crashes while reporting a
 * failure, which is exactly when it is least useful.
 */
function show(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

function errorCode(code: number) {
  return (messages: any[]) => {
    const error = messages[0]?.error;
    if (!error) return `expected an error, got ${show(messages[0]).slice(0, 200)}`;
    if (error.code !== code) return `expected error ${code}, got ${error.code} (${error.message})`;
    return null;
  };
}

function request(
  name: string,
  filePath: string,
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: { ...args, ...extra } },
  });
}

async function main() {
  console.log("\n\x1b[1mProtocol check\x1b[0m");
  console.log("  A request that arrived must always get an answer.\n");

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jy-proto-"));
  const draftsRoot = path.join(workRoot, "drafts");
  fs.mkdirSync(draftsRoot, { recursive: true });

  // --- malformed input must not be swallowed -----------------------------
  {
    const r = await exchange("{not json at all\n");
    expect("a malformed line is reported, not dropped", r, 1, errorCode(-32700));
  }
  {
    const r = await exchange('{"jsonrpc":"2.0","id":1,"method":"ping"\n');
    expect("a truncated line is reported, not dropped", r, 1, errorCode(-32700));
  }

  // --- a message that is not an object ------------------------------------
  for (const [label, payload] of [
    ["null", "null\n"],
    ["a number", "42\n"],
    ["a string", '"hello"\n'],
  ] as const) {
    const r = await exchange(payload);
    expect(`${label} is refused as an invalid request`, r, 1, errorCode(-32600));
  }
  {
    const r = await exchange("[null]\n");
    expect("a batch holding null is refused", r, 1, errorCode(-32600));
  }

  // --- requests the server must answer ------------------------------------
  {
    const r = await exchange('{"jsonrpc":"2.0","id":1}\n');
    expect("a request without a method is refused", r, 1, errorCode(-32600));
  }
  {
    const r = await exchange('{"jsonrpc":"2.0","id":1,"method":99}\n');
    expect("a non-string method is refused", r, 1, errorCode(-32600));
  }
  {
    const r = await exchange('{"jsonrpc":"2.0","id":null,"method":"ping"}\n');
    expect("a request with a null id is answered", r, 1, (m) =>
      m[0]?.result ? null : "expected a result",
    );
  }
  {
    const r = await exchange('{"jsonrpc":"2.0","id":0,"method":"ping"}\n');
    expect("a request with the id 0 is answered", r, 1, (m) =>
      m[0]?.result ? null : "expected a result",
    );
  }
  {
    const r = await exchange('{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n');
    expect("a call without params is refused", r, 1, errorCode(-32602));
  }
  {
    const r = await exchange('{"jsonrpc":"2.0","id":1,"method":"no/such/method"}\n');
    expect("an unknown method is refused", r, 1, errorCode(-32601));
  }

  // --- notifications stay silent ------------------------------------------
  {
    // A notification on its own line proves nothing: a dead server also
    // produces no reply. A notification followed by a request on the same
    // line proves the notification is silent *and* the server is alive.
    const r = await exchange(
      '{"jsonrpc":"2.0","method":"ping"}{"jsonrpc":"2.0","id":42,"method":"ping"}\n',
    );
    expect("a notification gets no answer", r, 1, (m) =>
      m[0]?.id === 42 && m[0]?.result
        ? null
        : `expected only the request's answer, got ${show(m).slice(0, 200)}`,
    );
  }

  // --- framing ------------------------------------------------------------
  {
    const r = await exchange(
      '{"jsonrpc":"2.0","id":1,"method":"ping"}{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
    );
    expect("two messages on one line are both answered", r, 2, (m) =>
      m.length === 2 && m[0].id === 1 && m[1].id === 2
        ? null
        : `unexpected replies: ${show(m).slice(0, 200)}`,
    );
  }
  {
    const r = await exchange(
      '[{"jsonrpc":"2.0","method":"ping"},{"jsonrpc":"2.0","id":7,"method":"ping"}]\n',
    );
    expect("a batch answers only its request", r, 1, (m) =>
      m[0]?.id === 7 ? null : `unexpected replies: ${show(m).slice(0, 200)}`,
    );
  }

  // --- arguments are checked ----------------------------------------------
  {
    const r = await exchange(
      request("jianying_open_draft", "", {}, {}),
    );
    expect("a missing required field is refused", r, 1, isErrorResult);
  }
  {
    const r = await exchange(
      request("jianying_open_draft", "", { name: 123 }, { draftsRoot }),
    );
    expect("a field of the wrong type is refused", r, 1, isErrorResult);
  }
  {
    const r = await exchange(
      request("jianying_open_draft", "", { name: ["a", "b"] }, { draftsRoot }),
    );
    expect("an array where a string belongs is refused", r, 1, isErrorResult);
  }
  {
    const r = await exchange(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "jianying_open_draft", arguments: "oops" },
      }),
    );
    expect("arguments that are not an object are refused", r, 1, isErrorResult);
  }
  {
    const r = await exchange(
      request("jianying_open_draft", "", { name: "TypoDraft", nmae: "x" }, { draftsRoot }),
    );
    expect("a misspelled argument is refused, not ignored", r, 1, isErrorResult);
  }
  {
    // "__proto__" has to reach the server as an own property. An object
    // literal with "__proto__" in it sets the prototype instead of creating a
    // property, so the argument is built with JSON.parse.
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "jianying_open_draft",
        arguments: JSON.parse('{"name":"Pollute","__proto__":{"polluted":true}}'),
      },
    });
    const r = await exchange(payload);
    expect("an argument named __proto__ is refused", r, 1, isErrorResult);
  }
  {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "jianying_open_draft",
        arguments: { name: "Pollute2", constructor: { prototype: { x: 1 } } },
      },
    });
    const r = await exchange(payload);
    expect("an argument named constructor is refused", r, 1, isErrorResult);
  }
  {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "jianying_open_draft",
        arguments: { name: "Pollute3", toString: "x" },
      },
    });
    const r = await exchange(payload);
    expect("an argument named toString is refused", r, 1, isErrorResult);
  }
  {
    const r = await exchange(
      request("jianying_open_draft", "", { name: "NestedStyle" }, { draftsRoot }),
    );
    // A valid call must still work after the validation was added.
    expect("a valid call still goes through", r, 1, (m) =>
      m[0]?.result?.isError
        ? `valid call was refused: ${show(m[0]).slice(0, 220)}`
        : null,
    );
  }
  {
    // The same server, so the open draft is still open: the save has to
    // produce a directory on disk, or the check below would pass against a
    // server that writes nothing at all.
    const payload =
      request("jianying_open_draft", "", { name: "NestedStyle" }, { draftsRoot }) +
      "\n" +
      request("jianying_save_draft", "", { name: "NestedStyle" }) +
      "\n";
    const r = await exchange(payload);
    expect("a valid draft can be saved", r, 2, (m) => {
      const save = byId(m, 1);
      if (!save) return "no answer for the save";
      return save.result?.isError
        ? `the save was refused: ${show(save).slice(0, 220)}`
        : null;
    });
  }

  // Nothing may be written to the drafts root by a refused call — and a
  // call that is accepted must write something, or the check above would
  // pass against a server that does nothing at all.
  {
    const leftovers = fs.readdirSync(draftsRoot);
    const bad2 = leftovers.filter(
      (n) => n === "undefined" || n === "123" || n === "a,b" || n.startsWith("Pollute"),
    );
    const accepted = leftovers.includes("NestedStyle");
    if (bad2.length > 0) {
      bad("a refused call writes nothing to disk", `left behind: ${bad2.join(", ")}`);
    } else if (!accepted) {
      bad(
        "a refused call writes nothing to disk",
        "the accepted call wrote nothing either, so the check proves nothing",
      );
    } else {
      ok("a refused call writes nothing to disk");
    }
  }

  // --- the server must let go when the peer does ---------------------------
  {
    const r = await exchange('{"jsonrpc":"2.0","id":1,"method":"ping"}\n', {
      endStdin: true,
      waitMs: 6000,
    });
    if (r.signal === "SIGKILL") {
      bad("the server exits when stdin closes", "the process was still running after 6s");
    } else if (r.exitCode !== 0) {
      bad("the server exits when stdin closes", `exit code ${r.exitCode}`);
    } else if (r.lines.length !== 1) {
      bad(
        "the server exits when stdin closes",
        `the pending reply was lost (${r.lines.length} response(s))`,
      );
    } else {
      ok("the server exits when stdin closes, with the reply flushed");
    }
  }

  // --- an in-flight call must survive the peer closing the pipe ----------
  {
    const mediaDir = process.argv[2] ?? path.join(here, "..", "test-media");
    const clip = path.join(mediaDir, "vid1.mp4");
    if (!fs.existsSync(clip)) {
      console.log(
        "  \x1b[33m-\x1b[0m an in-flight call survives the peer closing the pipe — skipped, no test media",
      );
    } else {
      const work2 = fs.mkdtempSync(path.join(os.tmpdir(), "jy-shut-"));
      const root2 = path.join(work2, "drafts");
      fs.mkdirSync(root2, { recursive: true });
      const payload =
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "jianying_open_draft",
            arguments: { name: "Shutdown", draftsRoot: root2 },
          },
        }) +
        "\n" +
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "jianying_add_video",
            arguments: { name: "Shutdown", filePath: clip, start: 0, duration: 2 },
          },
        }) +
        "\n";

      // The pipe closes while ffprobe is still running.
      const r = await exchange(payload, { waitMs: 10000 });
      const messages = parse(r.lines);
      const add = messages.find((m) => m.id === 2);
      if (r.signal === "SIGKILL") {
        bad("an in-flight call survives the peer closing the pipe", "the server never exited");
      } else if (!add || add.result?.isError) {
        bad(
          "an in-flight call survives the peer closing the pipe",
          `the call was cut off: ${show(add).slice(0, 200)}`,
        );
      } else {
        ok("an in-flight call survives the peer closing the pipe");
      }
      fs.rmSync(work2, { recursive: true, force: true });
    }
  }

  // --- duration strings and the subtitle flag ----------------------------
  {
    // The engine adds up the number-and-unit groups it finds and ignores
    // the rest, so "1m30s oops" would silently become 90 seconds.
    const payload =
      request("jianying_open_draft", "", { name: "Durations" }, { draftsRoot }) +
      "\n" +
      request("jianying_add_text", "", {
        name: "Durations",
        text: "caption",
        start: 0,
        duration: "1m30s oops",
      }) +
      "\n";
    const r = await exchange(payload);
    expect("a duration string with rubbish in it is refused", r, 2, (m) => {
      const add = byId(m, 1);
      if (!add) return "no answer for the text call";
      return add.result?.isError ? null : `the duration was accepted: ${show(add).slice(0, 200)}`;
    });
  }
  {
    const payload =
      request("jianying_open_draft", "", { name: "Durations2" }, { draftsRoot }) +
      "\n" +
      request("jianying_add_text", "", {
        name: "Durations2",
        text: "caption",
        start: 0,
        duration: "1m30s",
      }) +
      "\n";
    const r = await exchange(payload);
    expect("a duration string is accepted", r, 2, (m) => {
      const add = byId(m, 1);
      if (!add) return "no answer for the text call";
      return add.result?.isError
        ? `the duration was refused: ${show(add).slice(0, 200)}`
        : null;
    });
  }
  {
    // The engine has a caption style of its own, and the flag reaches it.
    const payload =
      request("jianying_open_draft", "", { name: "Caption" }, { draftsRoot }) +
      "\n" +
      request("jianying_add_text", "", {
        name: "Caption",
        text: "caption",
        start: 0,
        duration: 2,
        subtitle: true,
      }) +
      "\n";
    const r = await exchange(payload);
    expect("the subtitle flag is accepted", r, 2, (m) => {
      const add = byId(m, 1);
      if (!add) return "no answer for the text call";
      return add.result?.isError
        ? `the subtitle flag was refused: ${show(add).slice(0, 200)}`
        : null;
    });
  }

  // --- a large single line must not wedge the server -----------------------
  {
    const huge = "x".repeat(17 * 1024 * 1024);
    const r = await exchange(huge + "\n", { waitMs: 8000 });
    if (r.exitCode === 1) {
      // Exit code 1 alone is not enough: any fatal error exits 1. The log
      // has to name the reason, or the check cannot tell the cap from a
      // crash.
      if (/input buffer exceeded/.test(r.stderr)) {
        ok("an oversized line ends the connection instead of buffering forever");
      } else {
        bad(
          "an oversized line ends the connection instead of buffering forever",
          `exited 1, but not for the buffer cap: ${r.stderr.trim().slice(0, 160)}`,
        );
      }
    } else {
      bad(
        "an oversized line ends the connection instead of buffering forever",
        `exit code ${r.exitCode}, signal ${r.signal}`,
      );
    }
  }

  // --- rubbish in front of a request must not swallow the request --------
  {
    const r = await exchange(
      'GARBAGE {"jsonrpc":"2.0","id":7,"method":"ping"}\n',
    );
    expect("a request behind a rubbish fragment is still answered", r, 1, (m) =>
      m[0]?.id === 7 && m[0]?.result
        ? null
        : `the request was swallowed: ${show(m).slice(0, 200)}`,
    );
  }
  {
    const r = await exchange(
      '42 {"jsonrpc":"2.0","id":8,"method":"ping"}\n',
    );
    // "42" is a valid JSON value, so it is answered as an invalid request —
    // and the request behind it still gets its own answer.
    expect("a request behind a number is still answered", r, 2, (m) => {
      const ping = byId(m, 8);
      if (!ping) return `the request was swallowed: ${show(m).slice(0, 200)}`;
      return ping.result ? null : `the request was refused: ${show(ping).slice(0, 200)}`;
    });
  }

  fs.rmSync(workRoot, { recursive: true, force: true });

  console.log(
    `\n\x1b[1mProtocol: ${passed} passed, ${failed} failed\x1b[0m\n`,
  );
  if (failed > 0) process.exitCode = 1;
}

main();
