// The live deployment's build id. A long-open tab polls this and compares it
// with the constant baked into its own bundle at build time (see next.config's
// `env`): a mismatch means that tab is running code the server has already
// replaced. Public on purpose — the middleware only gates /doc — and never
// cached, since a cached answer would always agree with the caller and the
// poll would never fire.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { version: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev" },
    { headers: { "cache-control": "no-store" } },
  );
}
