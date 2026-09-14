import { redirect } from "next/navigation";

import { DEFAULT_SIGNED_IN_PATH } from "@/lib/auth/redirect";
import { getSessionUser } from "@/lib/auth/session";

export default async function HomePage() {
  redirect((await getSessionUser()) ? DEFAULT_SIGNED_IN_PATH : "/sign-in");
}
