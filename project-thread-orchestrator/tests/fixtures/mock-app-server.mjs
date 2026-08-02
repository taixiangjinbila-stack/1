import fs from "node:fs";
import readline from "node:readline";

const mode = process.env.PTO_MOCK_MODE ?? "basic";
const logPath = process.env.PTO_MOCK_LOG;
const thread = {
  id: "thr_mock_1",
  name: null,
  cwd: null,
  ephemeral: false,
  source: "appServer",
  status: { type: "idle" },
  turns: [],
};
let initialized = false;
let archived = false;
let loaded = false;
let nextTurn = 1;

function log(value) {
  if (logPath !== undefined) {
    fs.appendFileSync(logPath, `${JSON.stringify(value)}\n`, "utf8");
  }
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function fail(id, code, message, data) {
  send({ id, error: { code, message, data } });
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on("line", (line) => {
  const message = JSON.parse(line);
  log({ direction: "from-client", message });

  if (message.method === "initialize") {
    if (mode === "timeout-initialize") {
      return;
    }
    if (mode === "invalid-initialize") {
      respond(message.id, { invalid: true });
      return;
    }
    respond(message.id, {
      userAgent: "mock-app-server",
      codexHome: "mock",
      platformFamily: "windows",
      platformOs: "windows",
    });
    return;
  }
  if (message.method === "initialized" && message.id === undefined) {
    initialized = true;
    return;
  }
  if (!initialized) {
    fail(message.id, -32002, "Not initialized");
    return;
  }
  if (message.method === undefined && message.id !== undefined) {
    log({ direction: "client-response", message });
    return;
  }

  switch (message.method) {
    case "thread/start": {
      if (mode === "timeout-start") {
        return;
      }
      if (mode === "exit-start") {
        process.exit(17);
      }
      if (mode === "legacy" && message.params?.sandbox === "read-only") {
        fail(
          message.id,
          -32602,
          "invalid sandbox enum; expected readOnly",
          { field: "sandbox" },
        );
        return;
      }
      if (mode === "unrelated-invalid") {
        fail(message.id, -32602, "invalid serviceName", {
          field: "serviceName",
        });
        return;
      }
      thread.cwd = message.params.cwd;
      loaded = mode !== "stored-not-loaded";
      thread.status = { type: loaded ? "idle" : "notLoaded" };
      respond(message.id, { thread });
      send({ method: "thread/started", params: { thread } });
      return;
    }
    case "thread/resume":
      if (mode === "resume-not-found") {
        fail(message.id, -32600, `thread not found: ${message.params.threadId}`);
        return;
      }
      loaded = true;
      thread.status = { type: "idle" };
      respond(message.id, { thread });
      return;
    case "thread/read":
      thread.status = { type: loaded ? "idle" : "notLoaded" };
      respond(message.id, { thread });
      return;
    case "thread/loaded/list":
      respond(message.id, {
        data: loaded ? [thread.id] : [],
        nextCursor: null,
      });
      return;
    case "thread/name/set":
      thread.name = message.params.name;
      respond(message.id, {});
      return;
    case "thread/goal/set":
      respond(message.id, {
        goal: {
          threadId: thread.id,
          objective: message.params.objective,
          status: message.params.status,
        },
      });
      return;
    case "turn/start": {
      if (!loaded) {
        fail(message.id, -32600, `thread not found: ${message.params.threadId}`);
        return;
      }
      const turn = {
        id: `turn_mock_${nextTurn++}`,
        status: "inProgress",
        items: [],
        error: null,
      };
      thread.turns.push(turn);
      respond(message.id, { turn });
      send({
        method: "turn/started",
        params: { threadId: thread.id, turn },
      });
      if (mode === "approval") {
        send({
          id: "approval_request_1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: thread.id,
            turnId: turn.id,
            itemId: "item_1",
            command: ["dangerous-command"],
          },
        });
        return;
      }
      if (mode === "terminal-error") {
        send({
          method: "error",
          params: {
            error: {
              message: "mock terminal turn failure",
              codexErrorInfo: null,
              additionalDetails: null,
            },
            willRetry: false,
            threadId: thread.id,
            turnId: turn.id,
          },
        });
        return;
      }
      setTimeout(() => {
        turn.status = "completed";
        turn.items = [
          {
            id: "agent_1",
            type: "agentMessage",
            text: JSON.stringify({
              status: "READY",
              goal: "checked",
              scope: [],
              acceptance_criteria: [],
              dependencies_checked: [],
              blockers: [],
            }),
          },
        ];
        send({
          method: "turn/completed",
          params: { threadId: thread.id, turn },
        });
      }, 5);
      return;
    }
    case "turn/interrupt": {
      respond(message.id, {});
      const turn = thread.turns.find(
        (candidate) => candidate.id === message.params.turnId,
      );
      if (turn !== undefined && turn.status === "inProgress") {
        turn.status = "interrupted";
        send({
          method: "turn/completed",
          params: { threadId: thread.id, turn },
        });
      }
      return;
    }
    case "thread/list":
      respond(message.id, {
        data:
          Boolean(message.params.archived) === archived ? [thread] : [],
        nextCursor: null,
      });
      return;
    case "thread/archive":
      archived = true;
      respond(message.id, {});
      send({
        method: "thread/archived",
        params: { threadId: thread.id },
      });
      return;
    case "thread/delete":
      archived = false;
      respond(message.id, {});
      send({ method: "thread/deleted", params: { threadId: thread.id } });
      return;
    default:
      fail(message.id, -32601, `unknown mock method: ${message.method}`);
  }
});

input.on("close", () => {
  process.exit(0);
});
