import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AuthError } from '../auth/errors.js';
import type { AgentPrincipal, AuthService } from '../auth/types.js';
import { createHubLoggerOptions } from '../ingestion-api/logging.js';
import { readHubRuntimeConfiguration, type HubRuntimeConfiguration } from '../contracts/runtime-config.js';
import { runSalesTool, type SalesToolName } from './queries.js';
import { toolDefinitions } from './tools.js';
import { registerLegacyMcpRoute, type LegacyMcpConfiguration } from './legacy.js';

export type QueryGateSnapshot = Readonly<{ state: string; epoch: string }>;
export type AlphaReadinessSnapshot = Readonly<{
  ready: boolean;
  reason: string;
  bindingVersion: string | null;
  policyVersion: string | null;
}>;
export type AlphaReadinessResolver = (input: Readonly<{ principal: AgentPrincipal; gate: QueryGateSnapshot }>) => Promise<AlphaReadinessSnapshot>;
export type SalesQueryExecutor = (input: Readonly<{
  principal: AgentPrincipal; name: SalesToolName; variables: Record<string, unknown>;
}>) => Promise<Record<string, unknown>>;
export type McpServerOptions = Readonly<{
  authService: Pick<AuthService, 'authenticateAgent' | 'assertCurrentAgent'>;
  pool: Pick<Pool, 'query'>;
  queryExecutor: SalesQueryExecutor;
  readinessResolver?: AlphaReadinessResolver;
  allowedOrigins?: readonly string[];
  logger?: FastifyServerOptions['logger'];
  runtime?: HubRuntimeConfiguration;
  legacyMcp?: LegacyMcpConfiguration;
}>;

type AuditOutcome = 'success' | 'denied' | 'error';
type AuditStage = 'audit_checkpoint' | 'return_check';
type GateRow = { state: string; epoch: string };
type ToolError = Readonly<{ code: string; message: string; request_id: string }>;
class BoundaryError extends Error { constructor(readonly code: string) { super(code); } }

const defaultNotReady: AlphaReadinessResolver = async () => ({
  ready: false, reason: 'ALPHA_POLICY_NOT_READY', bindingVersion: null, policyVersion: null,
});

function safeError(error: unknown, requestId: string): ToolError {
  if (error instanceof AuthError) return { code: error.code, message: error.code, request_id: requestId };
  if (error instanceof BoundaryError) return { code: error.code, message: error.code, request_id: requestId };
  if (error instanceof Error && error.message === 'TOOL_INPUT_INVALID') return { code: 'TOOL_INPUT_INVALID', message: 'TOOL_INPUT_INVALID', request_id: requestId };
  return { code: 'QUERY_FAILED', message: 'QUERY_FAILED', request_id: requestId };
}
function toolErrorResult(code: string, requestId: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message: code, request_id: requestId }) }] };
}
function safeArgsDigest(value: unknown): Buffer { return createHash('sha256').update(JSON.stringify(value)).digest(); }
function resultCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    const counts = Object.values(value).filter(Array.isArray).map(rows => rows.length);
    return counts.length ? counts.reduce((sum, count) => sum + count, 0) : 1;
  }
  return 0;
}
async function readGate(pool: Pick<Pool, 'query'>): Promise<QueryGateSnapshot> {
  try {
    const result = await pool.query<GateRow>('SELECT state, epoch::text AS epoch FROM control.query_gate WHERE id=1');
    const gate = result.rows[0];
    if (!gate || !/^(0|[1-9][0-9]*)$/.test(gate.epoch)) throw new BoundaryError('QUERY_NOT_READY');
    return { state: gate.state, epoch: gate.epoch };
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    throw new BoundaryError('QUERY_NOT_READY');
  }
}
async function captureBoundary(
  pool: Pick<Pool, 'query'>,
  authService: Pick<AuthService, 'assertCurrentAgent'>,
  readinessResolver: AlphaReadinessResolver,
  principal: AgentPrincipal,
): Promise<{ gate: QueryGateSnapshot; readiness: AlphaReadinessSnapshot }> {
  await authService.assertCurrentAgent(principal);
  const gate = await readGate(pool);
  const readiness = await readinessResolver({ principal, gate });
  return { gate, readiness };
}
function requireReadyBoundary(boundary: { gate: QueryGateSnapshot; readiness: AlphaReadinessSnapshot }): void {
  if (boundary.gate.state !== 'open') throw new BoundaryError('QUERY_NOT_READY');
  if (!boundary.readiness.ready) throw new BoundaryError(boundary.readiness.reason || 'QUERY_NOT_READY');
}
function requireUnchangedBoundary(
  boundary: { gate: QueryGateSnapshot; readiness: AlphaReadinessSnapshot },
  start: { gate: QueryGateSnapshot; readiness: AlphaReadinessSnapshot },
): void {
  if (boundary.gate.state !== start.gate.state || boundary.gate.epoch !== start.gate.epoch ||
      boundary.readiness.bindingVersion !== start.readiness.bindingVersion || boundary.readiness.policyVersion !== start.readiness.policyVersion) {
    throw new BoundaryError('AUTH_CONTEXT_CHANGED');
  }
}
async function persistAudit(pool: Pick<Pool, 'query'>, row: {
  requestId: string; principal: AgentPrincipal; name: string; outcome: AuditOutcome; errorCode: string | null;
  durationMs: number; resultCount: number | null; argsDigest: Buffer; gateEpoch: string | null;
  protocolVersion: string | null; bindingVersion: string | null; policyVersion: string | null; stage: AuditStage;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO control.agent_audit
        (tenant_id,user_id,tool_name,outcome,error_code,duration_ms,request_id,credential_id,auth_epoch,gate_epoch,
         result_count,args_digest,protocol_version,binding_version,policy_version,stage)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [row.principal.tenantId,row.principal.userId,row.name,row.outcome,row.errorCode,row.durationMs,row.requestId,
        row.principal.credentialId,row.principal.authEpoch,row.gateEpoch,row.resultCount,row.argsDigest,row.protocolVersion,
        row.bindingVersion,row.policyVersion,row.stage],
    );
  } catch { throw new BoundaryError('AUDIT_UNAVAILABLE'); }
}

function buildMcpServer(options: {
  principal: AgentPrincipal; pool: Pick<Pool, 'query'>; authService: Pick<AuthService, 'assertCurrentAgent'>;
  queryExecutor: SalesQueryExecutor; readinessResolver: AlphaReadinessResolver; requestId: string; protocolVersion: string | null;
}) {
  const server = new McpServer({ name: 'sales-data-mcp', version: '1.0.0' });
  const handlers = new Map<string, (rawArgs: unknown) => Promise<CallToolResult>>();
  for (const definition of toolDefinitions) {
    const name = definition.name as SalesToolName;
    const execute = async (rawArgs: unknown): Promise<CallToolResult> => {
      const startedAt = Date.now();
      const args = rawArgs as Record<string, unknown>;
      const digest = safeArgsDigest(args);
      let data: unknown;
      let caught: unknown;
      let startBoundary: { gate: QueryGateSnapshot; readiness: AlphaReadinessSnapshot } | undefined;
      try {
        startBoundary = await captureBoundary(options.pool, options.authService, options.readinessResolver, options.principal);
        requireReadyBoundary(startBoundary);
        data = await runSalesTool(options.principal, name, args, options.queryExecutor);
        const afterQuery = await captureBoundary(options.pool, options.authService, options.readinessResolver, options.principal);
        requireUnchangedBoundary(afterQuery, startBoundary);
        requireReadyBoundary(afterQuery);
      } catch (error) { caught = error; }
      const failure = caught === undefined ? null : safeError(caught, options.requestId);
      caught = undefined;
      const auditRow = {
        requestId: options.requestId, principal: options.principal, name,
        outcome: failure ? (failure.code.includes('NOT_READY') || failure.code.startsWith('AUTH_') ? 'denied' as const : 'error' as const) : 'success' as const,
        errorCode: failure?.code ?? null,
        durationMs: Math.max(0, Math.min(2_147_483_647, Date.now() - startedAt)),
        resultCount: failure ? null : resultCount(data), argsDigest: digest,
        gateEpoch: startBoundary?.gate.epoch ?? null, protocolVersion: options.protocolVersion,
        bindingVersion: startBoundary?.readiness.bindingVersion ?? null, policyVersion: startBoundary?.readiness.policyVersion ?? null,
        stage: 'audit_checkpoint' as const,
      };
      try {
        await persistAudit(options.pool, auditRow);
      } catch {
        return toolErrorResult('AUDIT_UNAVAILABLE', options.requestId);
      }
      // Recheck after durable audit so changes during the write discard all query data.
      try {
        const afterAudit = await captureBoundary(options.pool, options.authService, options.readinessResolver, options.principal);
        if (startBoundary) requireUnchangedBoundary(afterAudit, startBoundary);
        if (!failure) requireReadyBoundary(afterAudit);
      } catch (error) { caught = error; }
      if (caught !== undefined) {
        const error = safeError(caught, options.requestId);
        const outcome = error.code.includes('NOT_READY') || error.code.startsWith('AUTH_') ? 'denied' : 'error';
        try { await persistAudit(options.pool, { ...auditRow, stage: 'return_check', outcome, errorCode: error.code, resultCount: null }); }
        catch { return toolErrorResult('AUDIT_UNAVAILABLE', options.requestId); }
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
      }
      if (failure) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(failure) }] };
      const structuredContent = { data };
      return { structuredContent, content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }] };
    };
    handlers.set(name, execute);
    server.registerTool(name, { description: definition.description, inputSchema: definition.inputSchema, annotations: { readOnlyHint: true } }, execute);
  }
  // Preserve the SDK-advertised schemas while validating arguments inside the audited application boundary.
  server.server.setRequestHandler(CallToolRequestSchema, async request => {
    const handler = handlers.get(request.params.name);
    if (!handler) return toolErrorResult('TOOL_NOT_FOUND', options.requestId);
    return handler(request.params.arguments ?? {});
  });
  return server;
}

function authStatus(error: unknown): { status: number; code: string } {
  if (error instanceof AuthError) return { status: error.status, code: error.code };
  return { status: 503, code: 'AUTH_UNAVAILABLE' };
}

export function createMcpApp(options: McpServerOptions): FastifyInstance {
  const origins = options.allowedOrigins ?? [];
  const app = Fastify({ logger: options.logger ?? createHubLoggerOptions(), requestIdHeader: false, genReqId: () => randomUUID(), bodyLimit: 1024 * 1024 });
  const authenticatedPrincipals = new WeakMap<object, AgentPrincipal>();
  if (options.runtime?.environmentKind === 'local_lab' && options.runtime.legacyLabEnabled) {
    if (!options.legacyMcp) throw new Error('MCP_CONFIG_INVALID');
    registerLegacyMcpRoute(app, options.pool, options.legacyMcp);
  }
  app.addHook('onRequest', async (request, reply) => {
    if ((request.raw.url ?? '').split('?', 1)[0] !== '/mcp/sales') return;
    const origin = request.headers.origin;
    if (origin !== undefined && (typeof origin !== 'string' || !origins.includes(origin))) {
      return reply.code(403).send({ request_id: request.id, error: { code: 'ORIGIN_FORBIDDEN', message: 'ORIGIN_FORBIDDEN' } });
    }
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header) : null;
    if (!match) return reply.code(401).send({ request_id: request.id, error: { code: 'AUTH_INVALID', message: 'AUTH_INVALID' } });
    try { authenticatedPrincipals.set(request, await options.authService.authenticateAgent(match[1])); }
    catch (error) {
      const safe = authStatus(error);
      return reply.code(safe.status).send({ request_id: request.id, error: { code: safe.code, message: safe.code } });
    }
  });
  app.all('/mcp/sales', async (request, reply) => {
    const principal = authenticatedPrincipals.get(request);
    if (!principal) return reply.code(401).send({ request_id: request.id, error: { code: 'AUTH_INVALID', message: 'AUTH_INVALID' } });
    const rawVersion = request.headers['mcp-protocol-version'];
    const protocolVersion = typeof rawVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawVersion) ? rawVersion : null;
    const server = buildMcpServer({
      principal, pool: options.pool, authService: options.authService, queryExecutor: options.queryExecutor,
      readinessResolver: options.readinessResolver ?? defaultNotReady, requestId: request.id, protocolVersion,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    reply.hijack();
    request.raw.on('close', () => { void server.close(); });
    try { await transport.handleRequest(request.raw, reply.raw, request.body); }
    catch {
      if (!reply.raw.headersSent) reply.raw.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ request_id: request.id, error: { code: 'MCP_PROTOCOL_ERROR', message: 'MCP_PROTOCOL_ERROR' } }));
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 ? statusCode : 400;
    if (authenticatedPrincipals.has(request)) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const parseError = code === 'FST_ERR_CTP_INVALID_JSON_BODY';
      return reply.code(status).send({
        jsonrpc: '2.0', id: null, request_id: request.id,
        error: { code: parseError ? -32700 : -32600, message: parseError ? 'Parse error' : 'Invalid request' },
      });
    }
    void reply.code(status).send({ request_id: request.id, error: { code: 'MCP_PROTOCOL_ERROR', message: 'MCP_PROTOCOL_ERROR' } });
  });
  return app;
}

export function readMcpRuntimeConfiguration(environment: NodeJS.ProcessEnv = process.env): HubRuntimeConfiguration {
  return readHubRuntimeConfiguration(environment);
}
export async function startMcp(environment: NodeJS.ProcessEnv = process.env): Promise<FastifyInstance> {
  const runtime = readMcpRuntimeConfiguration(environment);
  if (!environment.DATABASE_URL) throw new Error('RUNTIME_CONFIG_INVALID');
  const port = environment.MCP_PORT === undefined ? 3001 : Number(environment.MCP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RUNTIME_CONFIG_INVALID');
  const { createHasuraQueryExecutor, readHasuraConfiguration } = await import('./queries.js');
  const configuration = readHasuraConfiguration(environment);
  let legacyMcp: LegacyMcpConfiguration | undefined;
  if (runtime.legacyLabEnabled) {
    const agentJwtSecret = environment.AGENT_JWT_SECRET;
    if (!agentJwtSecret) throw new Error('MCP_CONFIG_INVALID');
    legacyMcp = {
      agentJwtSecret,
      issuer: environment.AGENT_JWT_ISSUER ?? 'data-hub',
      audience: environment.AGENT_JWT_AUDIENCE ?? 'sales-mcp',
      hasura: configuration,
    };
  }
  const [{ pool }, { createAuthService }] = await Promise.all([import('../db.js'), import('../auth/service.js')]);
  const authService = createAuthService({ pool });
  const app = createMcpApp({ authService, pool, queryExecutor: createHasuraQueryExecutor(configuration), allowedOrigins: runtime.mcpAllowedOrigins, runtime, legacyMcp });
  await app.listen({ host: '0.0.0.0', port });
  return app;
}
