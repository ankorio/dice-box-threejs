// Resolve Vite-style extensionless relative imports for raw Node ESM (test only).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[mc]?js$/.test(specifier)) {
    try {
      const url = new URL(specifier + '.js', context.parentURL);
      if (existsSync(fileURLToPath(url))) return next(specifier + '.js', context);
    } catch {}
  }
  return next(specifier, context);
}
