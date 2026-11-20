/**
 * Cloudflare Worker + Sandbox MCP Server for 8-V-Org/tools_floorplan
 * Protocol: Model Context Protocol (MCP) JSON-RPC 2024-11-05 over HTTP/POST
 */

import { getSandbox, Sandbox } from "@cloudflare/sandbox";

export { Sandbox };

const SERVER_NAME = "tools-floorplan";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2024-11-05";
const FLOORPLAN_SCRIPTS = "/opt/floorplan/skills/floorplan/scripts";

const TOOLS = [
  {
    name: "scan",
    description:
      "Clone a GitHub repository into a Cloudflare Sandbox and run floorplan scan.mjs to extract files, imports, HTTP routes/calls, and static health issues.",
    inputSchema: {
      type: "object",
      properties: {
        repo_url: {
          type: "string",
          description: "HTTPS Git repository URL (e.g. https://github.com/owner/repo.git)."
        },
        branch: {
          type: "string",
          description: "Optional branch or ref to checkout."
        },
        session_id: {
          type: "string",
          description: "Optional sandbox session ID to reuse an existing workspace."
        }
      },
      required: ["repo_url"]
    }
  },
  {
    name: "build",
    description:
      "Write architecture.json (and optional descriptions/*.json) into the scanned sandbox workspace, run floorplan build.mjs, and store floorplan/index.html in R2.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Sandbox session ID returned by the scan tool."
        },
        architecture_json: {
          type: "object",
          description: "The floorplan/architecture.json object describing subsystems, modules, and flows."
        },
        descriptions: {
          type: "object",
          description: "Optional map of filename (e.g. 'api.json') to description JSON object for floorplan/descriptions/."
        }
      },
      required: ["session_id", "architecture_json"]
    }
  },
  {
    name: "status",
    description: "Returns health telemetry for the tools-floorplan MCP server.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

function sanitizeSessionId(raw) {
  const base = raw || crypto.randomUUID();
  return base.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64);
}

async function handleScan(args, env) {
  const { repo_url, branch } = args;
  const sessionId = sanitizeSessionId(args.session_id);
  const sandbox = getSandbox(env.Sandbox, sessionId);

  const checkoutOpts = { targetDir: "/workspace/repo" };
  if (branch) checkoutOpts.branch = branch;

  await sandbox.exec("rm -rf /workspace/repo");
  await sandbox.gitCheckout(repo_url, checkoutOpts);

  const res = await sandbox.exec(
    `node ${FLOORPLAN_SCRIPTS}/scan.mjs /workspace/repo --json --unattended`
  );

  if (res.exitCode !== 0 && !res.stdout) {
    throw new Error(`floorplan scan failed (exit ${res.exitCode}): ${res.stderr}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    parsed = { raw_stdout: res.stdout, stderr: res.stderr };
  }

  return JSON.stringify({ session_id: sessionId, scan: parsed }, null, 2);
}

async function handleBuild(args, env, requestUrl) {
  const sessionId = sanitizeSessionId(args.session_id);
  const sandbox = getSandbox(env.Sandbox, sessionId);

  await sandbox.exec("mkdir -p /workspace/repo/floorplan/descriptions");
  await sandbox.writeFile(
    "/workspace/repo/floorplan/architecture.json",
    JSON.stringify(args.architecture_json, null, 2)
  );

  if (args.descriptions && typeof args.descriptions === "object") {
    for (const [filename, content] of Object.entries(args.descriptions)) {
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      await sandbox.writeFile(
        `/workspace/repo/floorplan/descriptions/${safeName}`,
        typeof content === "string" ? content : JSON.stringify(content, null, 2)
      );
    }
  }

  const res = await sandbox.exec(
    `node ${FLOORPLAN_SCRIPTS}/build.mjs /workspace/repo --json --unattended`
  );

  let buildResult;
  try {
    buildResult = JSON.parse(res.stdout);
  } catch {
    buildResult = { ok: res.exitCode === 0, raw_stdout: res.stdout, stderr: res.stderr };
  }

  let artifactUrl = null;
  if (env.FLOORPLAN_BUCKET) {
    try {
      const htmlFile = await sandbox.readFile("/workspace/repo/floorplan/index.html");
      const htmlContent = typeof htmlFile === "string" ? htmlFile : htmlFile.content;
      if (htmlContent) {
        const key = `maps/${sessionId}/index.html`;
        await env.FLOORPLAN_BUCKET.put(key, htmlContent, {
          httpMetadata: { contentType: "text/html; charset=utf-8" }
        });
        const origin = new URL(requestUrl).origin;
        artifactUrl = `${origin}/artifacts/${sessionId}/index.html`;
      }
    } catch (e) {
      buildResult.artifact_warning = `Failed to archive index.html to R2: ${e.message}`;
    }
  }

  return JSON.stringify({ session_id: sessionId, artifact_url: artifactUrl, build: buildResult }, null, 2);
}

async function dispatchTool(name, args, env, requestUrl) {
  switch (name) {
    case "scan":
      return await handleScan(args || {}, env);
    case "build":
      return await handleBuild(args || {}, env, requestUrl);
    case "status":
      return JSON.stringify({
        server: SERVER_NAME,
        version: SERVER_VERSION,
        protocol: PROTOCOL_VERSION,
        status: "healthy",
        timestamp: new Date().toISOString()
      }, null, 2);
    default:
      throw new Error(`Unknown tool: '${name}'`);
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, X-Requested-With",
  "Content-Type": "application/json"
};

function jsonRpcSuccess(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id, code, message, data = undefined) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error: err };
}

async function processRpcRequest(req, env, requestUrl) {
  if (!req || typeof req !== "object" || req.jsonrpc !== "2.0" || !req.method) {
    return jsonRpcError(req?.id, -32600, "Invalid Request");
  }

  const { id, method, params } = req;

  try {
    switch (method) {
      case "initialize":
        return jsonRpcSuccess(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
        });

      case "notifications/initialized":
      case "ping":
        return jsonRpcSuccess(id, {});

      case "tools/list":
        return jsonRpcSuccess(id, { tools: TOOLS });

      case "tools/call": {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        if (!toolName) {
          return jsonRpcError(id, -32602, "Invalid params: 'name' is required");
        }
        try {
          const textResult = await dispatchTool(toolName, toolArgs, env, requestUrl);
          return jsonRpcSuccess(id, {
            content: [{ type: "text", text: textResult }],
            isError: false
          });
        } catch (toolErr) {
          return jsonRpcSuccess(id, {
            content: [{ type: "text", text: `Error executing '${toolName}': ${toolErr.message}` }],
            isError: true
          });
        }
      }

      default:
        return jsonRpcError(id, -32601, `Method not found: '${method}'`);
    }
  } catch (err) {
    return jsonRpcError(id, -32603, "Internal error", err.message);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Serve archived floorplan HTML artifacts from R2
    if (request.method === "GET" && url.pathname.startsWith("/artifacts/")) {
      const match = url.pathname.match(/^\/artifacts\/([a-z0-9-]+)\/index\.html$/);
      if (!match || !env.FLOORPLAN_BUCKET) {
        return new Response("Not Found", { status: 404 });
      }
      const obj = await env.FLOORPLAN_BUCKET.get(`maps/${match[1]}/index.html`);
      if (!obj) return new Response("Artifact Not Found", { status: 404 });
      return new Response(obj.body, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // Optional Bearer Auth Guard
    const expectedToken = env.PORTAL_AUTH_TOKEN;
    if (expectedToken) {
      const auth = request.headers.get("authorization") || "";
      const apiKey = request.headers.get("x-api-key") || "";
      if (auth !== `Bearer ${expectedToken}` && apiKey !== expectedToken) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: corsHeaders
        });
      }
    }

    if (request.method === "GET") {
      return new Response(
        JSON.stringify(
          {
            status: "active",
            service: SERVER_NAME,
            version: SERVER_VERSION,
            protocol: `Model Context Protocol (MCP) JSON-RPC ${PROTOCOL_VERSION}`,
            available_tools: TOOLS.map((t) => t.name)
          },
          null,
          2
        ),
        { status: 200, headers: corsHeaders }
      );
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
        status: 405,
        headers: corsHeaders
      });
    }

    let body;
    try {
      body = await request.json();
    } catch (parseErr) {
      return new Response(JSON.stringify(jsonRpcError(null, -32700, "Parse error", parseErr.message)), {
        status: 400,
        headers: corsHeaders
      });
    }

    if (Array.isArray(body)) {
      const responses = await Promise.all(body.map((req) => processRpcRequest(req, env, request.url)));
      return new Response(JSON.stringify(responses), { status: 200, headers: corsHeaders });
    }

    const result = await processRpcRequest(body, env, request.url);
    return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
  }
};
