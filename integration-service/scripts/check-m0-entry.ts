import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { environmentInputSchema } from '../contracts/environment.js';
import { evaluateM0Entry, signoffRecordSchema } from '../contracts/signoff.js';

type Options = {
  signoffs?: string;
  environment?: string;
  expectedKind?: 'local_lab' | 'site';
  validateExample: boolean;
};

function parseArgs(argv: string[]): Options | undefined {
  const options: Options = { validateExample: false };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--validate-example') {
      if (seen.has(arg)) return undefined;
      seen.add(arg);
      options.validateExample = true;
      continue;
    }
    if (arg !== '--signoffs' && arg !== '--environment' && arg !== '--expected-kind') return undefined;
    if (seen.has(arg)) return undefined;
    seen.add(arg);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) return undefined;
    index += 1;
    if (arg === '--signoffs') options.signoffs = value;
    if (arg === '--environment') options.environment = value;
    if (arg === '--expected-kind') {
      if (value !== 'local_lab' && value !== 'site') return undefined;
      options.expectedKind = value;
    }
  }
  return options.signoffs && options.environment && options.expectedKind ? options : undefined;
}

function jsonResult(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
}

export async function runCheckM0Entry(argv: string[]): Promise<{ exitCode: number; output: string }> {
  const options = parseArgs(argv);
  if (!options) {
    return {
      exitCode: 1,
      output: jsonResult({ error: 'usage', message: 'Required: --signoffs <file> --environment <file> --expected-kind <local_lab|site>; optional: --validate-example', product_ready: false }),
    };
  }

  let signoffs: unknown;
  let environment: unknown;
  try {
    signoffs = readJson(options.signoffs!);
    environment = readJson(options.environment!);
  } catch (error) {
    const code = error instanceof SyntaxError ? 'malformed_input' : 'unreadable_input';
    return { exitCode: 1, output: jsonResult({ error: code, message: 'Input files must be readable JSON documents', product_ready: false }) };
  }

  const signoffValidation = signoffRecordSchema.safeParse(signoffs);
  const environmentValidation = environmentInputSchema.safeParse(environment);
  if (!signoffValidation.success || !environmentValidation.success) {
    return {
      exitCode: 1,
      output: jsonResult({ error: 'schema_validation', message: 'Input does not match the alpha1.v1 contract', product_ready: false }),
    };
  }

  if (options.validateExample) {
    return {
      exitCode: 0,
      output: jsonResult({
        status: 'BLOCKED',
        missing: ['example:syntax_only'],
        example: signoffValidation.data.example || environmentValidation.data.example,
        product_ready: false,
        scope: 'entry-input-validation',
      }),
    };
  }

  const result = evaluateM0Entry(signoffs, environment, { expectedKind: options.expectedKind!, allowExample: false });
  return {
    exitCode: result.status === 'PASS' ? 0 : 2,
    output: jsonResult({ ...result, product_ready: result.status === 'PASS', scope: 'entry-input-validation' }),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const result = await runCheckM0Entry(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}
