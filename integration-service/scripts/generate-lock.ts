import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateDeploymentLock } from '../contracts/deployment-lock.js';

type Options = { observations?: string; pins?: string; output?: string; release: boolean };

function parseArgs(argv: string[]): Options | undefined {
  const options: Options = { release: false };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--release') {
      if (seen.has(arg)) return undefined;
      seen.add(arg);
      options.release = true;
      continue;
    }
    if (arg !== '--observations' && arg !== '--pins' && arg !== '--output') return undefined;
    if (seen.has(arg)) return undefined;
    seen.add(arg);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) return undefined;
    index += 1;
    if (arg === '--observations') options.observations = value;
    if (arg === '--pins') options.pins = value;
    if (arg === '--output') options.output = value;
  }
  return options.observations && options.pins ? options : undefined;
}

function jsonResult(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
}

export async function runGenerateLock(argv: string[]): Promise<{ exitCode: number; output: string }> {
  const options = parseArgs(argv);
  if (!options) {
    return {
      exitCode: 1,
      output: jsonResult({
        error: 'usage',
        message: 'Required: --observations <file> --pins <file>; optional: --output <file> --release',
        product_ready: false,
      }),
    };
  }

  let observations: unknown;
  let pins: unknown;
  try {
    observations = readJson(options.observations!);
    pins = readJson(options.pins!);
  } catch (error) {
    const code = error instanceof SyntaxError ? 'malformed_input' : 'unreadable_input';
    return {
      exitCode: 1,
      output: jsonResult({ error: code, message: 'Observation and pins files must be readable JSON documents', product_ready: false }),
    };
  }

  const result = validateDeploymentLock(observations, pins, { release: options.release });
  const productReady = false;
  if (result.status === 'PASS' && options.output) {
    try {
      writeFileSync(resolve(options.output), `${JSON.stringify(observations, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
    } catch {
      return {
        exitCode: 1,
        output: jsonResult({
          error: 'output_write',
          message: 'Validated lock could not be written to the requested output file',
          product_ready: false,
        }),
      };
    }
  }
  return {
    exitCode: result.status === 'PASS' ? 0 : 2,
    output: jsonResult({ ...result, product_ready: productReady, scope: 'deployment-lock-validation' }),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const result = await runGenerateLock(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}
