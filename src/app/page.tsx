import { redirect } from "next/navigation";

/** The studio has no public marketing surface; entry is always the dashboard. */
export default function RootPage() {
  redirect("/dashboard");
}
