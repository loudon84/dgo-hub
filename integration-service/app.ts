import Fastify from 'fastify';
import { registerRoutes } from './ingestion-api/routes.js';
const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
await registerRoutes(app);
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
