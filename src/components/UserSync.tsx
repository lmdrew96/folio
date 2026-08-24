"use client";

import { useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { useConvexAuth, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";

/**
 * Keeps Convex's `users` table in sync with Clerk on every sign-in — mirrors
 * Cha(t)os's UserSync.tsx. Exists so Folio's invite-by-email flow (see
 * ShareDialog/documents.invite) has a real, verified email/displayName to
 * resolve against, independent of what Clerk's "convex" JWT template happens
 * to carry. Mounted once at the app root so it fires on every entry point,
 * including a collaborator arriving straight at /doc/[id] from a shared link.
 */
export function UserSync() {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useUser();
  const upsertUser = useMutation(api.users.upsertUser);

  useEffect(() => {
    if (!isAuthenticated || !user) return;
    const email = user.primaryEmailAddress?.emailAddress;
    if (!email) return;
    upsertUser({
      email,
      displayName: user.fullName ?? user.firstName ?? email,
    });
  }, [isAuthenticated, user, upsertUser]);

  return null;
}
