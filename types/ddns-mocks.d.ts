/**
 * Build-time type stub for the optional peer package @aiti-ai/ddns-mocks.
 *
 * src/cli.ts lazily `import()`s the mocks package (`ddns mock` command); tsc
 * needs the specifier to resolve at build time, but the real package must NOT
 * be a build dependency (it is published separately, and its own build needs
 * this package's dist first — a circular order we must not create).
 *
 * tsconfig.build.json maps the module name here, so the main build never
 * touches mocks/dist. The stub is intentionally minimal: cli.ts annotates the
 * imported value with explicit local types; the real package's richer API is
 * consumed by tests at runtime (node resolves the real package, not this).
 */
declare module "@aiti-ai/ddns-mocks" {
  export function startMockProvider(
    name: string,
    opts?: Record<string, unknown>,
  ): Promise<{ url: string }>;
  export function startTlsProxy(
    url: string,
  ): Promise<{ tlsUrl: string; proxyUrl: string; caPath: string }>;
  export const MOCK_HOSTS: Record<string, string>;
  export const caCertPath: string;
}
