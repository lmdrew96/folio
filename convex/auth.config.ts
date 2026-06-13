/**
 * Validates Clerk-issued access tokens on the Convex backend.
 *
 * `CLERK_JWT_ISSUER_DOMAIN` must be set on the Convex dashboard (not in .env.local).
 * It's the "Issuer" URL of the Clerk JWT template named "convex".
 * See: https://docs.convex.dev/auth/clerk
 */
const authConfig = {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
      applicationID: "convex",
    },
  ],
};

export default authConfig;
