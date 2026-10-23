import { startMcp } from './server.js';
startMcp(Number(process.env.MCP_PORT ?? 3001));
