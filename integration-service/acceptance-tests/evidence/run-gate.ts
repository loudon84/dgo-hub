import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateReleaseGate } from '../../contracts/evidence.js';

export async function runGateCli(argv: string[]): Promise<{ result: { status: 'PASS' | 'FAIL' | 'BLOCKED'; product_ready: boolean; issues: string[] }; exitCode: number }> {
  if (argv.length !== 2 || argv[0] !== '--run-dir' || !argv[1]) {
    return { result: { status: 'FAIL', product_ready: false, issues: ['usage: --run-dir <path>'] }, exitCode: 1 };
  }
  const result = await evaluateReleaseGate(argv[1]);
  return { result, exitCode: result.status === 'PASS' ? 0 : result.status === 'BLOCKED' ? 2 : 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { result, exitCode } = await runGateCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}
