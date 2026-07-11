import { useEffect, useState } from "react";

import { useAuth } from "../../context/auth";
import type { Team } from "../../api/types";

export interface SelfProfile {
  displayName?: string;
  team?: Team;
}

/**
 * The signed-in user's own profile (display name + team affiliation) from
 * `GET /api/v1/users/me`, so the identity chip renders a person · team like the
 * design reference rather than a raw JWT label. Reuses the same self-profile
 * read the scope switcher already issues (`authz.ts`), so the response is
 * warm-cached and adds no user-visible latency.
 *
 * Fails soft: an unresolved or denied read leaves the chip on its JWT-claim
 * fallback, never a spinner or an error surface.
 */
export function useSelfProfile(): SelfProfile {
  const { api, session } = useAuth();
  const [profile, setProfile] = useState<SelfProfile>({});

  useEffect(() => {
    let cancelled = false;
    api
      .GET("/api/v1/users/me")
      .then((res) => {
        if (cancelled) return;
        const me = res.data;
        if (me) {
          setProfile({ displayName: me.display_name, team: me.team });
        }
      })
      .catch(() => {
        /* identity read failed — keep the JWT-claim fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [api, session?.access_token]);

  return profile;
}
