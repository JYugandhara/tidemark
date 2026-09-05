/**
 * The page is a thin server component around a client shell.
 *
 * Session identity is established by `GET /api/session`, which has to be able
 * to *set* a cookie — something a server component cannot do. Rather than
 * split the bootstrap across a middleware that would then need database access
 * on the edge runtime, the client asks for a session first and everything else
 * follows from that one round trip.
 */

import { App } from "@/components/App";

export const dynamic = "force-dynamic";

export default function Page() {
  return <App />;
}
